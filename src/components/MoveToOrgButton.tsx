import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';

interface Props {
  /** Table to update (e.g. 'bills', 'subscriptions', 'invoices'). */
  table: 'bills' | 'subscriptions' | 'invoices' | 'jobs' | 'suppliers' | 'customers';
  /** Row id to move. */
  rowId: string;
  /** Current organization_id of the row. Used to filter the dropdown. */
  currentOrgId: string;
  /**
   * Foreign keys to NULL out when moving (since they reference the source org's records).
   * For bills: ['supplier_id', 'job_id', 'suggested_job_id']. For subscriptions: ['supplier_id'].
   * The user re-links in the target org.
   */
  fkColumnsToNull?: string[];
  /** Optional label override. */
  label?: string;
  /** Called after successful move. */
  onMoved?: (newOrgId: string) => void;
}

/**
 * Reusable cross-org allocation control. Drop in next to Edit / Personal toggles.
 * Lets a user route a row from one of their businesses to another.
 *
 * RLS handles the auth: user can only target orgs they're a member of.
 * We NULL out FK columns that point at source-org rows so they don't dangle.
 */
export function MoveToOrgButton({ table, rowId, currentOrgId, fkColumnsToNull = [], label, onMoved }: Props) {
  const { organizations } = useOrg();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const targets = organizations.filter((o) => o.id !== currentOrgId);
  if (targets.length === 0) return null;

  const move = async (targetOrgId: string, targetName: string) => {
    if (!confirm(`Move this ${table.replace(/s$/, '')} to "${targetName}"?\n\nForeign-key links (supplier, job, suggestion) will be cleared so you can re-link in the target business.`)) return;
    setBusy(true);
    setErr(null);
    const patch: Record<string, unknown> = { organization_id: targetOrgId };
    for (const col of fkColumnsToNull) patch[col] = null;
    const { error } = await supabase.from(table).update(patch).eq('id', rowId);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setOpen(false);
    onMoved?.(targetOrgId);
  };

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(!open)}
        disabled={busy}
        style={{
          padding: '0.3rem 0.75rem',
          background: 'transparent',
          color: '#aaa',
          border: '1px solid #333',
          borderRadius: 3,
          fontSize: 12,
          cursor: busy ? 'wait' : 'pointer',
        }}
        title="Move to a different business / organisation"
      >
        {busy ? 'Moving…' : (label ?? '⇄ Move to business')}
      </button>
      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: 4,
          minWidth: 220,
          background: '#1a1a1a',
          border: '1px solid #2a2a2a',
          borderRadius: 4,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          zIndex: 100,
        }}>
          <div style={{ padding: '0.4rem 0.75rem', fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #2a2a2a' }}>
            Move to…
          </div>
          {targets.map((o) => (
            <button
              key={o.id}
              onClick={() => move(o.id, o.name)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '0.5rem 0.75rem',
                background: 'transparent',
                color: '#ddd',
                border: 'none',
                borderBottom: '1px solid #1a1a1a',
                fontSize: 13,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#222'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
            >
              {o.name}
              <div style={{ fontSize: 10, color: '#666' }}>{o.organization_type}</div>
            </button>
          ))}
          <button
            onClick={() => setOpen(false)}
            style={{
              display: 'block', width: '100%', textAlign: 'center',
              padding: '0.4rem', background: 'transparent', color: '#666',
              border: 'none', fontSize: 11, cursor: 'pointer',
            }}
          >
            cancel
          </button>
          {err && <p style={{ margin: 0, padding: '0.4rem 0.75rem', color: 'salmon', fontSize: 11 }}>{err}</p>}
        </div>
      )}
    </div>
  );
}
