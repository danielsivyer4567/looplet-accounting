/**
 * XeroStatusPill — shows a coloured status badge for a record's Xero sync state.
 * Also renders a "Re-push to Xero" button when status is error/null/failed.
 *
 * Props:
 *   xeroStatus  — the raw value from bills.xero_status / invoices.xero_status
 *   lastError   — error message stored in metadata.last_xero_error (tooltip)
 *   onRepush    — async callback to trigger the push; caller handles the fetch
 *   repushBusy  — true while the push is in-flight
 */

interface XeroStatusPillProps {
  xeroStatus: string | null | undefined;
  lastError?: string | null;
  onRepush?: () => void | Promise<void>;
  repushBusy?: boolean;
}

export function XeroStatusPill({
  xeroStatus,
  lastError,
  onRepush,
  repushBusy,
}: XeroStatusPillProps) {
  const status = xeroStatus ?? null;

  const { label, colour, bg } = resolveStyle(status);
  const showRepush =
    onRepush &&
    (status === null || status === 'failed' || status === 'error' || status === 'pending');

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span
        title={lastError ?? undefined}
        style={{
          display: 'inline-block',
          padding: '0.15rem 0.5rem',
          fontSize: 11,
          borderRadius: 3,
          background: bg,
          color: colour,
          textTransform: 'uppercase',
          cursor: lastError ? 'help' : 'default',
          userSelect: 'none',
        }}
      >
        {label}
      </span>
      {showRepush && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            void onRepush();
          }}
          disabled={repushBusy}
          style={{
            padding: '0.1rem 0.5rem',
            background: 'transparent',
            color: '#1ab4d7',
            border: '1px solid var(--border-info)',
            borderRadius: 3,
            fontSize: 11,
            cursor: repushBusy ? 'wait' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {repushBusy ? 'Pushing…' : 'Re-push'}
        </button>
      )}
      {status === 'failed' && lastError && (
        <span
          style={{
            display: 'block',
            fontSize: 10,
            color: 'var(--text-danger)',
            maxWidth: 240,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={lastError}
        >
          {lastError}
        </span>
      )}
    </span>
  );
}

function resolveStyle(status: string | null): { label: string; colour: string; bg: string } {
  switch (status) {
    case 'synced':
      return { label: 'synced', colour: 'var(--text-success)', bg: 'var(--bg-success-subtle)' };
    case 'failed':
    case 'error':
      return { label: status, colour: 'var(--text-danger)', bg: 'var(--bg-danger-subtle)' };
    case 'pending':
      return { label: 'pending', colour: 'var(--text-warning)', bg: 'var(--bg-warning-subtle)' };
    case 'amended':
      return { label: 'amended', colour: 'var(--text-info)', bg: 'var(--bg-info-subtle)' };
    case 'voided':
      return { label: 'voided', colour: 'var(--text-muted)', bg: 'var(--bg-hover)' };
    case null:
    default:
      return { label: status ?? '—', colour: 'var(--text-muted)', bg: 'var(--bg-hover)' };
  }
}
