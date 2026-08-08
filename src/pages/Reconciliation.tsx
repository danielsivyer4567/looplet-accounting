import { Fragment, useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';
import { AllocationSplitButton } from '@/components/AllocationSplitButton';
import { BankTransactionCodingQueue } from '@/components/BankTransactionCodingQueue';
import {
  Scale,
  CheckCircle2,
  AlertCircle,
  ArrowUpRight,
  ArrowDownRight,
  RotateCcw,
  Check,
  ChevronDown,
  ChevronUp,
  Info,
} from 'lucide-react';
import { ConfidenceBadge } from '@/components/ConfidenceBadge';
import { recordFeedback, type AutomationConfidence } from '@/lib/automationDecision';
import { noop } from '@/lib/utils';
import { enqueueJob } from '@/lib/automationJobs';

interface BankTxn {
  id: string;
  posted_at: string;
  description: string;
  amount_cents: number;
  reference: string | null;
  matched_bill_id: string | null;
  matched_invoice_id: string | null;
  bank_account_id: string;
  manually_matched: boolean | null;
}

interface EvidenceRow {
  id: string;
  reason_codes: string[];
  score_components: Record<string, unknown>;
  auto_applied: boolean;
  skipped_reason: string | null;
  created_at: string;
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

function scoreToConfidence(score: number): AutomationConfidence {
  if (score >= 0.95) return 'auto_post';
  if (score >= 0.85) return 'quick_confirm';
  if (score >= 0.5) return 'review_needed';
  return 'advisor_required';
}

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
  const [expandedEvidenceId, setExpandedEvidenceId] = useState<string | null>(null);
  const [evidenceCache, setEvidenceCache] = useState<Map<string, EvidenceRow[]>>(new Map());

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);

    const [txnRes, matchedRes, billCandRes, invoiceCandRes] = await Promise.all([
      supabase
        .from('bank_transactions')
        .select(
          'id, posted_at, description, amount_cents, reference, matched_bill_id, matched_invoice_id, bank_account_id',
        )
        .eq('organization_id', currentOrg.id)
        .is('matched_bill_id', null)
        .is('matched_invoice_id', null)
        .order('posted_at', { ascending: false })
        .limit(200),
      supabase
        .from('bank_transactions')
        .select(
          'id, posted_at, description, amount_cents, reference, matched_bill_id, matched_invoice_id, bank_account_id, manually_matched',
        )
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

    if (txnRes.error) {
      setError(txnRes.error.message);
      setLoading(false);
      return;
    }
    if (billCandRes.error) {
      setError(billCandRes.error.message);
      setLoading(false);
      return;
    }

    const candidatesByTxn = new Map<string, MatchCandidate[]>();
    for (const c of (billCandRes.data ?? []) as (BillMatchCandidate & {
      bank_transaction_id: string;
    })[]) {
      const list = candidatesByTxn.get(c.bank_transaction_id) ?? [];
      list.push({ ...c, kind: 'bill' });
      candidatesByTxn.set(c.bank_transaction_id, list);
    }
    for (const c of (invoiceCandRes.data ?? []) as (InvoiceMatchCandidate & {
      bank_transaction_id: string;
    })[]) {
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

      void recordFeedback({
        organizationId: currentOrg.id,
        sourceKind: 'bank_match',
        sourceId: txnId,
        newValue: { matched_bill_id: billId },
        correctionReason: 'reconciliation_confirm',
      }).catch(noop);

      try {
        await enqueueJob({
          organizationId: currentOrg.id,
          jobKind: 'xero_push',
          sourceKind: 'bill',
          sourceId: billId,
          priority: 4,
          payload: { bill_id: billId, source: 'bank_reconciliation_match' },
        });
      } catch (queueErr) {
        setError(
          `Bill matched, but Xero push was not queued: ${
            queueErr instanceof Error ? queueErr.message : String(queueErr)
          }`,
        );
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

      void recordFeedback({
        organizationId: currentOrg.id,
        sourceKind: 'bank_match',
        sourceId: txnId,
        newValue: { matched_invoice_id: invoiceId, amount_cents: amountCents },
        correctionReason: 'reconciliation_confirm',
      }).catch(noop);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
      void refresh();
    }
  };

  const loadEvidence = async (txnId: string) => {
    if (expandedEvidenceId === txnId) {
      setExpandedEvidenceId(null);
      return;
    }
    if (!evidenceCache.has(txnId)) {
      const { data } = await supabase
        .from('reconciliation_evidence')
        .select('id, reason_codes, score_components, auto_applied, skipped_reason, created_at')
        .eq('bank_transaction_id', txnId)
        .order('created_at', { ascending: false })
        .limit(5);
      setEvidenceCache((prev) => new Map(prev).set(txnId, (data ?? []) as EvidenceRow[]));
    }
    setExpandedEvidenceId(txnId);
  };

  const undoMatch = async (txn: BankTxn) => {
    if (!confirm('Undo this match?')) return;
    setBusyId(txn.id);
    try {
      const { data, error: rpcErr } = await supabase.rpc('reconcile_undo_match', {
        p_bank_transaction_id: txn.id,
      });
      if (rpcErr) throw rpcErr;
      const result = data as { ok: boolean; error?: string } | null;
      if (result && !result.ok) throw new Error(result.error ?? 'reconcile_undo_match failed');

      if (!txn.manually_matched) {
        void recordFeedback({
          organizationId: currentOrg.id,
          sourceKind: 'bank_match',
          sourceId: txn.id,
          previousValue: txn.matched_bill_id
            ? { matched_bill_id: txn.matched_bill_id }
            : { matched_invoice_id: txn.matched_invoice_id },
          newValue: { action: 'undo_auto_match' },
          correctionReason: 'auto_match_overridden',
        }).catch(noop);
      }
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
      await matchToInvoice(
        txnId,
        candidate.invoice_id,
        Math.min(txnAmount, candidate.invoice_balance_due_cents),
      );
    }
  };

  const bulkApplyHigh = async () => {
    const high = rows.filter((r) => r.candidates[0] && r.candidates[0].score >= 0.9);
    if (high.length === 0) return;
    if (
      !confirm(`Auto-match ${high.length} high-confidence transactions? You can undo individually.`)
    )
      return;
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
        <h1
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}
        >
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
        <div
          className="badge badge-danger"
          style={{
            display: 'block',
            padding: '0.75rem',
            marginBottom: '1rem',
            textTransform: 'none',
          }}
        >
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
                gap: '0.75rem',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  color: 'var(--text-success)',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                }}
              >
                <CheckCircle2 size={16} />
                <span>
                  {withSugg.length} unmatched transaction{withSugg.length === 1 ? '' : 's'} have
                  candidate matches.
                </span>
              </div>
              {rows.some((r) => scoreToConfidence(r.candidates[0]?.score ?? 0) === 'auto_post') && (
                <button
                  onClick={() => void bulkApplyHigh()}
                  className="btn btn-primary"
                  style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}
                >
                  <CheckCircle2 size={12} />
                  <span>Auto-match high-confidence</span>
                </button>
              )}
            </div>
          )}

          <h2 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>
            Unmatched transactions ({rows.length})
          </h2>
          {rows.length === 0 ? (
            <div
              style={{
                padding: '2.5rem',
                background: 'var(--bg-success-subtle)',
                border: '1px dashed var(--accent-success)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--text-success)',
                textAlign: 'center',
                fontSize: '0.9rem',
              }}
            >
              ✓ Inbox zero. Every transaction is successfully reconciled.
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
                marginBottom: '2.5rem',
              }}
            >
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
              <h2 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>
                Recently matched (last 20)
              </h2>
              <div className="table-premium-container reconciliation-table-view">
                <table className="table-premium">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Description</th>
                      <th style={{ textAlign: 'right' }}>Amount</th>
                      <th>Matched to</th>
                      <th style={{ width: '120px' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {matched.map((m) => (
                      <Fragment key={m.id}>
                        <tr key={m.id}>
                          <td style={{ whiteSpace: 'nowrap' }}>{m.posted_at.slice(0, 10)}</td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                              <span>{m.description}</span>
                              {!m.manually_matched && (
                                <span
                                  className="badge badge-info"
                                  style={{ fontSize: '9px', padding: '1px 4px', fontWeight: 500 }}
                                >
                                  auto
                                </span>
                              )}
                            </div>
                          </td>
                          <td
                            style={{
                              textAlign: 'right',
                              fontWeight: 600,
                              color:
                                m.amount_cents < 0 ? 'var(--text-danger)' : 'var(--text-success)',
                            }}
                          >
                            {formatMoney(m.amount_cents)}
                          </td>
                          <td>
                            <MatchedTarget txn={m} />
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <MatchedActions
                              txn={m}
                              busy={busyId === m.id}
                              expanded={expandedEvidenceId === m.id}
                              onLoadEvidence={loadEvidence}
                              onUndo={undoMatch}
                            />
                          </td>
                        </tr>
                        {expandedEvidenceId === m.id && (
                          <tr key={`${m.id}-evidence`}>
                            <td colSpan={5} style={{ padding: '0.5rem 0.75rem 0.75rem' }}>
                              <EvidencePanel rows={evidenceCache.get(m.id) ?? []} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="reconciliation-card-view" aria-label="Recently matched mobile cards">
                {matched.map((m) => (
                  <div key={m.id} className="reconciliation-mobile-card">
                    <div className="reconciliation-mobile-card__header">
                      <strong>{m.description}</strong>
                      {!m.manually_matched && (
                        <span className="badge badge-info" style={{ fontSize: '9px' }}>
                          auto
                        </span>
                      )}
                    </div>
                    <div className="reconciliation-mobile-card__row">
                      <span>Date</span>
                      <strong>{m.posted_at.slice(0, 10)}</strong>
                    </div>
                    <div className="reconciliation-mobile-card__row">
                      <span>Amount</span>
                      <strong
                        style={{
                          color: m.amount_cents < 0 ? 'var(--text-danger)' : 'var(--text-success)',
                        }}
                      >
                        {formatMoney(m.amount_cents)}
                      </strong>
                    </div>
                    <div className="reconciliation-mobile-card__row">
                      <span>Matched to</span>
                      <MatchedTarget txn={m} />
                    </div>
                    <MatchedActions
                      txn={m}
                      busy={busyId === m.id}
                      expanded={expandedEvidenceId === m.id}
                      onLoadEvidence={loadEvidence}
                      onUndo={undoMatch}
                    />
                    {expandedEvidenceId === m.id && (
                      <EvidencePanel rows={evidenceCache.get(m.id) ?? []} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Coding Queue — AI-suggested GL categories for bank transactions */}
          <div
            style={{
              marginTop: '3rem',
              padding: '1.5rem',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <BankTransactionCodingQueue />
          </div>

          {/* Footer note info box */}
          <div
            style={{
              marginTop: '1.5rem',
              padding: '1rem 1.25rem',
              background: 'var(--bg-card)',
              border: '1px dashed var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <AlertCircle size={16} />
            <span>
              Coding queue learns from every confirmation and override — recurring merchants are
              auto-coded after the first review.
            </span>
          </div>
        </>
      )}
    </section>
  );
}

function MatchedTarget({ txn }: { txn: BankTxn }) {
  return (
    <div style={{ display: 'inline-flex', gap: '0.35rem', flexWrap: 'wrap' }}>
      {txn.matched_bill_id && (
        <Link
          to={`/bills/${txn.matched_bill_id}`}
          className="badge badge-info"
          style={{ textDecoration: 'none' }}
        >
          bill →
        </Link>
      )}
      {txn.matched_invoice_id && (
        <Link
          to={`/invoices/${txn.matched_invoice_id}`}
          className="badge badge-success"
          style={{ textDecoration: 'none' }}
        >
          invoice →
        </Link>
      )}
    </div>
  );
}

function MatchedActions({
  txn,
  busy,
  expanded,
  onLoadEvidence,
  onUndo,
}: {
  txn: BankTxn;
  busy: boolean;
  expanded: boolean;
  onLoadEvidence: (txnId: string) => Promise<void>;
  onUndo: (txn: BankTxn) => Promise<void>;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.35rem',
        justifyContent: 'flex-end',
        flexWrap: 'wrap',
      }}
    >
      <button
        onClick={() => void onLoadEvidence(txn.id)}
        className="btn btn-secondary"
        style={{
          padding: '0.25rem 0.4rem',
          fontSize: '0.7rem',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.2rem',
        }}
        title="Why this match?"
      >
        <Info size={11} />
        <span>Why?</span>
        {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
      </button>
      <button
        onClick={() => void onUndo(txn)}
        disabled={busy}
        className="btn btn-secondary"
        style={{
          padding: '0.25rem 0.5rem',
          fontSize: '0.725rem',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.25rem',
        }}
      >
        <RotateCcw size={12} />
        <span>Undo</span>
      </button>
    </div>
  );
}

function EvidencePanel({ rows }: { rows: EvidenceRow[] }) {
  if (rows.length === 0) {
    return (
      <div
        style={{
          fontSize: '0.775rem',
          color: 'var(--text-muted)',
          fontStyle: 'italic',
          padding: '0.4rem 0',
        }}
      >
        No autopilot evidence recorded for this match.
      </div>
    );
  }
  const latest = rows[0];
  if (!latest) return null;
  const sc = latest.score_components as Record<string, unknown>;
  const reasonLabels: Record<string, string> = {
    amount_exact: 'Exact amount',
    amount_close: 'Near-exact amount (≤$0.50)',
    amount_match: 'Amount within tolerance',
    date_exact: 'Same day',
    date_recent: 'Within 3 days',
    date_close: 'Within 7 days',
    name_match: 'Supplier/customer name matched',
    number_match: 'Invoice number matched',
  };
  return (
    <div
      style={{
        background: 'var(--bg-app)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        padding: '0.75rem 1rem',
        fontSize: '0.775rem',
      }}
    >
      <div
        style={{
          fontWeight: 600,
          color: 'var(--text-muted)',
          marginBottom: '0.4rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
        }}
      >
        <Info size={12} />
        Why Looplet picked this match
        {latest.auto_applied && (
          <span className="badge badge-info" style={{ fontSize: '9px', padding: '1px 4px' }}>
            auto-applied
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.5rem' }}>
        {latest.reason_codes.map((code) => (
          <span
            key={code}
            style={{
              padding: '0.15rem 0.45rem',
              background: 'var(--bg-success-subtle)',
              border: '1px solid rgba(16,185,129,0.2)',
              borderRadius: '999px',
              fontSize: '0.7rem',
              color: 'var(--text-success)',
              fontWeight: 500,
            }}
          >
            {reasonLabels[code] ?? code}
          </span>
        ))}
      </div>
      {typeof sc.score === 'number' && (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.725rem' }}>
          Score: <strong>{((sc.score as number) * 100).toFixed(0)}%</strong>
          {typeof sc.amount_diff_cents === 'number' && (
            <>
              {' · '}Amount diff:{' '}
              <strong>
                {sc.amount_diff_cents === 0
                  ? 'exact'
                  : `$${(Math.abs(sc.amount_diff_cents as number) / 100).toFixed(2)}`}
              </strong>
            </>
          )}
          {typeof sc.days_diff === 'number' && (
            <>
              {' · '}Days apart:{' '}
              <strong>{sc.days_diff === 0 ? 'same day' : `${sc.days_diff}d`}</strong>
            </>
          )}
        </div>
      )}
    </div>
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
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
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
        gap: '1.25rem',
      }}
    >
      {/* Left side details */}
      <div style={{ flex: 1, minWidth: '320px' }}>
        <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-title)' }}>
          {txn.description}
        </div>
        <div
          style={{
            fontSize: '0.8rem',
            color: 'var(--text-muted)',
            marginTop: '0.25rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          <span>{txn.posted_at.slice(0, 10)}</span>
          <span>·</span>
          <span
            style={{
              fontWeight: 700,
              color: isPositive ? 'var(--text-success)' : 'var(--text-danger)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.15rem',
            }}
          >
            {isPositive ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
            {formatMoney(txn.amount_cents)}
          </span>
          {txn.reference && (
            <>
              <span>·</span>
              <span>
                Ref: <code>{txn.reference}</code>
              </span>
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
          <div
            style={{
              fontSize: '0.825rem',
              color: 'var(--text-muted)',
              textAlign: 'right',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: '0.35rem',
            }}
          >
            <AlertCircle size={14} />
            <span>No matching bill or invoice found</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {candidates.map((c, i) => {
              const isExpanded = expandedIdx === i;
              return (
                <div key={`${c.kind}-${i}`}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '0.75rem',
                      background: 'var(--bg-app)',
                      padding: '0.5rem 0.75rem',
                      borderRadius: isExpanded
                        ? 'var(--radius-sm) var(--radius-sm) 0 0'
                        : 'var(--radius-sm)',
                      border: '1px solid var(--border-subtle)',
                      borderBottom: isExpanded ? 'none' : undefined,
                    }}
                  >
                    {c.kind === 'bill' ? (
                      <Link
                        to={`/bills/${c.bill_id}`}
                        style={{
                          fontSize: '0.775rem',
                          color: 'var(--text-body)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          gap: '0.25rem',
                        }}
                      >
                        <span
                          className="badge badge-info"
                          style={{ fontSize: '8px', padding: '1px 3px' }}
                        >
                          BILL
                        </span>
                        <strong style={{ color: 'var(--text-title)' }}>
                          {c.supplier_name ?? '(no supplier)'}
                        </strong>
                        <span>·</span>
                        <code>{c.bill_invoice_number ?? '—'}</code>
                        <span>·</span>
                        <span style={{ fontWeight: 600 }}>{formatMoney(c.bill_amount_cents)}</span>
                      </Link>
                    ) : (
                      <Link
                        to={`/invoices/${c.invoice_id}`}
                        style={{
                          fontSize: '0.775rem',
                          color: 'var(--text-body)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          gap: '0.25rem',
                        }}
                      >
                        <span
                          className="badge badge-success"
                          style={{ fontSize: '8px', padding: '1px 3px' }}
                        >
                          INV
                        </span>
                        <strong style={{ color: 'var(--text-title)' }}>
                          {c.customer_name ?? '(no customer)'}
                        </strong>
                        <span>·</span>
                        <code>{c.invoice_number}</code>
                        <span>·</span>
                        <span style={{ fontWeight: 600 }}>
                          Owing {formatMoney(c.invoice_balance_due_cents)}
                        </span>
                      </Link>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <button
                        onClick={() => setExpandedIdx(isExpanded ? null : i)}
                        className="btn btn-secondary"
                        style={{
                          padding: '0.2rem 0.35rem',
                          fontSize: '0.7rem',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.15rem',
                          color: 'var(--text-muted)',
                        }}
                        title="Why this score?"
                      >
                        <Info size={11} />
                        {isExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                      </button>
                      <ConfidenceBadge confidence={scoreToConfidence(c.score)} />
                      <button
                        onClick={() => onMatch(txn.id, txn.amount_cents, c)}
                        disabled={busy}
                        className={`btn${scoreToConfidence(c.score) === 'auto_post' ? ' btn-primary' : ''}`}
                        style={{
                          padding: '0.25rem 0.5rem',
                          fontSize: '0.725rem',
                          fontWeight: 600,
                          cursor: busy ? 'wait' : 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                        }}
                      >
                        {scoreToConfidence(c.score) === 'quick_confirm' && <Check size={12} />}
                        Match ({(c.score * 100).toFixed(0)}%)
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div
                      style={{
                        background: 'var(--bg-app)',
                        border: '1px solid var(--border-subtle)',
                        borderTop: '1px dashed var(--border-subtle)',
                        borderRadius: '0 0 var(--radius-sm) var(--radius-sm)',
                        padding: '0.5rem 0.75rem',
                        fontSize: '0.725rem',
                        color: 'var(--text-muted)',
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '0.75rem',
                      }}
                    >
                      <span>
                        Score:{' '}
                        <strong style={{ color: 'var(--text-body)' }}>
                          {(c.score * 100).toFixed(0)}%
                        </strong>
                      </span>
                      <span>
                        Amount diff:{' '}
                        <strong style={{ color: 'var(--text-body)' }}>
                          {c.amount_diff_cents === 0
                            ? 'exact'
                            : `$${(Math.abs(c.amount_diff_cents) / 100).toFixed(2)}`}
                        </strong>
                      </span>
                      <span>
                        Days apart:{' '}
                        <strong style={{ color: 'var(--text-body)' }}>
                          {c.days_diff === 0 ? 'same day' : `${c.days_diff}d`}
                        </strong>
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {top && scoreToConfidence(top.score) === 'auto_post' && (
          <div
            style={{
              marginTop: '0.5rem',
              fontSize: '0.725rem',
              color: 'var(--text-success)',
              textAlign: 'right',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: '0.25rem',
            }}
          >
            <CheckCircle2 size={12} />
            <span>Auto-match ready</span>
          </div>
        )}
      </div>
    </div>
  );
}
