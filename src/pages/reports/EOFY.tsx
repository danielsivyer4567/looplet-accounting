import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import { useEofyPack } from '@/hooks/useEofyPack';
import { formatMoney } from '@/lib/money';
import { currentFyStartYear } from '@/lib/formatting';
import { orgTimeZone } from '@/lib/localDates';
import {
  ChevronLeft,
  ClipboardCheck,
  PlayCircle,
  Download,
  FileJson,
  FileText,
  CheckCircle2,
  AlertTriangle,
  ShieldAlert,
  Loader2,
} from 'lucide-react';

/**
 * EOFY Pack wizard (SC-4.C.03) — walks one AU FY through readiness → generate →
 * downloadable pack, consuming `useEofyPack` (SC-4.C.02 → eofy-pack edge fn).
 *
 * Step 1 (Readiness): preview() runs the read-only path (skip_true_up=true) and
 * surfaces the readiness blockers + a preview of the statements.
 * Step 2 (Generate): generate() runs the MUTATING year-end true-up (closes the FY
 * months, posts depreciation, locks periods) — guarded behind an explicit confirm.
 * Step 3 (Download): the PAGE owns the download (the hook is a pure data hook) —
 * PDF + structured JSON built from pdfBase64 / bundle.
 */

const fyLabel = (fy: number) => `FY${fy}-${(fy + 1).toString().slice(2)}`;

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function EofyReportPage() {
  const { currentOrg } = useOrg();
  const fyStart = currentFyStartYear(orgTimeZone(currentOrg));
  const [fyStartYear, setFyStartYear] = useState<number>(fyStart);
  const { bundle, pdfBase64, loading, error, blocked, generate, preview, reset } =
    useEofyPack(fyStartYear);

  // Clear any displayed pack when the FY changes so stale figures aren't shown.
  useEffect(() => reset(), [fyStartYear, reset]);

  if (!currentOrg) return null;

  const fyOptions = [0, 1, 2, 3, 4].map((i) => fyStart - i);
  const readiness = bundle?.readiness ?? null;
  const finalised = bundle?.true_up_run === true;

  const handleGenerate = () => {
    const proceed = window.confirm(
      `Generating the ${fyLabel(fyStartYear)} EOFY pack runs the year-end true-up: it closes the financial-year months, posts depreciation, and locks the periods. This cannot be undone.\n\nGenerate now?`,
    );
    if (!proceed) return;
    void generate();
  };

  const fileStem = `eofy-pack-${fyLabel(fyStartYear)}`;
  const downloadPdf = () => {
    if (!pdfBase64) return;
    triggerDownload(base64ToBlob(pdfBase64, 'application/pdf'), `${fileStem}.pdf`);
  };
  const downloadJson = () => {
    if (!bundle) return;
    triggerDownload(
      new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
      `${fileStem}.json`,
    );
  };

  return (
    <section className="animated-fade-in">
      <Link
        to="/reports"
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.825rem',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.25rem',
          marginBottom: '1rem',
        }}
      >
        <ChevronLeft size={14} />
        <span>Reports</span>
      </Link>

      <h1 style={{ margin: 0 }}>EOFY Pack</h1>
      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.875rem',
          marginTop: '0.25rem',
          marginBottom: '1.5rem',
          maxWidth: '800px',
          lineHeight: '1.5',
        }}
      >
        Bring the books to their end-of-financial-year state and bundle the statutory P&amp;L,
        balance sheet, statement of changes in equity, cash-flow statement and notes into one
        downloadable pack — the input to the annual tax return.
      </p>

      {/* Step indicator */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
        <StepPill n={1} label="Check readiness" active={!bundle} done={!!bundle} />
        <StepPill n={2} label="Generate pack" active={!!bundle && !finalised} done={finalised} />
        <StepPill n={3} label="Download" active={finalised} done={false} />
      </div>

      {/* Step 1 — FY selection + actions */}
      <div className="card" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label
              htmlFor="eofy-fy"
              style={{
                display: 'block',
                fontSize: '0.7rem',
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                marginBottom: '0.35rem',
              }}
            >
              Financial year
            </label>
            <select
              id="eofy-fy"
              className="form-select"
              value={fyStartYear}
              onChange={(e) => setFyStartYear(Number(e.target.value))}
              disabled={loading}
              style={{ minWidth: '160px' }}
            >
              {fyOptions.map((fy) => (
                <option key={fy} value={fy}>
                  {fyLabel(fy)}
                </option>
              ))}
            </select>
          </div>

          <button
            className="btn btn-secondary"
            onClick={() => void preview()}
            disabled={loading}
            title="Read-only readiness check — no changes are made"
          >
            {loading ? <Loader2 size={14} /> : <ClipboardCheck size={14} />}
            <span>Check readiness</span>
          </button>

          <button
            className="btn btn-primary"
            onClick={handleGenerate}
            disabled={loading}
            title="Runs the year-end true-up and locks the periods"
          >
            {loading ? <Loader2 size={14} /> : <PlayCircle size={14} />}
            <span>Generate pack</span>
          </button>
        </div>
      </div>

      {/* Recoverable books-health block (409) */}
      {blocked && error && (
        <Banner tone="warning" icon={ShieldAlert}>
          <strong>Books not ready:</strong> {error} Fix the flagged items on{' '}
          <Link
            to="/quality"
            style={{ color: 'inherit', textDecoration: 'underline', fontWeight: 600 }}
          >
            Quality
          </Link>{' '}
          before generating the pack.
        </Banner>
      )}

      {/* Terminal error (403 / generation failure) */}
      {error && !blocked && (
        <Banner tone="danger" icon={AlertTriangle}>
          {error}
        </Banner>
      )}

      {/* Step 1 result — readiness */}
      {readiness && (
        <div className="card" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '1rem',
              gap: '0.75rem',
              flexWrap: 'wrap',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Readiness</h2>
            <span
              className={`badge ${readiness.ready ? 'badge-success' : 'badge-warning'}`}
              style={{ textTransform: 'none' }}
            >
              {readiness.ready ? 'Ready to finalise' : 'Not yet ready'}
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: '0.75rem',
              marginBottom: readiness.blockers.length > 0 ? '1.25rem' : 0,
            }}
          >
            <Stat
              label="Open periods"
              value={String(readiness.open_period_count)}
              warn={readiness.open_period_count > 0}
            />
            <Stat
              label="Unreconciled"
              value={String(readiness.unreconciled_count)}
              warn={readiness.unreconciled_count > 0}
            />
            <Stat
              label="Uncoded"
              value={String(readiness.uncoded_count)}
              warn={readiness.uncoded_count > 0}
            />
            <Stat
              label="Trial balance"
              value={readiness.trial_balance_balanced ? 'Balanced' : 'Out'}
              warn={!readiness.trial_balance_balanced}
            />
          </div>

          {readiness.blockers.length > 0 && (
            <div>
              {readiness.blockers.map((b, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    fontSize: '0.85rem',
                    padding: '0.35rem 0',
                    color: 'var(--text-danger)',
                  }}
                >
                  <ShieldAlert size={15} />
                  <span>{b}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Step 2/3 result — statements summary + download */}
      {bundle && (
        <div className="card" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '1rem',
              gap: '0.75rem',
              flexWrap: 'wrap',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '1.1rem' }}>
              {fyLabel(fyStartYear)} {finalised ? 'pack' : 'preview'}
            </h2>
            <span
              className={`badge ${finalised ? 'badge-success' : 'badge-neutral'}`}
              style={{ textTransform: 'none' }}
            >
              {finalised ? 'Finalised — periods locked' : 'Preview — books unchanged'}
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
              gap: '0.75rem',
              marginBottom: '1.25rem',
            }}
          >
            <Stat
              label="Net profit"
              value={formatMoney(bundle.statements.profit_and_loss.net_profit_cents)}
              strong
            />
            <Stat
              label="Total assets"
              value={formatMoney(bundle.statements.balance_sheet.total_assets_cents)}
            />
            <Stat
              label="Total liabilities"
              value={formatMoney(bundle.statements.balance_sheet.total_liabilities_cents)}
            />
            <Stat
              label="Balance sheet"
              value={bundle.statements.balance_sheet.balances ? 'Balances' : 'Out of balance'}
              warn={!bundle.statements.balance_sheet.balances}
            />
          </div>

          {/* Integrity checks */}
          <div style={{ marginBottom: '1.25rem' }}>
            <Check ok={bundle.statements.balance_sheet.balances} label="Balance sheet balances" />
            <Check
              ok={bundle.equity_and_cash_flow.statement_of_changes_in_equity.reconciles}
              label="Statement of changes in equity reconciles"
            />
            <Check
              ok={bundle.equity_and_cash_flow.cash_flow_statement.ties_to_gl}
              label="Cash-flow statement ties to the general ledger"
            />
            <Check
              ok={bundle.notes.notes.depreciation.ties_to_gl}
              label="Depreciation note ties to the GL"
            />
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-secondary" onClick={downloadPdf} disabled={!pdfBase64}>
              <FileText size={14} />
              <span>Download PDF</span>
            </button>
            <button className="btn btn-secondary" onClick={downloadJson}>
              <FileJson size={14} />
              <span>Download data (JSON)</span>
            </button>
            {bundle.working_papers.length > 0 && (
              <span
                style={{
                  color: 'var(--text-muted)',
                  fontSize: '0.8rem',
                  display: 'inline-flex',
                  gap: '0.35rem',
                  alignItems: 'center',
                }}
              >
                <Download size={13} />
                {bundle.working_papers.length} working paper
                {bundle.working_papers.length === 1 ? '' : 's'} in the pack
              </span>
            )}
          </div>

          {!pdfBase64 && (
            <p
              style={{
                color: 'var(--text-muted)',
                fontSize: '0.8rem',
                marginTop: '0.75rem',
                marginBottom: 0,
              }}
            >
              The PDF could not be generated for this pack — download the data (JSON) instead.
            </p>
          )}

          {!finalised && (
            <p
              style={{
                color: 'var(--text-muted)',
                fontSize: '0.8rem',
                marginTop: '1rem',
                marginBottom: 0,
              }}
            >
              This is a read-only preview. Use <strong>Generate pack</strong> above to run the
              year-end true-up and produce the final, period-locked pack.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function StepPill({
  n,
  label,
  active,
  done,
}: {
  n: number;
  label: string;
  active: boolean;
  done: boolean;
}) {
  const color = done
    ? 'var(--accent-success)'
    : active
      ? 'var(--accent-primary)'
      : 'var(--text-muted)';
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.4rem 0.75rem',
        borderRadius: 'var(--radius-sm)',
        border: `1px solid ${active || done ? color : 'var(--border-subtle)'}`,
        background: active ? 'var(--bg-hover)' : 'transparent',
        fontSize: '0.8rem',
        color,
        fontWeight: active || done ? 700 : 500,
      }}
    >
      {done ? <CheckCircle2 size={14} /> : <span>{n}.</span>}
      <span>{label}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  strong,
  warn,
}: {
  label: string;
  value: string;
  strong?: boolean;
  warn?: boolean;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-hover)',
        borderRadius: 'var(--radius-sm)',
        padding: '0.75rem',
      }}
    >
      <div
        style={{
          fontSize: '0.7rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: strong ? '1.25rem' : '1rem',
          fontWeight: strong ? 800 : 600,
          color: warn ? 'var(--text-danger)' : 'var(--text-title)',
          marginTop: '0.2rem',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        fontSize: '0.85rem',
        padding: '0.35rem 0',
        color: ok ? 'var(--text-success)' : 'var(--text-danger)',
      }}
    >
      {ok ? <CheckCircle2 size={15} /> : <ShieldAlert size={15} />}
      <span>{label}</span>
    </div>
  );
}

function Banner({
  tone,
  icon: Icon,
  children,
}: {
  tone: 'warning' | 'danger';
  icon: typeof AlertTriangle;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`badge badge-${tone}`}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.5rem',
        padding: '0.875rem 1rem',
        marginBottom: '1.5rem',
        textTransform: 'none',
        fontSize: '0.875rem',
        lineHeight: '1.4',
        width: '100%',
        justifyContent: 'flex-start',
      }}
    >
      <Icon size={16} style={{ marginTop: '2px', flexShrink: 0 }} />
      <span>{children}</span>
    </div>
  );
}
