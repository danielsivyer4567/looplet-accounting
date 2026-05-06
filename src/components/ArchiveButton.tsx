import { useState } from 'react';
import { supabase } from '@/lib/supabase';

type ArchivableTable = 'suppliers' | 'customers' | 'jobs' | 'bills' | 'invoices' | 'subscriptions';

interface ArchiveButtonProps {
  /** Supabase table name to update. */
  table: ArchivableTable;
  /** Primary-key value of the row to archive / restore. */
  rowId: string;
  /**
   * Current archive state.
   * Pass true when the row's deleted_at is non-null (already archived).
   * Pass false when the row is active.
   */
  isArchived: boolean;
  /**
   * Called after the DB write succeeds.
   * Receives the new archived state so the caller can redirect or refresh.
   */
  onChange: (nowArchived: boolean) => void;
}

/**
 * Toggles `deleted_at` on a row — archive sets it to now(), restore clears it.
 *
 * Usage:
 *   <ArchiveButton
 *     table="suppliers"
 *     rowId={supplier.id}
 *     isArchived={!!supplier.deleted_at}
 *     onChange={(archived) => archived ? (window.location.href = '/suppliers') : refresh()}
 *   />
 */
export function ArchiveButton({ table, rowId, isArchived, onChange }: ArchiveButtonProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const label = isArchived ? 'Restore' : 'Archive';
  const confirmMsg = isArchived
    ? `Restore this ${table.replace(/s$/, '')}? It will reappear in the active list.`
    : `Archive this ${table.replace(/s$/, '')}? It will be hidden from the active list. You can restore it later.`;

  const handleClick = async () => {
    if (!confirm(confirmMsg)) return;
    setBusy(true);
    setErr(null);
    const patch = isArchived
      ? { deleted_at: null }
      : { deleted_at: new Date().toISOString() };
    const { error } = await supabase.from(table).update(patch).eq('id', rowId);
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    onChange(!isArchived);
  };

  return (
    <span style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      <button
        onClick={() => void handleClick()}
        disabled={busy}
        title={isArchived ? 'Restore this record' : 'Archive this record (soft-delete)'}
        style={{
          padding: '0.3rem 0.75rem',
          background: 'transparent',
          color: isArchived ? '#86c7a3' : '#e9a3a3',
          border: `1px solid ${isArchived ? '#2a4a3a' : '#4a2a2a'}`,
          borderRadius: 3,
          fontSize: 12,
          cursor: busy ? 'wait' : 'pointer',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? (isArchived ? 'Restoring…' : 'Archiving…') : label}
      </button>
      {err && (
        <span style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, fontSize: 11, color: 'salmon', whiteSpace: 'nowrap' }}>
          {err}
        </span>
      )}
    </span>
  );
}
