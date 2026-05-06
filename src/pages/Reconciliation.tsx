import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { formatMoney } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';

interface BankTxn {
  id: string;
  posted_at: string;
  description: string;
  amount_cents: number;
  reference: string | null;
  matched_bill_id: string | null;
  matched_invoice_id: string | null;
  bank_account_id: string;
}

interface BillMatchCandidate {
  kind: 'bill';
  bill_id: string;
  bill_date: string;
  bill_amount_cents: number;
  bill_invoice_number: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  amount_diff_cents: number;
  days_diff: number;
  score: number;
}

interface InvoiceMatchCandidate {
  kind: 'invoice';
  invoice_id: string;
  invoice_number: string;
  invoice_date: string;
  invoice_balance_due_cents: number;
  customer_id: string | null;
  customer_name: string | null;
  amount_diff_cents: number;
  days_diff: number;
  score: number;
}

type MatchCandidate = BillMatchCandidate | InvoiceMatchCandidate;

interface RowVm {
  txn: BankTxn;
  candidates: MatchCandidate[];
}

export function ReconciliationPage() {
  const { currentOrg } = useOrg();
  const [rows, setRows] = useState<RowVm[]>([]);
  const [matched, setMatched] = useState<BankTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);

    const [txnRes, matchedRes, billCandRes, invoiceCandRes] = await Promise.all([
      supabase
        .from('bank_transactions')
        .select('id, posted_at, description, amount_cents, reference, matched_bill_id, matched_invoice_id, bank_account_id')
        .eq('organization_id', currentOrg.id)
        .is('matched_bill_id', null)
        .is('matched_invoice_id', null)
        .order('posted_at', { ascending: false })
        .limit(200),
      supabase
        .from('bank_transactions')
        .select('id, posted_at, description, amount_cents, reference, matched_bill_id, matched_invoice_id, bank_account_id')
        .eq('organization_id', currentOrg.id)
        .or('matched_bill_id.not.is.null,matched_invoice_id.not.is.null')
        .order('posted_at', { ascending: false })
        .limit(20),
      supabase
        .from('v_bank_match_candidates')
        .select('*')
        .eq('organization_id', currentOrg.id)
        .gte('score', 0.5)
        .order('score', { ascending: false }),
      supabase
        .from('v_bank_invoice_match_candidates')
        .select('*')
        .eq('organization_id', currentOrg.id)
        .gte('score', 0.5)
        .order('score', { ascending: false }),
    ]);

    if (txnRes.error) { setError(txnRes.error.message); setLoading(false); return; }
    if (billCandRes.error) { setError(billCandRes.error.message); setLoading(false); return; }

    const candidatesByTxn = new Map<string, MatchCandidate[]>();
    for (const c of (billCandRes.data ?? []) as Array<BillMatchCandidate & { bank_transaction_id: string }>) {
      const list = candidatesByTxn.get(c.bank_transaction_id) ?? [];
      list.push({ ...c, kind: 'bill' });
      candidatesByTxn.set(c.bank_transaction_id, list);
    }
    for (const c of (invoiceCandRes.data ?? []) as Array<InvoiceMatchCandidate & { bank_transaction_id: string }>) {
      const list = candidatesByTxn.get(c.bank_transaction_id) ?? [];
      list.push({ ...c, kind: 'invoice' });
      candidatesByTxn.set(c.bank_transaction_id, list);
    }
    // Sort each txn's candidates by score desc
    for (const list of candidatesByTxn.values()) {
      list.sort((a, b) => b.score - a.score);
    }

    const vms: RowVm[] = ((txnRes.data ?? []) as BankTxn[]).map((t) => ({
      txn: t,
      candidates: (candidatesByTxn.get(t.id) ?? []).slice(0, 3),
    }));

    setRows(vms);
    setMatched((matchedRes.data ?? []) as BankTxn[]);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  const matchToBill = async (txnId: string, billId: string) => {
    setBusyId(txnId);
    try {
      // Atomic RPC — both updates in one tx so a connection drop can't
      // leave the bank txn matched but the bill still 'attached'.
      const { data, error: rpcErr } = await supabase.rpc('reconcile_match_bill', {
        p_bank_transaction_id: txnId,
        p_bill_id: billId,
        p_match_confidence: 1.0,
      });
      if (rpcErr) throw rpcErr;
      const result = data as { ok: boolean; error?: string } | null;
      if (result && !result.ok) throw new Error(result.error ?? 'reconcile_match_bill failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
      void refresh();
    }
  };

  const matchToInvoice = async (txnId: string, invoiceId: string, amountCents: number) => {
    setBusyId(txnId);
    try {
      const { data, error: rpcErr } = await supabase.rpc('reconcile_match_invoice', {
        p_bank_transaction_id: txnId,
        p_invoice_id: invoiceId,
        p_amount_cents: amountCents,
        p_match_confidence: 1.0,
      });
      if (rpcErr) throw rpcErr;
      const result = data as { ok: boolean; error?: string } | null;
      if (result && !result.ok) throw new Error(result.error ?? 'reconcile_match_invoice failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
      void refresh();
    }
  };

  const undoMatch = async (txnId: string, _billId: string | null, _invoiceId: string | null) => {
    if (!confirm('Undo this match?')) return;
    setBusyId(txnId);
    try {
      const { data, error: rpcErr } = await supabase.rpc('reconcile_undo_match', {
        p_bank_transaction_id: txnId,
      });
      if (rpcErr) throw rpcErr;
      const result = data as { ok: boolean; error?: string } | null;
      if (result && !result.ok) throw new Error(result.error ?? 'reconcile_undo_match failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
      void refresh();
    }
  };

  const withSugg = rows.filter((r) => r.candidates.length > 0);

  const matchTopCandidate = async (txnId: string, txnAmount: number, candidate: MatchCandidate) => {
    if (candidate.kind === 'bill') {
      await matchToBill(txnId, candidate.bill_id);
    } else {
      await matchToInvoice(txnId, candidate.invoice_id, txnAmount);
    }
  };

  const bulkApplyHigh = async () => {
    const high = rows.filter((r) => r.candidates[0] && r.candidates[0].score >= 0.9);
    if (high.length === 0) return;
    if (!confirm(`Auto-match ${high.length} high-confidence transactions? You can undo individually.`)) return;
    for (const r of high) {
      await matchTopCandidate(r.txn.id, r.txn.amount_cents, r.candidates[0]);
    }
  };

  return (
    <section>
      <h1 style={{ marginBottom: 4 }}>Reconciliation</h1>
      <p style={{ color: '#888', fontSize: 13 }}>
        Match bank transactions to bills (money out) and invoices (money in).
        Bills flip to <code>paid</code>; invoices auto-record an <code>invoice_payment</code> and the trigger flips status.
      </p>

      {loading ? (
        <SkeletonTable rows={8} cols={5} />
      ) : error ? (
        <p style={{ color: 'salmon' }}>{error}</p>
      ) : (
        <>
          {withSugg.length > 0 && (
            <div style={{ marginTop: 12, padding: 12, background: '#0d2f1f', border: '1px solid #1c5135', borderRadius: 6 }}>
              <strong style={{ color: '#86c7a3' }}>
                {withSugg.length} unmatched txn{withSugg.length === 1 ? '' : 's'} have candidate matches.
              </strong>
              {' '}
              {rows.some((r) => r.candidates[0]?.score >= 0.9) && (
                <button onClick={() => void bulkApplyHigh()} style={primaryBtn}>
                  ✓ Auto-match high-confidence
                </button>
              )}
            </div>
          )}

          <h2 style={h2}>Unmatched transactions ({rows.length})</h2>
          {rows.length === 0 ? (
            <p style={{ color: '#888', fontSize: 13 }}>Inbox zero. Every transaction is reconciled.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rows.map((r) => (
                <TxnRow key={r.txn.id} row={r} busy={busyId === r.txn.id} onMatch={matchTopCandidate} />
              ))}
            </div>
          )}

          {matched.length > 0 && (
            <>
              <h2 style={h2}>Recently matched (last 20)</h2>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                      <th style={th}>Date</th>
                      <th style={th}>Description</th>
                      <th style={thRight}>Amount</th>
                      <th style={th}>Matched to</th>
                      <th style={thRight}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {matched.map((m) => (
                      <tr key={m.id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                        <td style={td}>{m.posted_at.slice(0, 10)}</td>
                        <td style={td}>{m.description}</td>
                        <td style={tdRight}>{formatMoney(m.amount_cents)}</td>
                        <td style={td}>
                          {m.matched_bill_id && (
                            <Link to={`/bills/${m.matched_bill_id}`} style={{ color: '#86c7a3', fontSize: 12 }}>
                              bill →
                            </Link>
                          )}
                          {m.matched_invoice_id && (
                            <Link to={`/invoices/${m.matched_invoice_id}`} style={{ color: '#86c7a3', fontSize: 12 }}>
                              invoice →
                            </Link>
                          )}
                        </td>
                        <td style={tdRight}>
                          <button onClick={() => void undoMatch(m.id, m.matched_bill_id, m.matched_invoice_id)} disabled={busyId === m.id} style={ghostBtn}>
                            undo
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <p style={{ marginTop: 32, padding: 10, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, fontSize: 12, color: '#666' }}>
            Future: invoice matches (after P4), auto-categorisation rules, partial-match handling, multi-bill splits, attachable receipt photos.
          </p>
        </>
      )}
    </section>
  );
}

function TxnRow({ row, busy, onMatch }: { row: RowVm; busy: boolean; onMatch: (txnId: string, txnAmount: number, c: MatchCandidate) => void }) {
  const { txn, candidates } = row;
  const top = candidates[0];

  return (
    <div style={{ padding: 12, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6, display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'center' }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{txn.description}</div>
        <div style={{ fontSize: 12, color: '#888', marginTop: 3 }}>
          {txn.posted_at.slice(0, 10)}{' · '}
          <span style={{ color: txn.amount_cents < 0 ? '#e9a3a3' : '#86c7a3' }}>{formatMoney(txn.amount_cents)}</span>
          {txn.reference && <> · ref <code style={{ color: '#666' }}>{txn.reference}</code></>}
        </div>
      </div>
      <div style={{ minWidth: 360 }}>
        {candidates.length === 0 ? (
          <div style={{ fontSize: 12, color: '#666', textAlign: 'right' }}>
            No matching bill or invoice found
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {candidates.map((c, i) => (
              <div key={`${c.kind}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                {c.kind === 'bill' ? (
                  <Link to={`/bills/${c.bill_id}`} style={{ fontSize: 12, color: '#aaa', textDecoration: 'none' }}>
                    <span style={kindPill('#5096d8')}>BILL</span>
                    {' '}{c.supplier_name ?? '(no supplier)'} · <code>{c.bill_invoice_number ?? '—'}</code> · {c.bill_date} · {formatMoney(c.bill_amount_cents)}
                  </Link>
                ) : (
                  <Link to={`/invoices/${c.invoice_id}`} style={{ fontSize: 12, color: '#aaa', textDecoration: 'none' }}>
                    <span style={kindPill('#86c7a3')}>INV</span>
                    {' '}{c.customer_name ?? '(no customer)'} · <code>{c.invoice_number}</code> · {c.invoice_date} · owing {formatMoney(c.invoice_balance_due_cents)}
                  </Link>
                )}
                <button
                  onClick={() => onMatch(txn.id, txn.amount_cents, c)}
                  disabled={busy}
                  style={{
                    padding: '0.3rem 0.6rem',
                    background: c.score >= 0.9 ? '#1c5135' : '#1c4868',
                    color: '#fff',
                    border: '1px solid ' + (c.score >= 0.9 ? '#2da565' : '#5096d8'),
                    borderRadius: 3, cursor: busy ? 'wait' : 'pointer', fontSize: 11,
                  }}
                >
                  match ({(c.score * 100).toFixed(0)}%)
                </button>
              </div>
            ))}
          </div>
        )}
        {top && top.score >= 0.95 && (
          <div style={{ marginTop: 4, fontSize: 10, color: '#86c7a3', textAlign: 'right' }}>
            ✓ Strong match — consider auto-applying
          </div>
        )}
      </div>
    </div>
  );
}

const kindPill = (colour: string): React.CSSProperties => ({
  display: 'inline-block',
  padding: '1px 5px',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 0.5,
  borderRadius: 2,
  background: '#222',
  color: colour,
  border: `1px solid ${colour}`,
  marginRight: 4,
});

const h2: React.CSSProperties = { fontSize: 14, marginTop: 24, marginBottom: 8 };
const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 };
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
const primaryBtn: React.CSSProperties = { marginLeft: 12, padding: '0.4rem 1rem', background: '#1c5135', color: '#fff', border: '1px solid #2da565', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600 };
const ghostBtn: React.CSSProperties = { padding: '0.2rem 0.5rem', background: 'transparent', color: '#888', border: '1px solid #333', borderRadius: 3, cursor: 'pointer', fontSize: 11 };
