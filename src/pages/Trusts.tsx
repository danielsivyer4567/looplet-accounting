import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import { useTrusts } from '@/hooks/useTrusts';
import { SkeletonTable } from '@/components/Skeleton';
import { titleCase, formatDay } from '@/lib/formatting';
import { Landmark } from 'lucide-react';

// Shared styling for the page's dashed "notice" cards (not-a-trust gate + empty list).
const noticeCardStyle: CSSProperties = {
  padding: '2.5rem',
  background: 'var(--bg-card)',
  border: '1px dashed var(--border-subtle)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--text-muted)',
  textAlign: 'center',
  fontSize: '0.9rem',
};

export function TrustsPage() {
  const navigate = useNavigate();
  const { currentOrg } = useOrg();
  const { trusts, isTrustEntity, loading, error } = useTrusts();

  if (!currentOrg) return null;

  // The Trusts workspace is only relevant when the org is a trust entity
  // (business_profile.entity_type = 'trust'). Show a gentle notice otherwise.
  if (!loading && !isTrustEntity) {
    return (
      <section className="animated-fade-in">
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Landmark size={24} style={{ color: 'var(--accent-primary)' }} />
          Trusts
        </h1>
        <div style={{ ...noticeCardStyle, marginTop: '1.5rem' }}>
          The Trusts workspace applies to trust entities. Set this organisation's entity type to{' '}
          <strong>Trust</strong> in{' '}
          <span
            style={{ color: 'var(--accent-primary)', cursor: 'pointer' }}
            onClick={() => navigate('/settings')}
          >
            Business Profile
          </span>{' '}
          to manage trusts, deeds, and distributions.
        </div>
      </section>
    );
  }

  return (
    <section className="animated-fade-in">
      {/* Header */}
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
          <Landmark size={24} style={{ color: 'var(--accent-primary)' }} />
          Trusts
        </h1>
        {!loading && (
          <div
            className="badge badge-neutral"
            style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', textTransform: 'none' }}
          >
            {trusts.length} {trusts.length === 1 ? 'trust' : 'trusts'}
          </div>
        )}
      </div>

      {loading ? (
        <SkeletonTable rows={4} cols={5} />
      ) : error ? (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
        >
          Failed to load: {error}
        </div>
      ) : trusts.length === 0 ? (
        <div style={noticeCardStyle}>No trusts recorded for {currentOrg.name} yet.</div>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Trustee</th>
                <th>ABN</th>
                <th>Settled</th>
              </tr>
            </thead>
            <tbody>
              {trusts.map((t) => (
                <tr
                  key={t.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/trusts/${t.id}`)}
                >
                  <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>{t.name}</td>
                  <td>
                    <span
                      className="badge badge-neutral"
                      style={{ fontSize: '11px', textTransform: 'none' }}
                    >
                      {titleCase(t.trust_type)}
                    </span>
                  </td>
                  <td>
                    {t.trustee_name ? (
                      <span style={{ fontSize: '0.875rem' }}>
                        {t.trustee_name}
                        {t.is_corporate_trustee ? (
                          <span style={{ color: 'var(--text-muted)' }}> (corporate)</span>
                        ) : null}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td>
                    {t.abn ? (
                      <code>{t.abn}</code>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td>{formatDay(t.settled_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
