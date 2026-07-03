import { useNavigate } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import type { Organization } from '@/contexts/org-context';
import { Building2, ArrowRight } from 'lucide-react';

const ENTITY_LABELS: Record<string, string> = {
  sole_trader: 'Sole trader',
  partnership: 'Partnership',
  company: 'Company',
  trust: 'Trust',
  other: 'Other',
};

function entityLabel(entity_type: string | null | undefined): string {
  if (!entity_type) return 'Entity type not set';
  return ENTITY_LABELS[entity_type] ?? entity_type;
}

/**
 * Accountant client picker. Lists every org the caller can see as an accountant.
 * Clicking a card switches the active org then drops into that client's home,
 * so an accountant works inside the client's books with one click.
 */
export function ClientsPage() {
  const { accountantClientOrgs, currentOrg, setCurrentOrg, loading } = useOrg();
  const navigate = useNavigate();

  const openClient = (org: Organization) => {
    setCurrentOrg(org);
    navigate('/');
  };

  if (loading) {
    return <div style={{ color: 'var(--text-muted)' }}>Loading clients…</div>;
  }

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-title)' }}>
          Clients
        </h1>
        <p style={{ margin: '0.35rem 0 0', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          {accountantClientOrgs.length === 1
            ? '1 client'
            : `${accountantClientOrgs.length} clients`}{' '}
          you manage as an accountant. Select one to open their books.
        </p>
      </div>

      {accountantClientOrgs.length === 0 ? (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: '2rem',
            textAlign: 'center',
            color: 'var(--text-muted)',
          }}
        >
          No clients yet. When a business invites you as their accountant and you accept, they'll
          appear here.
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: '1rem',
          }}
        >
          {accountantClientOrgs.map((org) => {
            const isCurrent = org.id === currentOrg?.id;
            return (
              <button
                key={org.id}
                onClick={() => openClient(org)}
                style={{
                  textAlign: 'left',
                  background: 'var(--bg-card)',
                  border: `1px solid ${isCurrent ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                  borderRadius: 'var(--radius-md)',
                  padding: '1.1rem',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.6rem',
                  transition: 'var(--transition-smooth)',
                  boxShadow: 'var(--shadow-sm)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <span
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-app)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--accent-primary)',
                      flexShrink: 0,
                    }}
                  >
                    <Building2 size={18} />
                  </span>
                  <span
                    style={{
                      fontWeight: 700,
                      color: 'var(--text-title)',
                      fontSize: '1rem',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {org.name}
                  </span>
                </div>

                <div style={{ fontSize: '0.82rem', color: 'var(--text-body)' }}>
                  {entityLabel(org.entity_type)}
                </div>
                <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                  {org.abn ? `ABN ${org.abn}` : 'ABN not set'}
                </div>

                <div
                  style={{
                    marginTop: '0.25rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    color: 'var(--accent-primary)',
                    fontSize: '0.82rem',
                    fontWeight: 600,
                  }}
                >
                  {isCurrent ? 'Current — open' : 'Open books'}
                  <ArrowRight size={14} />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
