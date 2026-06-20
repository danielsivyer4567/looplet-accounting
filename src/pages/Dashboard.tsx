import { useOrg } from '@/hooks/useOrg';
import { useRealtimePnl } from '@/hooks/useRealtimePnl';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { SkeletonCard } from '@/components/Skeleton';

export function DashboardPage() {
  const { currentOrg } = useOrg();
  const { pnl, loading, error } = useRealtimePnl();

  if (!currentOrg) {
    return (
      <section>
        <h1>Welcome to Looplet Accounting</h1>
        <p style={{ color: '#aaa' }}>
          Create your first organisation in the sidebar to get started. Each organisation is fully
          isolated — bills, jobs, employees, and Xero connection are yours alone.
        </p>
      </section>
    );
  }

  if (loading) {
    return (
      <section>
        <h1 style={{ color: '#666', background: '#1a1a1a', borderRadius: 4, width: 180, height: 28, margin: '0 0 1rem' }} />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '1rem',
            marginBottom: '2rem',
          }}
        >
          {Array.from({ length: 7 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </section>
    );
  }
  if (error) return <p style={{ color: 'salmon' }}>Failed to load: {error}</p>;

  const data = pnl ?? {
    revenue_inc_gst_cents: 0,
    cost_bills_cents: 0,
    cost_wages_cents: 0,
    cost_overhead_cents: 0,
    total_cost_cents: 0,
    gross_profit_cents: 0,
    gst_set_aside_cents: 0,
    tax_set_aside_cents: 0,
    really_yours_cents: 0,
  };

  return (
    <section>
      <h1>{currentOrg.name}</h1>
      <p style={{ color: '#888', fontSize: 14 }}>Across your whole business — all invoices and bills to date.</p>

      <div
        style={{
          padding: '2rem',
          background: '#0d2f1f',
          borderRadius: 8,
          border: '1px solid #1c5135',
          marginBottom: '2rem',
        }}
      >
        <div
          style={{ fontSize: 12, color: '#86c7a3', textTransform: 'uppercase', letterSpacing: 1 }}
        >
          What's really yours (to date)
        </div>
        <div style={{ fontSize: 48, fontWeight: 700, marginTop: '0.5rem' }}>
          {formatMoney(data.really_yours_cents)}
        </div>
        <div style={{ fontSize: 12, color: '#5e8d72', marginTop: '0.5rem' }}>
          Gross profit minus GST set-aside minus income tax set-aside.
          <br />
          Estimate — confirm with your accountant.
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '1rem',
        }}
      >
        <Card label="Revenue (inc GST)" value={data.revenue_inc_gst_cents} positive />
        <Card label="Cost — bills" value={-data.cost_bills_cents} />
        <Card label="Cost — wages (loaded)" value={-data.cost_wages_cents} />
        <Card label="Cost — overhead share" value={-data.cost_overhead_cents} />
        <Card label="Gross profit" value={data.gross_profit_cents} positive />
        <Card label="GST set-aside" value={-data.gst_set_aside_cents} hint="Quarter total" />
        <Card label="Tax set-aside (est.)" value={-data.tax_set_aside_cents} hint="Annual est." />
      </div>

      <p style={{ color: '#666', fontSize: 12, marginTop: '1.5rem' }}>
        Every number above is computed in real time from{' '}
        <code>v_organization_realtime_pnl</code> on Supabase. No reconciliation, no Xero
        round-trip.
      </p>
    </section>
  );
}

function Card({
  label,
  value,
  hint,
  positive,
}: {
  label: string;
  value: number;
  hint?: string;
  positive?: boolean;
}) {
  const colour = positive ? '#86c7a3' : value < 0 ? '#e9a3a3' : '#aaa';
  return (
    <div
      style={{
        padding: '1rem',
        background: '#1a1a1a',
        borderRadius: 6,
        border: '1px solid #2a2a2a',
      }}
    >
      <div
        style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}
      >
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: '0.4rem', color: colour }}>
        {formatMoneyCompact(value)}
      </div>
      {hint && <div style={{ fontSize: 11, color: '#555', marginTop: '0.4rem' }}>{hint}</div>}
    </div>
  );
}
