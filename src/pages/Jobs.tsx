import { useNavigate } from 'react-router-dom';
import { useOrg } from '@/contexts/OrgContext';
import { useJobs } from '@/hooks/useJobs';
import type { JobStatus } from '@/hooks/useJobs';

const statusColors: Record<JobStatus, string> = {
  draft: '#888',
  active: '#86c7a3',
  paused: '#d2c886',
  completed: '#7799d6',
  cancelled: '#555',
};

function getBillCount(val: [{ count: number }] | []): number {
  if (val.length === 0) return 0;
  const row = val[0];
  if (!row) return 0;
  return row.count;
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        padding: '1rem 1.5rem',
        background: '#1a1a1a',
        border: '1px solid #2a2a2a',
        borderRadius: 6,
        minWidth: 160,
      }}
    >
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: '#86c7a3', marginTop: '0.3rem' }}>
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function JobsPage() {
  const { currentOrg } = useOrg();
  const { jobs, loading, error } = useJobs();
  const navigate = useNavigate();

  if (!currentOrg) {
    return (
      <section>
        <h1>Jobs</h1>
        <p style={{ color: '#888' }}>Pick an organisation to see jobs.</p>
      </section>
    );
  }

  const activeCount = jobs.filter((j) => j.status === 'active').length;
  const totalAttachedBills = jobs.reduce((sum, j) => sum + getBillCount(j.attached_bills), 0);

  return (
    <section>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Jobs</h1>
        {!loading && (
          <span style={{ color: '#888', fontSize: 13 }}>
            {jobs.length} job{jobs.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Stat cards */}
      {!loading && !error && (
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.75rem', flexWrap: 'wrap' }}>
          <StatCard label="Active jobs" value={activeCount} />
          <StatCard label="Total bills attached" value={totalAttachedBills} />
        </div>
      )}

      {loading ? (
        <p style={{ color: '#888' }}>Loading jobs…</p>
      ) : error ? (
        <p style={{ color: 'salmon' }}>Failed to load: {error}</p>
      ) : jobs.length === 0 ? (
        <p style={{ color: '#888' }}>No jobs yet for {currentOrg.name}.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>Job #</th>
              <th style={th}>Name</th>
              <th style={th}>Status</th>
              <th style={thRight}>Bills attached</th>
              <th style={thRight}>Bills suggested</th>
              <th style={th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const attached = getBillCount(j.attached_bills);
              const suggested = getBillCount(j.suggested_bills);
              const created = new Date(j.created_at).toLocaleDateString('en-AU', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              });
              return (
                <tr
                  key={j.id}
                  style={{ borderBottom: '1px solid #1a1a1a', cursor: 'pointer' }}
                  onClick={() => void navigate(`/jobs/${j.id}`)}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = '#202020';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = '';
                  }}
                >
                  <td style={td}>
                    <code style={{ color: '#888', fontSize: 12 }}>{j.job_number}</code>
                  </td>
                  <td style={{ ...td, fontWeight: 500 }}>{j.name}</td>
                  <td style={td}>
                    <span
                      style={{
                        padding: '0.15rem 0.5rem',
                        fontSize: 11,
                        borderRadius: 3,
                        background: '#222',
                        color: statusColors[j.status],
                        textTransform: 'uppercase',
                      }}
                    >
                      {j.status}
                    </span>
                  </td>
                  <td style={tdRight}>
                    {attached > 0 ? (
                      <span style={{ color: '#86c7a3', fontWeight: 600 }}>{attached}</span>
                    ) : (
                      <span style={{ color: '#444' }}>0</span>
                    )}
                  </td>
                  <td style={tdRight}>
                    {suggested > 0 ? (
                      <span style={{ color: '#d2c886' }}>{suggested}</span>
                    ) : (
                      <span style={{ color: '#444' }}>0</span>
                    )}
                  </td>
                  <td style={{ ...td, color: '#666', fontSize: 13 }}>{created}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

const th: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  textAlign: 'left',
  fontSize: 12,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  fontWeight: 500,
};
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.65rem 0.75rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
