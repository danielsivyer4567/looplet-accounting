import { Link } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ShoppingCart,
  Users,
  FileWarning,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

interface Intent {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  to: string;
}

const intents: Intent[] = [
  {
    id: 'get-paid',
    label: 'Get paid',
    description: 'Create invoices, track payments',
    icon: ArrowDownToLine,
    to: '/invoices',
  },
  {
    id: 'pay-bill',
    label: 'Pay a bill',
    description: 'Upload bills, approve, pay',
    icon: ArrowUpFromLine,
    to: '/bills',
  },
  {
    id: 'buy-gear',
    label: 'Buy gear',
    description: 'Record purchases, fixed assets',
    icon: ShoppingCart,
    to: '/bills/upload',
  },
  {
    id: 'run-payday',
    label: 'Run payday',
    description: 'Process payroll and super',
    icon: Users,
    to: '/payroll',
  },
  {
    id: 'file-tax',
    label: 'File tax',
    description: 'Lodge BAS, tax returns',
    icon: FileWarning,
    to: '/lodgements',
  },
  {
    id: 'fix-books',
    label: 'Fix books',
    description: 'Review coding, reconcile accounts',
    icon: Wrench,
    to: '/quality',
  },
];

export function IntentLauncher() {
  return (
    <section aria-label="Quick actions">
      <h2 style={{ margin: '0 0 0.75rem', color: 'var(--text-title)', fontSize: '1rem' }}>
        What would you like to do?
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '0.5rem',
        }}
      >
        {intents.map((intent) => {
          const Icon = intent.icon;
          return (
            <Link
              key={intent.id}
              to={intent.to}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.35rem',
                padding: '1rem',
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                boxShadow: 'var(--shadow-sm)',
                textDecoration: 'none',
                transition: 'var(--transition-smooth)',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.boxShadow = 'var(--shadow-md)';
                e.currentTarget.style.borderColor = 'var(--accent-primary)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = '';
                e.currentTarget.style.boxShadow = '';
                e.currentTarget.style.borderColor = '';
              }}
            >
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-app)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--accent-primary)',
                }}
              >
                <Icon size={18} />
              </div>
              <span
                style={{
                  fontWeight: 600,
                  color: 'var(--text-title)',
                  fontSize: '0.85rem',
                }}
              >
                {intent.label}
              </span>
              <span
                style={{
                  fontSize: '0.7rem',
                  color: 'var(--text-muted)',
                  lineHeight: 1.3,
                }}
              >
                {intent.description}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
