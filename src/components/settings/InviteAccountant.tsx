/**
 * InviteAccountant — client-facing CTA card.
 *
 * Lets a business owner/admin invite their accountant by email. Posts to the
 * `team-invite` edge function with role:'accountant'. The invitee receives a
 * magic link that lands on /accept-invite (see SC-1B/1C), where they set a
 * password and accept_pending_invites() grants their cross-tenant membership.
 *
 * Accountants are non-billable members (see docs/ACCOUNTANT_PORTAL.md), so this
 * is surfaced as a low-friction card rather than the full team-invite modal.
 */

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { UserPlus } from 'lucide-react';

export function InviteAccountant() {
  const { currentOrg } = useOrg();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  if (!currentOrg) return null;

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
      body: JSON.stringify({
        email: email.trim(),
        role: 'accountant',
        organization_id: currentOrg.id,
      }),
    });

    const json = await res.json().catch(() => ({ ok: false, error: 'Bad response' }));
    setLoading(false);

    if (!json.ok) {
      setError(json.error ?? 'Invite failed');
      return;
    }

    setResult(json.message ?? 'Invitation sent.');
    setEmail('');
  }

  return (
    <div>
      <h2
        style={{
          fontSize: '1.15rem',
          marginBottom: '0.35rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
        }}
      >
        <UserPlus size={18} style={{ color: 'var(--text-link)' }} />
        Invite your accountant
      </h2>
      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.825rem',
          lineHeight: 1.5,
          marginBottom: '1rem',
        }}
      >
        Give your accountant secure access to this business. They can review your books across all
        the clients they manage — at no extra cost to you.
      </p>

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
        style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}
      >
        <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}>
          <label
            className="form-label"
            htmlFor="invite-accountant-email"
            style={{ fontSize: '0.725rem' }}
          >
            Accountant email
          </label>
          <input
            id="invite-accountant-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="form-input"
            style={{ marginTop: '0.25rem' }}
            placeholder="accountant@firm.com.au"
          />
        </div>
        <button type="submit" disabled={loading} className="btn btn-primary">
          {loading ? 'Sending…' : 'Send invite'}
        </button>
      </form>
    </div>
  );
}
