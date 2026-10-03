import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import { useCodingQueue, type CodingSuggestion } from '@/hooks/useCodingQueue';
import { getBillFileUrl } from '@/hooks/useBill';
import { supabase } from '@/lib/supabase';
import { formatLoadError } from '@/lib/errorMessages';
import { formatMoney } from '@/lib/money';
import { SkeletonLine } from '@/components/Skeleton';
import { ListChecks, Eye, EyeOff, CheckCircle2, X, Pencil } from 'lucide-react';
import { recordFeedback } from '@/lib/automationDecision';
import { noop } from '@/lib/utils';
import { PageHeader } from '@/components/ui/PageHeader';

// Bill fields the queue needs beyond the suggestion itself: a label for the card
// and storage_key/mime_type for the PDF preview. coding_review_queue carries only
// bill_id, so the page joins bills client-side (bills is RLS-readable per org).
interface BillInfo {
  id: string;
  storage_key: string;
  mime_type: string;
  supplier_name_raw: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total_inc_gst_cents: number | null;
}

// One active account for the override dropdown (chart_of_accounts is RLS-readable).
interface AccountOption {
  code: string;
  name: string;
}

function BillPreviewPane({ bill, onClose }: { bill: BillInfo; onClose: () => void }) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSignedUrl(null);
    setLoaded(false);

    getBillFileUrl(bill.storage_key).then((url) => {
      if (cancelled) return;
      setSignedUrl(url);
      setLoaded(true);
    });

    return () => {
      cancelled = true;
    };
  }, [bill.storage_key]);

  const isPdf = bill.mime_type === 'application/pdf';

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        width: '400px',
        maxWidth: '85vw',
        height: '100vh',
        background: 'var(--bg-panel)',
        borderLeft: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 100,
        boxShadow: 'var(--shadow-lg)',
        animation: 'fadeIn 0.3s ease',
      }}
      role="complementary"
      aria-label="Bill PDF preview"
    >
      <div
        style={{
          padding: '1rem',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0, flex: 1, marginRight: '0.5rem' }}>
          <div
            style={{
              fontWeight: 700,
              fontSize: '0.875rem',
              color: 'var(--text-title)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {bill.supplier_name_raw ?? 'Preview'}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '0.15rem' }}>
            {bill.invoice_date ?? ''}
            {bill.invoice_number ? ` · #${bill.invoice_number}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
          <a
            href={`/bills/${bill.id}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--text-link)', fontSize: '0.75rem', fontWeight: 600 }}
          >
            Open page &rarr;
          </a>
          <button
            onClick={onClose}
            aria-label="Close preview"
            className="btn btn-ghost"
            style={{ padding: '0.2rem 0.4rem' }}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', background: 'var(--bg-hover)' }}>
        {!loaded ? (
          <div
            style={{
              padding: 20,
              color: 'var(--text-muted)',
              fontSize: '0.875rem',
              background: 'var(--bg-panel)',
              height: '100%',
            }}
          >
            Generating preview…
          </div>
        ) : !signedUrl ? (
          <div
            style={{
              padding: 20,
              color: 'var(--text-danger)',
              fontSize: '0.875rem',
              background: 'var(--bg-panel)',
              height: '100%',
            }}
          >
            <p style={{ margin: 0, fontWeight: 'bold' }}>Could not load preview.</p>
            <p style={{ marginTop: 12 }}>
              <Link
                to={`/bills/${bill.id}`}
                style={{ color: 'var(--text-link)', fontWeight: 600 }}
              >
                Open bill detail page instead &rarr;
              </Link>
            </p>
          </div>
        ) : isPdf ? (
          <iframe
            src={signedUrl}
            title={`Bill preview — ${bill.supplier_name_raw ?? bill.id}`}
            style={{ width: '100%', height: '100%', border: 'none', background: 'var(--bg-paper)' }}
          />
        ) : (
          <div style={{ height: '100%', overflowY: 'auto', padding: 12 }}>
            <img
              src={signedUrl}
              alt={`Bill from ${bill.supplier_name_raw ?? 'supplier'}`}
              style={{
                width: '100%',
                borderRadius: 'var(--radius-sm)',
                boxShadow: 'var(--shadow-sm)',
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// Pull the human-readable "why" out of the classifier's rationale jsonb.
function rationaleSummary(rationale: Record<string, unknown>): string {
  if (rationale?.matched === true) {
    const type = typeof rationale.matcher_type === 'string' ? rationale.matcher_type : 'rule';
    const value = typeof rationale.matcher_value === 'string' ? rationale.matcher_value : '';
    return value ? `Matched ${type}: ${value}` : `Matched ${type}`;
  }
  const reason = typeof rationale?.reason === 'string' ? rationale.reason : null;
  return reason === 'no_matching_intake_rule' ? 'No matching intake rule' : 'No confident match';
}

export function CodingReviewPage() {
  const { currentOrg } = useOrg();
  const { suggestions, loading, error, accept, override } = useCodingQueue();
  const [billMap, setBillMap] = useState<Record<string, BillInfo>>({});
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  const [previewBillId, setPreviewBillId] = useState<string | null>(null);

  // The distinct bill ids the queue references (deduped — multiple suggestions can
  // point at one bill). Refetch the referenced bills whenever that set changes.
  const billIds = useMemo(
    () => [...new Set(suggestions.map((s) => s.bill_id))].sort(),
    [suggestions],
  );

  useEffect(() => {
    if (!currentOrg || billIds.length === 0) {
      setBillMap({});
      return;
    }
    let cancelled = false;
    supabase
      .from('bills')
      .select(
        'id, storage_key, mime_type, supplier_name_raw, invoice_number, invoice_date, total_inc_gst_cents',
      )
      .eq('organization_id', currentOrg.id)
      .in('id', billIds)
      .then(({ data, error: billErr }) => {
        if (cancelled || billErr) return;
        setBillMap(Object.fromEntries(((data ?? []) as BillInfo[]).map((b) => [b.id, b])));
      });
    return () => {
      cancelled = true;
    };
    // billIds is referenced by identity; it's a fresh array each queue change.
  }, [currentOrg, billIds]);

  // Active accounts for the override dropdown.
  useEffect(() => {
    if (!currentOrg) {
      setAccounts([]);
      return;
    }
    let cancelled = false;
    supabase
      .from('chart_of_accounts')
      .select('code, name')
      .eq('organization_id', currentOrg.id)
      .eq('is_active', true)
      .order('code')
      .then(({ data, error: accErr }) => {
        if (cancelled || accErr) return;
        setAccounts((data ?? []) as AccountOption[]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  const runDecision = async (suggestion: CodingSuggestion, fn: () => Promise<unknown>) => {
    setBusyId(suggestion.id);
    // Clear any prior error for this row before retrying ('' reads falsy → no badge).
    setErrorById((prev) => ({ ...prev, [suggestion.id]: '' }));
    try {
      await fn();
      // Resolved rows leave coding_review_queue, so the hook's refresh drops them.
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Decision failed';
      setErrorById((prev) => ({ ...prev, [suggestion.id]: msg }));
    } finally {
      setBusyId(null);
    }
  };

  if (!currentOrg) {
    return (
      <section className="animated-fade-in">
        <h1>Coding Review</h1>
        <p style={{ color: 'var(--text-muted)' }}>
          Pick an organisation to see the coding review queue.
        </p>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="animated-fade-in">
        <h1>Coding Review</h1>
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="card"
              style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
            >
              <SkeletonLine width="30%" height={16} />
              <SkeletonLine width="50%" height={12} />
              <SkeletonLine width="20%" height={12} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <div
        className="badge badge-danger"
        style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
      >
        {formatLoadError('coding review queue', error)}
      </div>
    );
  }

  if (suggestions.length === 0) {
    return (
      <section className="animated-fade-in" style={{ padding: '2rem 0' }}>
        <PageHeader title="Coding Review" style={{ marginBottom: '0.5rem' }} />
        <div
          style={{
            padding: '2.5rem 2rem',
            background: 'var(--bg-success-subtle)',
            border: '1px dashed var(--accent-success)',
            borderRadius: 'var(--radius-lg)',
            color: 'var(--text-success)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '1rem',
            maxWidth: '650px',
            margin: '2rem auto',
            textAlign: 'center',
          }}
        >
          <CheckCircle2 size={48} />
          <div>
            <h3
              style={{ color: 'var(--text-success)', margin: '0 0 0.25rem 0', fontSize: '1.15rem' }}
            >
              Coding queue clear
            </h3>
            <p style={{ margin: 0, fontSize: '0.875rem', opacity: 0.85 }}>
              Every bill the classifier wasn't sure about has been coded.
            </p>
          </div>
          <p
            style={{
              color: 'var(--text-muted)',
              fontSize: '0.775rem',
              lineHeight: '1.5',
              margin: '0.5rem 0 0 0',
              maxWidth: '480px',
            }}
          >
            Low-confidence codings land here. High-confidence ones post automatically. Accept the
            proposed code, or override it, and the journal posts.
          </p>
        </div>
      </section>
    );
  }

  const previewBill = previewBillId ? (billMap[previewBillId] ?? null) : null;

  return (
    <>
      <section
        style={{
          marginRight: previewBill ? '420px' : 0,
          transition: 'margin-right 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
        className="animated-fade-in"
      >
        <div style={{ marginBottom: '1.5rem' }}>
          <PageHeader title={<><ListChecks size={24} style={{ color: 'var(--text-link)' }} /> Coding Review</>} style={{ marginBottom: '0.25rem' }} />
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', margin: 0 }}>
            {suggestions.length} bill{suggestions.length === 1 ? '' : 's'} the classifier wants a
            human to code.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {suggestions.map((s) => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              bill={billMap[s.bill_id]}
              accounts={accounts}
              busy={busyId === s.id}
              actionError={errorById[s.id]}
              isPreviewing={previewBillId === s.bill_id}
              onPreview={() => setPreviewBillId(previewBillId === s.bill_id ? null : s.bill_id)}
              onAccept={() => runDecision(s, () => accept(s))}
              onOverride={(codes) =>
                runDecision(s, async () => {
                  await override(s, codes);
                  void recordFeedback({
                    organizationId: s.organization_id,
                    sourceKind: 'bill_coding',
                    sourceId: s.bill_id,
                    previousValue: { account_code: s.account_code, tax_code: s.tax_code },
                    newValue: { account_code: codes.account_code, tax_code: codes.tax_code },
                    correctionReason: 'coding_review_override',
                  }).catch(noop);
                })
              }
            />
          ))}
        </div>
      </section>

      {previewBill && <BillPreviewPane bill={previewBill} onClose={() => setPreviewBillId(null)} />}
    </>
  );
}

function SuggestionCard({
  suggestion,
  bill,
  accounts,
  busy,
  actionError,
  isPreviewing,
  onPreview,
  onAccept,
  onOverride,
}: {
  suggestion: CodingSuggestion;
  bill: BillInfo | undefined;
  accounts: AccountOption[];
  busy: boolean;
  actionError: string | undefined;
  isPreviewing: boolean;
  onPreview: () => void;
  onAccept: () => void;
  onOverride: (codes: { account_code: string; tax_code: string | null }) => void;
}) {
  const [overriding, setOverriding] = useState(false);
  const [accountCode, setAccountCode] = useState(suggestion.account_code ?? '');
  const [taxCode, setTaxCode] = useState(suggestion.tax_code ?? '');

  const confidence = suggestion.confidence ?? 0;
  const confClass = confidence >= 0.75 ? 'badge-warning' : 'badge-neutral';

  const canPreview = bill?.storage_key != null;
  const canAccept = (suggestion.account_code ?? '').trim() !== '';

  return (
    <div
      className="card"
      style={{
        padding: '1.25rem',
        borderLeft: isPreviewing
          ? '4px solid var(--accent-primary)'
          : '1px solid var(--border-subtle)',
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: '1rem',
      }}
    >
      <div style={{ flex: 1, minWidth: '300px' }}>
        <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-title)' }}>
          {bill?.supplier_name_raw ?? (
            <span style={{ color: 'var(--text-muted)' }}>No supplier extracted</span>
          )}
        </div>
        <div
          style={{
            fontSize: '0.8rem',
            color: 'var(--text-muted)',
            marginTop: '0.25rem',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.5rem',
            alignItems: 'center',
          }}
        >
          <span style={{ fontWeight: 600, color: 'var(--text-body)' }}>
            {bill ? formatMoney(bill.total_inc_gst_cents) : '—'}
          </span>
          <span>·</span>
          <code>{bill?.invoice_number ?? '—'}</code>
          <span>·</span>
          <span>{bill?.invoice_date ?? '—'}</span>
          <span>·</span>
          <span className={`badge ${confClass}`} style={{ fontSize: '8px' }}>
            {(confidence * 100).toFixed(0)}% confidence
          </span>
        </div>

        <div
          style={{
            fontSize: '0.8rem',
            color: 'var(--text-body)',
            marginTop: '0.5rem',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.5rem',
            alignItems: 'center',
          }}
        >
          <span style={{ color: 'var(--text-muted)' }}>Proposed:</span>
          <code style={{ color: 'var(--text-link)', fontWeight: 600 }}>
            {suggestion.account_code ?? '— no account —'}
          </code>
          {suggestion.tax_code && (
            <span className="badge badge-neutral" style={{ fontSize: '8px' }}>
              {suggestion.tax_code}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            marginTop: '0.25rem',
            fontStyle: 'italic',
          }}
        >
          {rationaleSummary(suggestion.rationale)}
        </div>

        <button
          onClick={onPreview}
          disabled={!canPreview}
          className="btn btn-ghost"
          style={{
            marginTop: '0.5rem',
            padding: '0.2rem 0.5rem',
            fontSize: '0.75rem',
            marginLeft: '-0.5rem',
          }}
          aria-pressed={isPreviewing}
          title={canPreview ? undefined : 'No document attached'}
        >
          {isPreviewing ? <EyeOff size={12} /> : <Eye size={12} />}
          <span>{isPreviewing ? 'Close Preview' : 'Show PDF'}</span>
        </button>

        {actionError && (
          <div
            className="badge badge-danger"
            style={{
              display: 'block',
              marginTop: '0.5rem',
              padding: '0.4rem 0.6rem',
              textTransform: 'none',
              fontSize: '0.75rem',
            }}
          >
            {actionError}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          minWidth: '280px',
          flexShrink: 0,
        }}
      >
        {!overriding ? (
          <div style={{ display: 'flex', gap: '0.35rem' }}>
            <button
              onClick={onAccept}
              disabled={busy || !canAccept}
              className="btn btn-primary"
              style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem', flex: 1 }}
              title={canAccept ? undefined : 'No proposed account — override to set one'}
            >
              {busy ? 'Posting…' : 'Accept & post'}
            </button>
            <button
              onClick={() => setOverriding(true)}
              disabled={busy}
              className="btn btn-secondary"
              style={{
                padding: '0.35rem 0.75rem',
                fontSize: '0.75rem',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
              }}
            >
              <Pencil size={12} /> Override
            </button>
          </div>
        ) : (
          <div
            style={{
              background: 'var(--bg-app)',
              padding: '0.75rem',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
            }}
          >
            <label style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              Account
              <select
                value={accountCode}
                onChange={(e) => setAccountCode(e.target.value)}
                disabled={busy}
                className="form-select"
                style={{
                  padding: '0.4rem 0.5rem',
                  fontSize: '0.8rem',
                  width: '100%',
                  marginTop: '0.2rem',
                }}
              >
                <option value="">— Select an account —</option>
                {accounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              Tax code
              <input
                value={taxCode}
                onChange={(e) => setTaxCode(e.target.value)}
                disabled={busy}
                list="coding-tax-codes"
                placeholder="e.g. GST on Expenses"
                className="form-input"
                style={{
                  padding: '0.4rem 0.5rem',
                  fontSize: '0.8rem',
                  width: '100%',
                  marginTop: '0.2rem',
                }}
              />
              <datalist id="coding-tax-codes">
                <option value="GST on Expenses" />
                <option value="GST Free Expenses" />
                <option value="BAS Excluded" />
                <option value="Input Taxed" />
              </datalist>
            </label>
            <div style={{ display: 'flex', gap: '0.35rem' }}>
              <button
                onClick={() =>
                  onOverride({
                    account_code: accountCode,
                    tax_code: taxCode.trim() === '' ? null : taxCode.trim(),
                  })
                }
                disabled={busy || accountCode.trim() === ''}
                className="btn btn-primary"
                style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem', flex: 1 }}
              >
                {busy ? 'Posting…' : 'Override & post'}
              </button>
              <button
                onClick={() => setOverriding(false)}
                disabled={busy}
                className="btn btn-ghost"
                style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
