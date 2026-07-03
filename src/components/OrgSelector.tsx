import { useState, type FormEvent } from 'react';
import { useOrg } from '@/hooks/useOrg';
import { SkeletonLine } from '@/components/Skeleton';

export function OrgSelector() {
  const {
    organizations,
    currentOrg,
    setCurrentOrg,
    createOrganization,
    loading,
    isAccountantOnly,
  } = useOrg();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) {
    return (
      <div style={{ padding: '0.75rem' }} aria-busy="true" aria-label="Loading organisations">
        <SkeletonLine width="100%" height={14} />
      </div>
    );
  }

  if (organizations.length === 0 && !creating) {
    return (
      <div style={{ background: '#1a1a1a', padding: '0.75rem', borderRadius: 6 }}>
        <div style={{ fontSize: 13, color: '#aaa', marginBottom: '0.5rem' }}>
          No organisation yet
        </div>
        <button
          onClick={() => setCreating(true)}
          style={{
            padding: '0.5rem',
            width: '100%',
            background: '#3a3a3a',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Create one
        </button>
      </div>
    );
  }

  if (creating) {
    const onSubmit = async (e: FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      const { error } = await createOrganization(name);
      setBusy(false);
      if (error) {
        setError(error.message);
        return;
      }
      setCreating(false);
      setName('');
    };
    return (
      <form
        onSubmit={onSubmit}
        style={{ background: '#1a1a1a', padding: '0.75rem', borderRadius: 6 }}
      >
        <input
          type="text"
          placeholder="Business name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          minLength={2}
          style={{
            width: '100%',
            padding: '0.4rem',
            background: '#2a2a2a',
            color: '#fff',
            border: '1px solid #444',
            borderRadius: 4,
            marginBottom: '0.5rem',
          }}
        />
        {error && (
          <div style={{ color: 'salmon', fontSize: 12, marginBottom: '0.5rem' }}>{error}</div>
        )}
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          <button type="submit" disabled={busy} style={{ flex: 1, padding: '0.4rem' }}>
            {busy ? 'Creating…' : 'Create'}
          </button>
          {organizations.length > 0 && (
            <button
              type="button"
              onClick={() => setCreating(false)}
              style={{ padding: '0.4rem 0.75rem' }}
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <select
        value={currentOrg?.id ?? ''}
        onChange={(e) => {
          const org = organizations.find((o) => o.id === e.target.value);
          if (org) setCurrentOrg(org);
        }}
        style={{
          width: '100%',
          padding: '0.4rem',
          background: '#2a2a2a',
          color: '#fff',
          border: '1px solid #444',
          borderRadius: 4,
        }}
      >
        {organizations.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      {/* Accountants are non-billable client-only users — never nudge them to
          create their own (billable) org. See docs/ACCOUNTANT_PORTAL.md. */}
      {!isAccountantOnly && (
        <button
          onClick={() => setCreating(true)}
          style={{
            padding: '0.3rem',
            fontSize: 12,
            background: 'transparent',
            color: '#888',
            border: '1px dashed #444',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          + New organisation
        </button>
      )}
    </div>
  );
}
