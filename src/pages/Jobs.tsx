import { useOrg } from '@/contexts/OrgContext';
import { useJobPnl, type JobPnl } from '@/hooks/useJobPnl';
import { formatMoney } from '@/lib/money';

const statusColors: Record<JobPnl['job_status'], string> = {
  draft: '#888',
  active: '#86c7a3',
  paused: '#d2c886',
  completed: '#7799d6',
  cancelled: '#888',
};

export function JobsPage() {
  const { currentOrg } = useOrg();
  const { jobs, loading, error } = useJobPnl();

  if (!currentOrg) {
    return (
      <section>
        <h1>Jobs</h1>
        <p style={{ color: '#888' }}>Pick an organisation to see jobs.</p>
      </section>
    );
  }
  if (loading) return <p style={{ color: '#888' }}>Loading jobs…</p>;
  if (error) return <p style={{ color: 'salmon' }}>Failed to load: {error}</p>;

  if (jobs.length === 0) {
    return (
      <section>
        <h1>Jobs</h1>
        <p style={{ color: '#888' }}>No jobs yet for {currentOrg.name}.</p>
        <p style={{ color: '#666', fontSize: 14 }}>
          Phase 4.x: Job-creation form lands alongside Bills attachment UI. For now, jobs can be
          inserted directly via SQL on the <code>jobs</code> table.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h1>Jobs</h1>
      <p style={{ color: '#888', fontSize: 14 }}>
        Live per-job P&L from <code>v_job_pnl</code>. Profit = revenue − bills − wages − overhead share.
      </p>
      <table style={{ width: '100%', marginTop: '1.5rem', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
            <th style={th}>Job #</th>
            <th style={th}>Name</th>
            <th style={th}>Status</th>
            <th style={thRight}>Revenue</th>
            <th style={thRight}>Costs</th>
            <th style={thRight}>Profit</th>
            <th style={thRight}>Margin</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const margin =
              j.revenue_inc_gst_cents > 0
                ? (j.gross_profit_cents / j.revenue_inc_gst_cents) * 100
                : 0;
            return (
              <tr key={j.job_id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                <td style={td}>
                  <code style={{ color: '#888' }}>{j.job_number}</code>
                </td>
                <td style={td}>{j.job_name}</td>
                <td style={td}>
                  <span
                    style={{
                      padding: '0.15rem 0.5rem',
                      fontSize: 11,
                      borderRadius: 3,
                      background: '#222',
                      color: statusColors[j.job_status],
                    }}
                  >
                    {j.job_status}
                  </span>
                </td>
                <td style={tdRight}>{formatMoney(j.revenue_inc_gst_cents)}</td>
                <td style={tdRight}>{formatMoney(j.total_cost_cents)}</td>
                <td
                  style={{
                    ...tdRight,
                    color: j.gross_profit_cents >= 0 ? '#86c7a3' : '#e9a3a3',
                    fontWeight: 600,
                  }}
                >
                  {formatMoney(j.gross_profit_cents)}
                </td>
                <td style={{ ...tdRight, color: margin >= 20 ? '#86c7a3' : margin >= 10 ? '#d2c886' : '#e9a3a3' }}>
                  {margin.toFixed(1)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
const td: React.CSSProperties = { padding: '0.65rem 0.75rem', textAlign: 'left' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
