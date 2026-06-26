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
            border: '1px solid #1a3d6b',
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
            color: '#e9a3a3',
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
      return { label: 'synced', colour: '#86c7a3', bg: '#0d2f1f' };
    case 'failed':
    case 'error':
      return { label: status, colour: '#e9a3a3', bg: '#3d1818' };
    case 'pending':
      return { label: 'pending', colour: '#d2c886', bg: '#2a2510' };
    case 'amended':
      return { label: 'amended', colour: '#86b4c7', bg: '#0d1f2f' };
    case 'voided':
      return { label: 'voided', colour: '#888', bg: '#1a1a1a' };
    case null:
    default:
      return { label: status ?? '—', colour: '#666', bg: '#1a1a1a' };
  }
}
