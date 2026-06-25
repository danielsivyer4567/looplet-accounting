import { useState, useRef, useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useAccountantHeartbeat } from '@/hooks/useAccountantHeartbeat';
import { useTaxCalendar, buildObligationPrompt } from '@/hooks/useTaxCalendar';
import { OrgSelector } from './OrgSelector';
import { NotificationBell } from './NotificationBell';
import { BrandLogo } from './BrandLogo';
import { TaxTimeline } from './TaxTimeline';
import { useTheme } from '@/contexts/theme-context';
import {
  LayoutDashboard,
  MessageSquare,
  Scan,
  ReceiptText,
  Sparkles,
  Receipt,
  DollarSign,
  FileText,
  GitCommit,
  Scale,
  Briefcase,
  Users,
  Truck,
  Contact,
  CreditCard,
  RefreshCw,
  TrendingDown,
  BarChart3,
  CheckCircle,
  Settings,
  Bell,
  Sun,
  Moon,
  Menu,
  LayoutGrid,
  CalendarClock,
  ListChecks,
  Boxes,
  ShieldCheck
} from 'lucide-react';

const navItems = [
  { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/ask', label: 'Ask AI', icon: MessageSquare, badge: 'NEW' },
  { to: '/scan', label: 'Scan Doc', icon: Scan },
  { to: '/receipt-hub', label: 'Receipts', icon: ReceiptText, badge: 'MVP' },
  { to: '/onboarding', label: 'Auto Setup', icon: Sparkles },
  { to: '/bills', label: 'Bills', icon: Receipt },
  { to: '/payment-runs', label: 'Payment', icon: DollarSign },
  { to: '/invoices', label: 'Invoices', icon: FileText },
  { to: '/allocations', label: 'Allocations', icon: GitCommit },
  { to: '/coding-review', label: 'Coding', icon: ListChecks },
  { to: '/approvals', label: 'Approvals', icon: ShieldCheck },
  { to: '/reconciliation', label: 'Reconcile', icon: Scale },
  { to: '/fixed-assets', label: 'Assets', icon: Boxes },
  { to: '/jobs', label: 'Jobs', icon: Briefcase },
  { to: '/customers', label: 'Customers', icon: Users },
  { to: '/suppliers', label: 'Suppliers', icon: Truck },
  { to: '/employees', label: 'Employees', icon: Contact },
  { to: '/payroll', label: 'Payroll', icon: CreditCard },
  { to: '/subscriptions', label: 'Subs', icon: RefreshCw },
  { to: '/debts', label: 'Debts', icon: TrendingDown },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/quality', label: 'Quality', icon: CheckCircle },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/notifications', label: 'Alerts', icon: Bell },
];

function SidebarContent({ onNavClick }: { onNavClick?: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', alignItems: 'center' }}>
      {/* Brand Header: Centered Round Square 'L' Logo */}
      <div 
        style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          padding: '0.75rem 0 1.25rem 0',
          borderBottom: '1px solid var(--border-sidebar)',
          width: '100%'
        }}
      >
        <BrandLogo size={32} />
      </div>

      {/* Navigation List */}
      <nav
        style={{
          marginTop: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          width: '100%',
          padding: '0.25rem'
        }}
      >
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end ?? false}
              onClick={onNavClick}
              style={({ isActive }) => ({
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0.6rem 0.15rem',
                borderRadius: 'var(--radius-md)',
                textDecoration: 'none',
                color: isActive ? 'var(--text-sidebar-active)' : 'var(--text-sidebar)',
                background: isActive ? 'var(--bg-sidebar-active)' : 'transparent',
                transition: 'var(--transition-smooth)',
                position: 'relative',
                width: '100%',
                gap: '4px'
              })}
              className="nav-link-item"
            >
              {({ isActive }) => (
                <>
                  <Icon size={18} strokeWidth={isActive ? 2.25 : 1.75} />
                  <span style={{ fontSize: '9px', fontWeight: 600, textAlign: 'center', display: 'block', lineHeight: 1.1 }}>{item.label}</span>
                  {item.badge && (
                    <span 
                      style={{ 
                        position: 'absolute',
                        top: '2px',
                        right: '2px',
                        fontSize: '7px', 
                        padding: '1px 3px', 
                        borderRadius: '3px', 
                        background: 'var(--accent-primary)', 
                        color: '#fff', 
                        fontWeight: 700 
                      }}
                    >
                      {item.badge}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Sidebar Footer */}
      <div 
        style={{ 
          padding: '0.75rem 0', 
          borderTop: '1px solid var(--border-sidebar)', 
          marginTop: 'auto',
          fontSize: '8px',
          color: 'var(--text-muted)',
          textAlign: 'center',
          width: '100%'
        }}
      >
        v1.0.0
      </div>
    </div>
  );
}

export function Layout() {
  const { user, signOut } = useAuth();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [appSwitcherOpen, setAppSwitcherOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const switcherRef = useRef<HTMLDivElement>(null);

  // Tax timeline right rail — global on every page, collapsible to an edge pill so
  // you always have transparency of your obligations regardless of where you are.
  const { obligations, loading: tlLoading, error: tlError } = useTaxCalendar();
  const showRail = !isMobile;
  const [timelineOpen, setTimelineOpen] = useState(() => {
    const stored = localStorage.getItem('looplet_timeline_open');
    return stored === null ? true : stored === 'true';
  });
  useEffect(() => {
    localStorage.setItem('looplet_timeline_open', String(timelineOpen));
  }, [timelineOpen]);

  // Close app switcher on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (switcherRef.current && !switcherRef.current.contains(event.target as Node)) {
        setAppSwitcherOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // No-op for non-accountants; for accountant role it logs pageviews + heartbeats.
  useAccountantHeartbeat();

  const closeDrawer = () => setDrawerOpen(false);

  // Dynamic Page Title
  const activeItem = navItems.find((item) => {
    if (item.to === '/') return location.pathname === '/';
    return location.pathname.startsWith(item.to);
  });
  const pageTitle = activeItem ? activeItem.label : 'Home';

  // Initials
  const email = user?.email || '';
  const initials = email ? (email.split('@')[0] || '').slice(0, 2).toUpperCase() : 'US';

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-app)' }}>
      {/* Scrollbar overrides for sidebar */}
      <style>{`
        .nav-link-item:hover {
          background-color: var(--bg-hover) !important;
          color: var(--text-title) !important;
        }
        /* Hide scrollbars for vertical compact sidebar */
        nav::-webkit-scrollbar {
          width: 0px;
          background: transparent;
        }
        .app-switch-btn {
          width: 44px;
          height: 44px;
          border-radius: 8px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 2px;
          color: #fff;
          font-weight: 700;
          font-size: 9px;
          cursor: pointer;
          transition: var(--transition-smooth);
        }
        .app-switch-btn:hover {
          opacity: 0.9;
          transform: scale(1.05);
        }
      `}</style>

      {/* Desktop compact sidebar */}
      {!isMobile && (
        <aside
          style={{
            width: 72,
            flexShrink: 0,
            background: 'var(--bg-sidebar)',
            padding: '1rem 0.25rem',
            borderRight: '1px solid var(--border-sidebar)',
            display: 'flex',
            flexDirection: 'column',
            position: 'sticky',
            top: 0,
            height: '100vh'
          }}
        >
          <SidebarContent />
        </aside>
      )}

      {/* Mobile overlay drawer */}
      {isMobile && drawerOpen && (
        <>
          <div
            onClick={closeDrawer}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.4)',
              backdropFilter: 'blur(4px)',
              zIndex: 100,
            }}
          />
          <aside
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              bottom: 0,
              width: 80,
              background: 'var(--bg-sidebar)',
              padding: '1rem 0.25rem',
              borderRight: '1px solid var(--border-sidebar)',
              zIndex: 101,
              overflowY: 'auto',
            }}
            className="animated-fade-in"
          >
            <SidebarContent onNavClick={closeDrawer} />
          </aside>
        </>
      )}

      {/* Main content area */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '1.25rem 1.5rem',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--bg-app)',
            gap: '0.75rem',
            position: 'sticky',
            top: 0,
            zIndex: 10
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {isMobile && (
              <button
                onClick={() => setDrawerOpen(true)}
                aria-label="Open navigation"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-body)',
                  padding: '0.4rem 0.5rem',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <Menu size={18} />
              </button>
            )}
            
            {/* Dynamic Page Title (large white bold font) */}
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-title)' }}>
              {pageTitle === 'Home' ? 'Home' : pageTitle}
            </h1>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            {/* OrgSelector in header */}
            <div style={{ marginRight: '0.25rem' }}>
              <OrgSelector />
            </div>

            {/* Dark/Light mode theme switch */}
            <button
              onClick={toggleTheme}
              title={theme === 'light' ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
              className="theme-toggle-btn"
            >
              {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
            </button>

            {/* Notifications Bell */}
            <NotificationBell />

            {/* App Switcher (Nine-dots Grid icon) */}
            <div style={{ position: 'relative' }} ref={switcherRef}>
              <button
                onClick={() => setAppSwitcherOpen(!appSwitcherOpen)}
                title="App Switcher"
                className="theme-toggle-btn"
                style={{ position: 'relative' }}
              >
                <LayoutGrid size={16} />
              </button>

              {appSwitcherOpen && (
                <div className="app-switcher-popup">
                  <h4 style={{ gridColumn: '1 / -1', margin: '0 0 -0.5rem 0', fontSize: '0.85rem', color: 'var(--text-muted)' }}>Apps</h4>
                  
                  <div className="app-switch-btn" style={{ background: '#000' }}>
                    <div style={{ fontSize: '14px', fontWeight: 800 }}>R</div>
                    <span style={{ fontSize: '8px' }}>Personal</span>
                  </div>

                  <div className="app-switch-btn" style={{ background: '#0a192f' }}>
                    <div style={{ fontSize: '14px', fontWeight: 800 }}>R</div>
                    <span style={{ fontSize: '8px' }}>Business</span>
                  </div>

                  <div className="app-switch-btn" style={{ background: '#3b2f2f' }}>
                    <div style={{ fontSize: '14px', fontWeight: 800 }}>R</div>
                    <span style={{ fontSize: '8px' }}>Invest</span>
                  </div>

                  <div className="app-switch-btn" style={{ background: 'linear-gradient(45deg, #f06, #4a90e2)' }}>
                    <div style={{ fontSize: '14px', fontWeight: 800 }}>R</div>
                    <span style={{ fontSize: '8px' }}>Revolut X</span>
                  </div>

                  <div className="app-switch-btn" style={{ background: '#1c2d3d' }}>
                    <div style={{ fontSize: '14px', fontWeight: 800 }}>R</div>
                    <span style={{ fontSize: '8px' }}>People</span>
                  </div>

                  <div className="app-switch-btn" style={{ background: '#134e4a' }}>
                    <div style={{ fontSize: '14px', fontWeight: 800 }}>R</div>
                    <span style={{ fontSize: '8px' }}>GlobalHire</span>
                  </div>

                  <div className="app-switch-btn" style={{ background: '#1e3a8a' }}>
                    <div style={{ fontSize: '14px', fontWeight: 800 }}>R</div>
                    <span style={{ fontSize: '8px' }}>POS</span>
                  </div>
                </div>
              )}
            </div>
            
            {/* User Profile Avatar with Initials */}
            <div 
              onClick={() => signOut()}
              title="Sign out"
              style={{ 
                width: '32px', 
                height: '32px', 
                borderRadius: '50%', 
                backgroundColor: 'var(--accent-primary)',
                color: '#fff',
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center', 
                fontWeight: 700, 
                fontSize: '0.8rem',
                cursor: 'pointer',
                transition: 'var(--transition-smooth)',
                boxShadow: '0 2px 4px rgba(0,0,0,0.15)'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--accent-danger)'; e.currentTarget.textContent = '✖'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--accent-primary)'; e.currentTarget.textContent = initials; }}
            >
              {initials}
            </div>
          </div>
        </header>

        {/* Body: route content + right-hand timeline rail. The rail sits beside the
            content (inside main, under the header) so it starts below the header line. */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, padding: isMobile ? '1rem' : '2rem', overflowY: 'auto' }}>
            <div style={{ maxWidth: '1200px', margin: '0 auto', width: '100%' }}>
              <Outlet />
            </div>
          </div>

          {/* Global, collapsible timeline rail (mirrors the left nav rail) */}
          {showRail && timelineOpen && (
            <aside
              style={{
                width: 340,
                flexShrink: 0,
                background: 'var(--bg-app)',
                borderLeft: '1px solid var(--border-subtle)',
                overflowY: 'auto',
                padding: '1.5rem 1.1rem',
              }}
            >
              <TaxTimeline
                obligations={obligations}
                loading={tlLoading}
                error={tlError}
                onHide={() => setTimelineOpen(false)}
                onAsk={(o, intent) =>
                  navigate('/ask', { state: { askPrompt: buildObligationPrompt(o, intent) } })
                }
              />
            </aside>
          )}
        </div>
      </main>

      {/* Collapsed: edge pill to pop the timeline back out */}
      {showRail && !timelineOpen && (
        <button
          onClick={() => setTimelineOpen(true)}
          title="Show timeline"
          aria-label="Show timeline"
          style={{
            position: 'fixed',
            right: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 30,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '0.45rem',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRight: 'none',
            borderRadius: '12px 0 0 12px',
            padding: '0.85rem 0.45rem',
            cursor: 'pointer',
            color: 'var(--text-body)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          <CalendarClock size={16} style={{ color: 'var(--accent-primary)' }} />
          <span
            style={{
              writingMode: 'vertical-rl',
              transform: 'rotate(180deg)',
              fontSize: '0.68rem',
              fontWeight: 700,
              letterSpacing: '0.08em',
            }}
          >
            Timeline
          </span>
        </button>
      )}
    </div>
  );
}
