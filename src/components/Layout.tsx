import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useOrg } from '@/contexts/OrgContext';
import { useIsMobile } from '@/hooks/useIsMobile';
import { OrgSelector } from './OrgSelector';
import { NotificationBell } from './NotificationBell';

const navItems = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/onboarding', label: 'Auto Setup' },
  { to: '/bills', label: 'Bills' },
  { to: '/payment-runs', label: 'Payment Runs' },
  { to: '/invoices', label: 'Invoices' },
  { to: '/allocations', label: 'Allocations' },
  { to: '/reconciliation', label: 'Reconciliation' },
  { to: '/jobs', label: 'Jobs' },
  { to: '/customers', label: 'Customers' },
  { to: '/suppliers', label: 'Suppliers' },
  { to: '/employees', label: 'Employees' },
  { to: '/payroll', label: 'Payroll' },
  { to: '/subscriptions', label: 'Subscriptions' },
  { to: '/debts', label: 'Debts' },
  { to: '/reports', label: 'Reports' },
  { to: '/quality', label: 'Quality' },
  { to: '/settings', label: 'Settings' },
  { to: '/notifications', label: 'Notifications' },
];

// ---------------------------------------------------------------------------
// Sidebar content — shared between desktop and mobile overlay
// ---------------------------------------------------------------------------

function SidebarContent({ onNavClick }: { onNavClick?: () => void }) {
  return (
    <>
      <div style={{ fontWeight: 700, marginBottom: '1.5rem' }}>Looplet Accounting</div>
      <OrgSelector />
      <nav
        style={{
          marginTop: '1.5rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.25rem',
        }}
      >
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end ?? false}
            onClick={onNavClick}
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
    </>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Layout() {
  const { user, signOut } = useAuth();
  const { currentOrg } = useOrg();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const closeDrawer = () => setDrawerOpen(false);

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* ------------------------------------------------------------------ */}
      {/* Desktop sidebar — hidden on mobile                                  */}
      {/* ------------------------------------------------------------------ */}
      {!isMobile && (
        <aside
          style={{
            width: 220,
            flexShrink: 0,
            background: '#111',
            padding: '1.5rem 1rem',
            borderRight: '1px solid #2a2a2a',
          }}
        >
          <SidebarContent />
        </aside>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Mobile overlay drawer                                               */}
      {/* ------------------------------------------------------------------ */}
      {isMobile && drawerOpen && (
        <>
          {/* Backdrop */}
          <div
            onClick={closeDrawer}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.6)',
              zIndex: 100,
            }}
          />
          {/* Drawer panel */}
          <aside
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              bottom: 0,
              width: 240,
              background: '#111',
              padding: '1.5rem 1rem',
              borderRight: '1px solid #2a2a2a',
              zIndex: 101,
              overflowY: 'auto',
            }}
          >
            <SidebarContent onNavClick={closeDrawer} />
          </aside>
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Main content                                                        */}
      {/* ------------------------------------------------------------------ */}
      <main style={{ flex: 1, padding: isMobile ? '1rem' : '2rem', minWidth: 0 }}>
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '2rem',
            paddingBottom: '1rem',
            borderBottom: '1px solid #2a2a2a',
            gap: '0.75rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {isMobile && (
              <button
                onClick={() => setDrawerOpen(true)}
                aria-label="Open navigation"
                style={{
                  background: 'transparent',
                  border: '1px solid #444',
                  borderRadius: 4,
                  color: '#aaa',
                  fontSize: 18,
                  lineHeight: 1,
                  padding: '0.3rem 0.5rem',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                &#9776;
              </button>
            )}
            <div style={{ color: '#888', fontSize: 14 }}>
              {currentOrg ? currentOrg.name : 'No organisation selected'}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexShrink: 0 }}>
            <NotificationBell />
            {!isMobile && (
              <span style={{ color: '#888', fontSize: 13 }}>{user?.email}</span>
            )}
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
