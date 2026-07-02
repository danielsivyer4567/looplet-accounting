import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

const ROADMAP_ITEMS = [
  {
    title: 'Live proof gates',
    body: 'Apply and verify pending Supabase migrations, then rerun signed-in smoke tests with real fixture IDs.',
    links: [
      { label: 'Quality queue', to: '/quality' },
      { label: 'Lodgements', to: '/lodgements' },
    ],
  },
  {
    title: 'Data-starvation cleanup',
    body: 'Import queued bank statements, process triage rows into rules, and seed live invoices, employees, subscriptions, debts, and timesheets.',
    links: [
      { label: 'Allocations', to: '/allocations' },
      { label: 'Onboarding triage', to: '/onboarding/triage' },
    ],
  },
  {
    title: 'External-provider proof',
    body: 'Capture accepted live or stub-mode evidence for Gmail, Basiq, Xero, ATO/SBR, and MiniMax classifier paths.',
    links: [
      { label: 'Settings', to: '/settings' },
      { label: 'Legal horizon', to: '/legal-horizon' },
    ],
  },
  {
    title: 'Product polish',
    body: 'Finish page-level mobile checks, report export polish, specific error messaging, and signed-in screenshots for critical flows.',
    links: [
      { label: 'Reports', to: '/reports' },
      { label: 'Subscriptions', to: '/subscriptions' },
    ],
  },
];

export function RoadmapPage() {
  return (
    <section className="animated-fade-in" style={{ display: 'grid', gap: '1.25rem' }}>
      <div>
        <h1 style={{ margin: 0 }}>Roadmap</h1>
        <p style={{ color: 'var(--text-muted)', maxWidth: '760px', marginTop: '0.5rem' }}>
          Working release gates for Looplet Accounting. The source ledger remains
          docs/remaining-work-todo.md and docs/COMPLETION_AUDIT.md; this page exposes the next
          app-facing actions as links instead of a static settings note.
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: '1rem',
        }}
      >
        {ROADMAP_ITEMS.map((item) => (
          <article key={item.title} className="card" style={{ display: 'grid', gap: '0.8rem' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '1rem' }}>{item.title}</h2>
              <p
                style={{
                  color: 'var(--text-muted)',
                  fontSize: '0.85rem',
                  lineHeight: 1.5,
                  margin: '0.45rem 0 0',
                }}
              >
                {item.body}
              </p>
            </div>
            <div style={{ display: 'grid', gap: '0.35rem' }}>
              {item.links.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.5rem',
                    color: 'var(--accent-primary)',
                    fontSize: '0.825rem',
                    fontWeight: 700,
                    textDecoration: 'none',
                  }}
                >
                  <span>{link.label}</span>
                  <ChevronRight size={14} />
                </Link>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
