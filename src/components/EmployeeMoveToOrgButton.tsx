import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

interface Props {
  employeeId: string;
  currentOrgId: string;
  onMoved?: (newOrgId: string) => void;
}

export function EmployeeMoveToOrgButton({ employeeId, currentOrgId, onMoved }: Props) {
  const { organizations } = useOrg();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const targets = organizations.filter((o) => o.id !== currentOrgId);
  if (targets.length === 0) return null;

  const move = async (targetOrgId: string, targetName: string) => {
    if (
      !confirm(
        `Move this employee to "${targetName}"?\n\nCurrent timesheets move with the employee and their job links will be cleared. Employees with payroll history cannot be moved.`,
      )
    ) {
      return;
    }

    setBusy(true);
    setErr(null);
    const { error } = await supabase.rpc('move_employee_to_org', {
      p_employee_id: employeeId,
      p_target_org_id: targetOrgId,
    });
    setBusy(false);

    if (error) {
      setErr(error.message);
      return;
    }

    setOpen(false);
    onMoved?.(targetOrgId);
  };

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(!open)}
        disabled={busy}
        className="btn btn-secondary"
        title="Move this employee to another business"
      >
        {busy ? 'Moving…' : '⇄ Move employee'}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 240,
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            zIndex: 100,
          }}
        >
          <div
            style={{
              padding: '0.4rem 0.75rem',
              fontSize: 11,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            Move employee to…
          </div>
          {targets.map((o) => (
            <button
              key={o.id}
              onClick={() => void move(o.id, o.name)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '0.5rem 0.75rem',
                background: 'transparent',
                color: 'var(--text-body)',
                border: 'none',
                borderBottom: '1px solid var(--border-subtle)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              {o.name}
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{o.organization_type}</div>
            </button>
          ))}
          <button
            onClick={() => setOpen(false)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'center',
              padding: '0.4rem',
              background: 'transparent',
              color: 'var(--text-muted)',
              border: 'none',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            cancel
          </button>
          {err && (
            <p style={{ margin: 0, padding: '0.4rem 0.75rem', color: 'var(--text-danger)', fontSize: 11 }}>
              {err}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
