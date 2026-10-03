import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useOrg } from '@/hooks/useOrg';
import { SkeletonTable } from '@/components/Skeleton';
import { ChevronLeft, Users, Plus, Trash2, CheckCircle, Clock } from 'lucide-react';

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
  // Bookkeepers share the same review/approve permissions as accountants —
  // no separate role is needed; invite them using the "Accountant" role.
  if (role === 'accountant') return 'Accountant / Bookkeeper';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

interface MemberRow {
  id: string;
  user_id: string;
  role: string;
  role_enum: OrgRole | null;
  is_default: boolean;
  invited_at: string | null;
  accepted_at: string | null;
  email?: string | undefined;
  full_name?: string | undefined;
}

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

  const invitableRoles = ROLE_OPTIONS.filter((r) => ROLE_RANK[r] <= ROLE_RANK[callerRole]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    setResult(null);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token;

    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/team-invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token ?? ''}`,
      },
      body: JSON.stringify({ email, role, organization_id: currentOrg.id }),
    });

    const json = await res.json().catch(() => ({ ok: false, error: 'Bad response' }));
    setLoading(false);

    if (!json.ok) {
      setError(json.error ?? 'Invite failed');
      return;
    }

    setResult(json.message ?? 'Invitation sent.');
    onInvited();
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--bg-scrim)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 380,
          maxWidth: '90vw',
          padding: '2rem',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <h2
          style={{
            fontSize: '1.25rem',
            marginBottom: '1.25rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          <Users size={20} style={{ color: 'var(--text-link)' }} />
          Invite Team Member
        </h2>

        {result && (
          <div
            className="badge badge-success"
            style={{
              display: 'block',
              padding: '0.5rem',
              marginBottom: '1rem',
              textTransform: 'none',
            }}
          >
            {result}
          </div>
        )}
        {error && (
          <div
            className="badge badge-danger"
            style={{
              display: 'block',
              padding: '0.5rem',
              marginBottom: '1rem',
              textTransform: 'none',
            }}
          >
            {error}
          </div>
        )}

        <form
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
        >
          <div className="form-group" style={{ marginBottom: 0 }}>
            <span className="form-label" style={{ fontSize: '0.725rem' }}>
              Email Address
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="form-input"
              style={{ marginTop: '0.25rem' }}
              placeholder="name@company.com"
            />
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <span className="form-label" style={{ fontSize: '0.725rem' }}>
              Role
            </span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as OrgRole)}
              className="form-select"
              style={{ marginTop: '0.25rem' }}
            >
              {invitableRoles.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
          </div>

          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              justifyContent: 'flex-end',
              marginTop: '0.5rem',
            }}
          >
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={loading} className="btn btn-primary">
              {loading ? 'Sending…' : 'Send Invite'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function TeamPage() {
  const { user } = useAuth();
  const { currentOrg } = useOrg();
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);

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
      email:
        empMap.get(m.user_id)?.email ?? (user && m.user_id === user.id ? (user.email ?? '') : ''),
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
    setError(null);

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
      setError(`Role change failed: ${updateErr.message}`);
      return;
    }
    await load();
  }

  async function handleRemove(memberId: string, targetUserId: string) {
    if (!currentOrg) return;
    const confirmed = window.confirm('Remove this member from the organisation?');
    if (!confirmed) return;

    setRemoving(memberId);
    setError(null);
    const { error: delErr } = await supabase
      .from('organization_memberships')
      .delete()
      .eq('id', memberId)
      .eq('organization_id', currentOrg.id);

    setRemoving(null);
    if (delErr) {
      setError(`Remove failed: ${delErr.message}`);
      return;
    }
    if (targetUserId === user?.id) {
      window.location.href = '/';
      return;
    }
    await load();
  }

  if (!currentOrg) {
    return (
      <section className="animated-fade-in">
        <h1>Team</h1>
        <p style={{ color: 'var(--text-muted)' }}>Select an organisation first.</p>
      </section>
    );
  }

  return (
    <section className="animated-fade-in">
      {/* Back link */}
      <Link
        to="/settings"
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
        <span>Settings</span>
      </Link>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.5rem',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Users size={24} style={{ color: 'var(--text-link)' }} />
          Team Members
        </h1>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {isAdminPlus && (
            <button className="btn btn-primary" onClick={() => setShowInvite(true)}>
              <Plus size={16} />
              <span>Invite member</span>
            </button>
          )}
        </div>
      </div>

      {error && (
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
      )}

      {loading ? (
        <div aria-busy="true" aria-label="Loading team members">
          <SkeletonTable rows={5} cols={isAdminPlus ? 5 : 4} />
        </div>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Status</th>
                <th>Invited</th>
                {isAdminPlus && <th style={{ textAlign: 'right' }}>Actions</th>}
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
                  <tr key={m.id}>
                    <td>
                      <div style={{ color: 'var(--text-title)', fontWeight: 600 }}>
                        {m.full_name ?? (isMe ? 'You' : m.user_id.slice(0, 8) + '…')}
                      </div>
                      {m.email && (
                        <div
                          style={{
                            color: 'var(--text-muted)',
                            fontSize: '0.75rem',
                            marginTop: '0.15rem',
                          }}
                        >
                          {m.email}
                        </div>
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <select
                          value={memberRole}
                          disabled={updating === m.id}
                          onChange={(e) => void handleRoleChange(m.id, e.target.value as OrgRole)}
                          className="form-select"
                          style={{ width: 'auto', padding: '0.35rem 0.5rem', fontSize: '0.825rem' }}
                        >
                          {ROLE_OPTIONS.filter((r) => ROLE_RANK[r] < callerRank).map((r) => (
                            <option key={r} value={r}>
                              {roleLabel(r)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span
                          className={`badge ${memberRole === 'owner' ? 'badge-success' : 'badge-neutral'}`}
                        >
                          {roleLabel(memberRole)}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${isPending ? 'badge-warning' : 'badge-success'}`}>
                        {isPending ? 'Pending' : 'Active'}
                      </span>
                    </td>
                    <td style={{ color: 'var(--text-muted)', fontSize: '0.825rem' }}>
                      {m.invited_at ? (
                        <span
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                        >
                          <Clock size={12} />
                          {new Date(m.invited_at).toLocaleDateString()}
                        </span>
                      ) : (
                        <span
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                        >
                          <CheckCircle size={12} style={{ color: 'var(--accent-success)' }} />
                          Auto-joined
                        </span>
                      )}
                    </td>
                    {isAdminPlus && (
                      <td style={{ textAlign: 'right' }}>
                        {(canEdit || isMe) && (
                          <button
                            disabled={removing === m.id}
                            onClick={() => void handleRemove(m.id, m.user_id)}
                            className="btn btn-secondary"
                            style={{
                              padding: '0.25rem 0.5rem',
                              fontSize: '0.75rem',
                              color: 'var(--text-danger)',
                              borderColor: 'var(--border-danger)',
                            }}
                          >
                            <Trash2 size={12} style={{ marginRight: '0.25rem' }} />
                            <span>
                              {removing === m.id ? 'Removing…' : isMe ? 'Leave' : 'Remove'}
                            </span>
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
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
