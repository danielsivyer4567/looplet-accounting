import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useOrg } from '@/contexts/OrgContext';
import { OrgSelector } from './OrgSelector';

const navItems = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/onboarding', label: 'Auto Setup' },
  { to: '/bills', label: 'Bills' },
  { to: '/invoices', label: 'Invoices' },
  { to: '/allocations', label: 'Allocations' },
  { to: '/reconciliation', label: 'Reconciliation' },
  { to: '/jobs', label: 'Jobs' },
  { to: '/customers', label: 'Customers' },
  { to: '/suppliers', label: 'Suppliers' },
  { to: '/employees', label: 'Employees' },
  { to: '/subscriptions', label: 'Subscriptions' },
  { to: '/reports', label: 'Reports' },
  { to: '/settings', label: 'Settings' },
];

export function Layout() {
  const { user, signOut } = useAuth();
  const { currentOrg } = useOrg();

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside
        style={{
          width: 220,
          background: '#111',
          padding: '1.5rem 1rem',
          borderRight: '1px solid #2a2a2a',
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: '1.5rem' }}>Looplet Accounting</div>
        <OrgSelector />
        <nav style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end ?? false}
              style={({ isActive }) => ({
                padding: '0.5rem 0.75rem',
                borderRadius: 4,
                textDecoration: 'none',
                color: isActive ? '#fff' : '#aaa',
                background: isActive ? '#2a2a2a' : 'transparent',
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main style={{ flex: 1, padding: '2rem' }}>
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '2rem',
            paddingBottom: '1rem',
            borderBottom: '1px solid #2a2a2a',
          }}
        >
          <div style={{ color: '#888', fontSize: 14 }}>
            {currentOrg ? currentOrg.name : 'No organisation selected'}
          </div>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <span style={{ color: '#888' }}>{user?.email}</span>
            <button
              onClick={() => signOut()}
              style={{
                padding: '0.25rem 0.75rem',
                background: 'transparent',
                color: '#aaa',
                border: '1px solid #444',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              Sign out
            </button>
          </div>
        </header>
        <Outlet />
      </main>
    </div>
  );
}
