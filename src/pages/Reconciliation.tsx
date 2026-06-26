import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';
import { AllocationSplitButton } from '@/components/AllocationSplitButton';
import { Scale, CheckCircle2, AlertCircle, ArrowUpRight, ArrowDownRight, RotateCcw } from 'lucide-react';

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
    for (const c of (billCandRes.data ?? []) as (BillMatchCandidate & { bank_transaction_id: string })[]) {
      const list = candidatesByTxn.get(c.bank_transaction_id) ?? [];
      list.push({ ...c, kind: 'bill' });
      candidatesByTxn.set(c.bank_transaction_id, list);
    }
    for (const c of (invoiceCandRes.data ?? []) as (InvoiceMatchCandidate & { bank_transaction_id: string })[]) {
      const list = candidatesByTxn.get(c.bank_transaction_id) ?? [];
      list.push({ ...c, kind: 'invoice' });
      candidatesByTxn.set(c.bank_transaction_id, list);
    }
    
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
      const { data, error: rpcErr } = await supabase.rpc('reconcile_match_bill', {
        p_bank_transaction_id: txnId,
        p_bill_id: billId,
        p_match_confidence: 1.0,
      });
      if (rpcErr) throw rpcErr;
      const result = data as { ok: boolean; error?: string } | null;
      if (result && !result.ok) throw new Error(result.error ?? 'reconcile_match_bill failed');

      if (currentOrg) {
        void (async () => {
          try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) return;
            const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/xero-push-bill`;
            await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
              body: JSON.stringify({ organization_id: currentOrg.id, bill_id: billId }),
            });
          } catch { /* ignored */ }
        })();
      }
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

  const undoMatch = async (txnId: string) => {
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
      const top = r.candidates[0];
      if (!top) continue;
      await matchTopCandidate(r.txn.id, r.txn.amount_cents, top);
    }
  };

  return (
    <section className="animated-fade-in">
      {/* Header title */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
          <Scale size={24} style={{ color: 'var(--accent-primary)' }} />
          Reconciliation
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', margin: 0 }}>
          Match bank transactions to bills (money out) and invoices (money in).
        </p>
      </div>

      {loading ? (
        <SkeletonTable rows={8} cols={5} />
      ) : error ? (
        <div className="badge badge-danger" style={{ display: 'block', padding: '0.75rem', marginBottom: '1rem', textTransform: 'none' }}>
          {error}
        </div>
      ) : (
        <>
          {/* Banner notification for candidate suggestions */}
          {withSugg.length > 0 && (
            <div 
              style={{ 
                marginTop: '1rem', 
                marginBottom: '1.5rem',
                padding: '1rem 1.25rem', 
                background: 'var(--bg-success-subtle)', 
                border: '1px solid rgba(16, 185, 129, 0.2)', 
                borderRadius: 'var(--radius-md)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '0.75rem'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-success)', fontSize: '0.875rem', fontWeight: 600 }}>
                <CheckCircle2 size={16} />
                <span>{withSugg.length} unmatched transaction{withSugg.length === 1 ? '' : 's'} have candidate matches.</span>
              </div>
              {rows.some((r) => (r.candidates[0]?.score ?? 0) >= 0.9) && (
                <button onClick={() => void bulkApplyHigh()} className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}>
                  ✓ Auto-match high-confidence
                </button>
              )}
            </div>
          )}

          <h2 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>Unmatched transactions ({rows.length})</h2>
          {rows.length === 0 ? (
            <div 
              style={{ 
                padding: '2.5rem', 
                background: 'var(--bg-success-subtle)', 
                border: '1px dashed var(--accent-success)', 
                borderRadius: 'var(--radius-md)', 
                color: 'var(--text-success)', 
                textAlign: 'center',
                fontSize: '0.9rem' 
              }}
            >
              ✓ Inbox zero. Every transaction is successfully reconciled.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '2.5rem' }}>
              {rows.map((r) => (
                <TxnRow
                  key={r.txn.id}
                  row={r}
                  busy={busyId === r.txn.id}
                  onMatch={matchTopCandidate}
                  hostOrgId={currentOrg.id}
                  onSplitSaved={() => void refresh()}
                />
              ))}
            </div>
          )}

          {/* Recently Matched Panel */}
          {matched.length > 0 && (
            <div style={{ marginTop: '2rem' }}>
              <h2 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>Recently matched (last 20)</h2>
              <div className="table-premium-container">
                <table className="table-premium">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Description</th>
                      <th style={{ textAlign: 'right' }}>Amount</th>
                      <th>Matched to</th>
                      <th style={{ width: '80px' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {matched.map((m) => (
                      <tr key={m.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{m.posted_at.slice(0, 10)}</td>
                        <td>{m.description}</td>
                        <td style={{ 
                          textAlign: 'right', 
                          fontWeight: 600,
                          color: m.amount_cents < 0 ? 'var(--text-danger)' : 'var(--text-success)'
                        }}>
                          {formatMoney(m.amount_cents)}
                        </td>
                        <td>
                          {m.matched_bill_id && (
                            <Link to={`/bills/${m.matched_bill_id}`} className="badge badge-info" style={{ textDecoration: 'none' }}>
                              bill →
                            </Link>
                          )}
                          {m.matched_invoice_id && (
                            <Link to={`/invoices/${m.matched_invoice_id}`} className="badge badge-success" style={{ textDecoration: 'none' }}>
                              invoice →
                            </Link>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button 
                            onClick={() => void undoMatch(m.id)} 
                            disabled={busyId === m.id} 
                            className="btn btn-secondary"
                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.725rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                          >
                            <RotateCcw size={12} />
                            <span>Undo</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Footer note info box */}
          <div 
            style={{ 
              marginTop: '3rem', 
              padding: '1rem 1.25rem', 
              background: 'var(--bg-card)', 
              border: '1px dashed var(--border-subtle)', 
              borderRadius: 'var(--radius-md)', 
              fontSize: '0.75rem', 
              color: 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}
          >
            <AlertCircle size={16} />
            <span>Future updates: invoice matches (after P4), auto-categorisation rules, partial-match handling, multi-bill splits, and attachable receipt photos.</span>
          </div>
        </>
      )}
    </section>
  );
}

function TxnRow({
  row,
  busy,
  onMatch,
  hostOrgId,
  onSplitSaved,
}: {
  row: RowVm;
  busy: boolean;
  onMatch: (txnId: string, txnAmount: number, c: MatchCandidate) => void;
  hostOrgId: string;
  onSplitSaved: () => void;
}) {
  const { txn, candidates } = row;
  const top = candidates[0];
  const isPositive = txn.amount_cents >= 0;

  return (
    <div 
      className="card"
      style={{ 
        padding: '1rem 1.25rem', 
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'space-between', 
        alignItems: 'center', 
        gap: '1.25rem' 
      }}
    >
      {/* Left side details */}
      <div style={{ flex: 1, minWidth: '320px' }}>
        <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-title)' }}>
          {txn.description}
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span>{txn.posted_at.slice(0, 10)}</span>
          <span>·</span>
          <span 
            style={{ 
              fontWeight: 700, 
              color: isPositive ? 'var(--text-success)' : 'var(--text-danger)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.15rem'
            }}
          >
            {isPositive ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
            {formatMoney(txn.amount_cents)}
          </span>
          {txn.reference && (
            <>
              <span>·</span>
              <span>Ref: <code>{txn.reference}</code></span>
            </>
          )}
        </div>
        <div style={{ marginTop: '0.75rem' }}>
          <AllocationSplitButton
            resourceType="bank_transaction"
            resourceId={txn.id}
            hostOrgId={hostOrgId}
            onSaved={onSplitSaved}
            label="Split across businesses"
          />
        </div>
      </div>

      {/* Right side candidates */}
      <div style={{ minWidth: '360px', flexShrink: 0 }}>
        {candidates.length === 0 ? (
          <div style={{ fontSize: '0.825rem', color: 'var(--text-muted)', textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.35rem' }}>
            <AlertCircle size={14} />
            <span>No matching bill or invoice found</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {candidates.map((c, i) => {
              const isMatchReady = c.score >= 0.9;
              return (
                <div 
                  key={`${c.kind}-${i}`} 
                  style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center', 
                    gap: '0.75rem',
                    background: 'var(--bg-app)',
                    padding: '0.5rem 0.75rem',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-subtle)'
                  }}
                >
                  {c.kind === 'bill' ? (
                    <Link to={`/bills/${c.bill_id}`} style={{ fontSize: '0.775rem', color: 'var(--text-body)', display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.25rem' }}>
                      <span className="badge badge-info" style={{ fontSize: '8px', padding: '1px 3px' }}>BILL</span>
                      <strong style={{ color: 'var(--text-title)' }}>{c.supplier_name ?? '(no supplier)'}</strong>
                      <span>·</span>
                      <code>{c.bill_invoice_number ?? '—'}</code>
                      <span>·</span>
                      <span style={{ fontWeight: 600 }}>{formatMoney(c.bill_amount_cents)}</span>
                    </Link>
                  ) : (
                    <Link to={`/invoices/${c.invoice_id}`} style={{ fontSize: '0.775rem', color: 'var(--text-body)', display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.25rem' }}>
                      <span className="badge badge-success" style={{ fontSize: '8px', padding: '1px 3px' }}>INV</span>
                      <strong style={{ color: 'var(--text-title)' }}>{c.customer_name ?? '(no customer)'}</strong>
                      <span>·</span>
                      <code>{c.invoice_number}</code>
                      <span>·</span>
                      <span style={{ fontWeight: 600 }}>Owing {formatMoney(c.invoice_balance_due_cents)}</span>
                    </Link>
                  )}
                  
                  <button
                    onClick={() => onMatch(txn.id, txn.amount_cents, c)}
                    disabled={busy}
                    className="btn"
                    style={{
                      padding: '0.25rem 0.5rem',
                      fontSize: '0.725rem',
                      background: isMatchReady ? 'var(--bg-success-subtle)' : 'var(--bg-info-subtle)',
                      color: isMatchReady ? 'var(--text-success)' : 'var(--text-info)',
                      borderColor: isMatchReady ? 'var(--accent-success)' : 'var(--accent-info)',
                      fontWeight: 600,
                      cursor: busy ? 'wait' : 'pointer'
                    }}
                  >
                    Match ({(c.score * 100).toFixed(0)}%)
                  </button>
                </div>
              );
            })}
          </div>
        )}
        
        {top && top.score >= 0.95 && (
          <div style={{ marginTop: '0.5rem', fontSize: '0.725rem', color: 'var(--text-success)', textAlign: 'right', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.25rem' }}>
            <CheckCircle2 size={12} />
            <span>Strong match candidate — consider auto-applying</span>
          </div>
        )}
      </div>
    </div>
  );
}
