import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useOrg } from '@/contexts/OrgContext';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OrgRole = 'viewer' | 'employee' | 'accountant' | 'admin' | 'owner';

const ROLE_OPTIONS: OrgRole[] = ['viewer', 'employee', 'accountant', 'admin', 'owner'];

const ROLE_RANK: Record<OrgRole, number> = {
  viewer: 0,
  employee: 1,
  accountant: 2,
  admin: 3,
  owner: 4,
};

function roleLabel(role: OrgRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

interface MemberRow {
  id: string;           // membership id
  user_id: string;
  role: string;         // legacy membership_role
  role_enum: OrgRole | null;
  is_default: boolean;
  invited_at: string | null;
  accepted_at: string | null;
  email?: string | undefined;       // resolved from auth.users via profile join
  full_name?: string | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  background: '#1a1a1a',
  border: '1px solid #333',
  borderRadius: 4,
  color: '#eee',
  padding: '0.4rem 0.6rem',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
};

const btnStyle = (variant: 'primary' | 'ghost' | 'danger' = 'primary'): React.CSSProperties => ({
  padding: '0.35rem 0.9rem',
  borderRadius: 4,
  fontSize: 13,
  cursor: 'pointer',
  border: variant === 'ghost' ? '1px solid #444' : variant === 'danger' ? '1px solid #994' : '1px solid #86c7a3',
  background: variant === 'primary' ? '#86c7a3' : 'transparent',
  color: variant === 'primary' ? '#111' : variant === 'danger' ? '#c88' : '#aaa',
  fontWeight: variant === 'primary' ? 600 : 400,
});

// ---------------------------------------------------------------------------
// Invite modal
// ---------------------------------------------------------------------------

function InviteModal({
  callerRole,
  onClose,
  onInvited,
}: {
  callerRole: OrgRole;
  onClose: () => void;
  onInvited: () => void;
}) {
  const { currentOrg } = useOrg();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('employee');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const invitableRoles = ROLE_OPTIONS.filter(
    (r) => ROLE_RANK[r] <= ROLE_RANK[callerRole],
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    setResult(null);

    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;

    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/team-invite`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token ?? ''}`,
        },
        body: JSON.stringify({ email, role, organization_id: currentOrg.id }),
      },
    );

    const json = await res.json().catch(() => ({ ok: false, error: 'Bad response' }));
    setLoading(false);

    if (!json.ok) {
      setError(json.error ?? 'Invite failed');
      return;
    }

    setResult(json.message ?? 'Invitation sent.');
    if (json.invite_link) {
      setResult(`${json.message}`);
    }
    onInvited();
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#1a1a1a',
          border: '1px solid #333',
          borderRadius: 8,
          padding: '2rem',
          width: 360,
          maxWidth: '90vw',
        }}
      >
        <h2 style={{ fontSize: 16, marginBottom: '1.25rem' }}>Invite team member</h2>

        {result ? (
          <div style={{ color: '#86c7a3', fontSize: 13, marginBottom: '1rem' }}>{result}</div>
        ) : null}

        {error ? (
          <div style={{ color: '#c88', fontSize: 13, marginBottom: '1rem' }}>{error}</div>
        ) : null}

        <form onSubmit={(e) => { void handleSubmit(e); }}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>
              Email address
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={inputStyle}
              placeholder="name@company.com"
            />
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 4 }}>
              Role
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as OrgRole)}
              style={selectStyle}
            >
              {invitableRoles.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={btnStyle('ghost')}>
              Cancel
            </button>
            <button type="submit" disabled={loading} style={btnStyle('primary')}>
              {loading ? 'Sending…' : 'Send invite'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function TeamPage() {
  const { user } = useAuth();
  const { currentOrg } = useOrg();
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);

  // Resolve the caller's own role for this org
  const callerMember = members.find((m) => m.user_id === user?.id);
  const callerRole: OrgRole = callerMember?.role_enum ?? 'viewer';
  const callerRank = ROLE_RANK[callerRole];
  const isAdminPlus = callerRank >= ROLE_RANK['admin'];

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);

    const { data, error: fetchErr } = await supabase
      .from('organization_memberships')
      .select('id, user_id, role, role_enum, is_default, invited_at, accepted_at')
      .eq('organization_id', currentOrg.id)
      .order('accepted_at', { ascending: false, nullsFirst: false });

    if (fetchErr) {
      setError(fetchErr.message);
      setLoading(false);
      return;
    }

    // Enrich with user emails from the employees table where possible,
    // otherwise fall back to showing user_id.
    const { data: employees } = await supabase
      .from('employees')
      .select('user_id, full_name, email')
      .eq('organization_id', currentOrg.id)
      .not('user_id', 'is', null);

    const empMap = new Map<string, { full_name: string; email: string }>();
    for (const e of employees ?? []) {
      if (e.user_id) {
        empMap.set(e.user_id, { full_name: e.full_name, email: e.email ?? '' });
      }
    }

    const enriched: MemberRow[] = (data ?? []).map((m) => ({
      ...m,
      role_enum: m.role_enum as OrgRole | null,
      email: empMap.get(m.user_id)?.email ?? (user && m.user_id === user.id ? user.email ?? '' : ''),
      full_name: empMap.get(m.user_id)?.full_name,
    }));

    setMembers(enriched);
    setLoading(false);
  }, [currentOrg, user]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRoleChange(memberId: string, newRole: OrgRole) {
    if (!currentOrg) return;
    setUpdating(memberId);

    // Map org_role → legacy membership_role
    const legacyRole =
      newRole === 'accountant'
        ? 'manager'
        : newRole === 'viewer' || newRole === 'employee'
        ? 'member'
        : newRole;

    const { error: updateErr } = await supabase
      .from('organization_memberships')
      .update({ role_enum: newRole, role: legacyRole })
      .eq('id', memberId)
      .eq('organization_id', currentOrg.id);

    setUpdating(null);
    if (updateErr) {
      alert(`Role change failed: ${updateErr.message}`);
      return;
    }
    await load();
  }

  async function handleRemove(memberId: string, targetUserId: string) {
    if (!currentOrg) return;
    const confirmed = window.confirm('Remove this member from the organisation?');
    if (!confirmed) return;

    setRemoving(memberId);
    const { error: delErr } = await supabase
      .from('organization_memberships')
      .delete()
      .eq('id', memberId)
      .eq('organization_id', currentOrg.id);

    setRemoving(null);
    if (delErr) {
      alert(`Remove failed: ${delErr.message}`);
      return;
    }
    if (targetUserId === user?.id) {
      // Just removed self — org will reload
      window.location.href = '/';
      return;
    }
    await load();
  }

  if (!currentOrg) {
    return (
      <section>
        <h1>Team</h1>
        <p style={{ color: '#888' }}>Select an organisation first.</p>
      </section>
    );
  }

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0 }}>Team</h1>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <Link
            to="/settings/audit-log"
            style={{ color: '#86c7a3', fontSize: 13 }}
          >
            Audit log &rarr;
          </Link>
          {isAdminPlus && (
            <button style={btnStyle('primary')} onClick={() => setShowInvite(true)}>
              Invite member
            </button>
          )}
        </div>
      </div>

      {error && (
        <p style={{ color: '#c88', fontSize: 13, marginBottom: '1rem' }}>{error}</p>
      )}

      {loading ? (
        <p style={{ color: '#888', fontSize: 13 }}>Loading members…</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2a2a2a', color: '#666', textAlign: 'left' }}>
                <th style={{ padding: '0.5rem 0.75rem' }}>Member</th>
                <th style={{ padding: '0.5rem 0.75rem' }}>Role</th>
                <th style={{ padding: '0.5rem 0.75rem' }}>Status</th>
                <th style={{ padding: '0.5rem 0.75rem' }}>Invited</th>
                {isAdminPlus && (
                  <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Actions</th>
                )}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const isMe = m.user_id === user?.id;
                const memberRole = m.role_enum ?? 'viewer';
                const memberRank = ROLE_RANK[memberRole];
                const canEdit = isAdminPlus && !isMe && memberRank < callerRank;
                const isPending = !m.accepted_at;

                return (
                  <tr
                    key={m.id}
                    style={{ borderBottom: '1px solid #1e1e1e' }}
                  >
                    <td style={{ padding: '0.6rem 0.75rem' }}>
                      <div style={{ color: m.full_name ? '#eee' : '#888' }}>
                        {m.full_name ?? (isMe ? 'You' : m.user_id.slice(0, 8) + '…')}
                      </div>
                      {m.email && (
                        <div style={{ color: '#666', fontSize: 11 }}>{m.email}</div>
                      )}
                    </td>
                    <td style={{ padding: '0.6rem 0.75rem' }}>
                      {canEdit ? (
                        <select
                          value={memberRole}
                          disabled={updating === m.id}
                          onChange={(e) =>
                            void handleRoleChange(m.id, e.target.value as OrgRole)
                          }
                          style={{ ...selectStyle, width: 'auto' }}
                        >
                          {ROLE_OPTIONS.filter((r) => ROLE_RANK[r] < callerRank).map(
                            (r) => (
                              <option key={r} value={r}>
                                {roleLabel(r)}
                              </option>
                            ),
                          )}
                        </select>
                      ) : (
                        <span
                          style={{
                            background: '#2a2a2a',
                            padding: '0.2rem 0.5rem',
                            borderRadius: 3,
                            color: memberRole === 'owner' ? '#86c7a3' : '#aaa',
                          }}
                        >
                          {roleLabel(memberRole)}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '0.6rem 0.75rem' }}>
                      <span
                        style={{
                          color: isPending ? '#d2c886' : '#86c7a3',
                          fontSize: 12,
                        }}
                      >
                        {isPending ? 'Pending' : 'Active'}
                      </span>
                    </td>
                    <td style={{ padding: '0.6rem 0.75rem', color: '#666', fontSize: 12 }}>
                      {m.invited_at
                        ? new Date(m.invited_at).toLocaleDateString()
                        : '—'}
                    </td>
                    {isAdminPlus && (
                      <td style={{ padding: '0.6rem 0.75rem', textAlign: 'right' }}>
                        {(canEdit || isMe) && (
                          <button
                            disabled={removing === m.id}
                            onClick={() => void handleRemove(m.id, m.user_id)}
                            style={btnStyle('danger')}
                          >
                            {removing === m.id
                              ? 'Removing…'
                              : isMe
                              ? 'Leave'
                              : 'Remove'}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>

          {members.length === 0 && (
            <p style={{ color: '#888', fontSize: 13, marginTop: '1rem' }}>
              No members found.
            </p>
          )}
        </div>
      )}

      {showInvite && (
        <InviteModal
          callerRole={callerRole}
          onClose={() => setShowInvite(false)}
          onInvited={() => {
            setShowInvite(false);
            void load();
          }}
        />
      )}
    </section>
  );
}
