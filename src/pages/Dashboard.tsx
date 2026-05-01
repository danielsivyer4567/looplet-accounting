import { useOrg } from '@/contexts/OrgContext';

export function DashboardPage() {
  const { currentOrg } = useOrg();

  if (!currentOrg) {
    return (
      <section>
        <h1>Welcome to Looplet Accounting</h1>
        <p style={{ color: '#aaa' }}>
          Create your first organisation in the sidebar to get started. Each organisation is fully
          isolated — its bills, jobs, employees, and Xero connection are yours alone.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h1>{currentOrg.name}</h1>
      <p style={{ color: '#aaa' }}>
        Once Phase 4 lands, this dashboard shows your real-time per-job profit, GST set-aside, tax
        set-aside, daily overhead share, and "what's really yours" headline number.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '1rem',
          marginTop: '2rem',
        }}
      >
        {[
          { label: "What's really yours (YTD)", value: '—', hint: 'Phase 4' },
          { label: 'GST set-aside (this quarter)', value: '—', hint: 'Phase 4' },
          { label: 'Tax set-aside (YTD)', value: '—', hint: 'Phase 4' },
          { label: 'Active jobs', value: '0', hint: 'Phase 3' },
          { label: 'Bills awaiting attachment', value: '0', hint: 'Phase 3' },
          { label: 'Overdue customer invoices', value: '0', hint: 'Phase 4' },
        ].map((card) => (
          <div
            key={card.label}
            style={{
              padding: '1rem',
              background: '#1a1a1a',
              borderRadius: 6,
              border: '1px solid #2a2a2a',
            }}
          >
            <div style={{ fontSize: 12, color: '#888', marginBottom: '0.5rem' }}>{card.label}</div>
            <div style={{ fontSize: 28, fontWeight: 600 }}>{card.value}</div>
            <div style={{ fontSize: 11, color: '#555', marginTop: '0.5rem' }}>{card.hint}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
