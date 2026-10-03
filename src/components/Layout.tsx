import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useOrg } from '@/hooks/useOrg';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useAccountantHeartbeat } from '@/hooks/useAccountantHeartbeat';
import { useTaxCalendar, buildObligationPrompt } from '@/hooks/useTaxCalendar';
import { OrgSelector } from './OrgSelector';
import { NotificationBell } from './NotificationBell';
import { BrandLogo } from './BrandLogo';
import { LegalLinks } from './LegalLinks';
import { TaxTimeline } from './TaxTimeline';
import { AdvisorFinishButton } from './AdvisorFinishButton';
import { CommandPalette, type CommandItem } from './CommandPalette';
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
  CalendarClock,
  ListChecks,
  Boxes,
  ShieldCheck,
  Send,
  Building2,
  Tag,
  FileMinus2,
  ChevronDown,
  ChevronUp,
  Wrench,
  Search,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react';
import { TagDropProvider, useTagDrop } from '@/hooks/useTagDrop';
import { TagDropManager } from '@/components/tag-drop/TagDropManager';
import { Toaster } from '@/components/ui/toaster';

type NavArea = 'Today' | 'Money' | 'Jobs' | 'Assets' | 'People' | 'Tax' | 'Advisor' | 'Setup';

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  area: NavArea;
  end?: boolean;
  badge?: string;
  /** Extra search words for the command palette. */
  keywords?: string;
}

const SECTION_ORDER: NavArea[] = ['Today', 'Money', 'Jobs', 'Assets', 'People', 'Tax', 'Advisor', 'Setup'];
/** Sections shown only when "Advanced tools" is on. */
const ADVANCED_AREAS: NavArea[] = ['Advisor', 'Setup'];

const navItems: NavItem[] = [
  { to: '/', label: 'Today', icon: LayoutDashboard, area: 'Today', end: true, keywords: 'home dashboard' },
  { to: '/ask', label: 'Ask AI', icon: MessageSquare, area: 'Today', badge: 'New', keywords: 'question help' },
  { to: '/notifications', label: 'Notifications', icon: Bell, area: 'Today', keywords: 'alerts' },
  { to: '/bills', label: 'Bills', icon: Receipt, area: 'Money', keywords: 'supplier invoices payable' },
  { to: '/payment-runs', label: 'Payment runs', icon: DollarSign, area: 'Money', keywords: 'pay aba' },
  { to: '/invoices', label: 'Invoices', icon: FileText, area: 'Money', keywords: 'sales receivable' },
  { to: '/credit-notes', label: 'Credit notes', icon: FileMinus2, area: 'Money', keywords: 'credits refunds' },
  { to: '/reconciliation', label: 'Reconciliation', icon: Scale, area: 'Money', keywords: 'match bank' },
  { to: '/debts', label: 'Debts', icon: TrendingDown, area: 'Money', keywords: 'loans' },
  { to: '/jobs', label: 'Jobs', icon: Briefcase, area: 'Jobs', keywords: 'projects' },
  { to: '/customers', label: 'Customers', icon: Users, area: 'Jobs', keywords: 'clients' },
  { to: '/allocations', label: 'Allocations', icon: GitCommit, area: 'Jobs', keywords: 'allocate costs' },
  { to: '/suppliers', label: 'Suppliers', icon: Truck, area: 'Jobs', keywords: 'vendors' },
  { to: '/fixed-assets', label: 'Fixed assets', icon: Boxes, area: 'Assets', keywords: 'gear equipment depreciation' },
  { to: '/subscriptions', label: 'Subscriptions', icon: RefreshCw, area: 'Assets', keywords: 'subs recurring' },
  { to: '/employees', label: 'Employees', icon: Contact, area: 'People', keywords: 'people staff' },
  { to: '/payroll', label: 'Payroll', icon: CreditCard, area: 'People', keywords: 'payday pay run super' },
  { to: '/reports', label: 'Reports', icon: BarChart3, area: 'Tax', keywords: 'tax bas balance sheet' },
  // "Prepare", not "Lodge": the app prepares lodgement packs; it does not lodge with the ATO.
  { to: '/lodgements', label: 'Prepare', icon: Send, area: 'Tax', keywords: 'lodgements lodgement pack ato' },
  { to: '/legal-horizon', label: 'Legal horizon', icon: CalendarClock, area: 'Tax', badge: 'New', keywords: 'upcoming law changes' },
  { to: '/receipt-hub', label: 'Receipts', icon: ReceiptText, area: 'Advisor', badge: 'MVP', keywords: 'pos' },
  { to: '/scan', label: 'Scan document', icon: Scan, area: 'Advisor', keywords: 'ocr' },
  { to: '/coding-review', label: 'Coding review', icon: ListChecks, area: 'Advisor', keywords: 'categorise' },
  { to: '/approvals', label: 'Approvals', icon: ShieldCheck, area: 'Advisor' },
  { to: '/quality', label: 'Quality', icon: CheckCircle, area: 'Advisor', keywords: 'books health period close' },
  { to: '/onboarding', label: 'Auto setup', icon: Sparkles, area: 'Setup', keywords: 'onboarding gmail' },
  { to: '/settings', label: 'Settings', icon: Settings, area: 'Setup', keywords: 'preferences connections' },
];

const LS_COLLAPSED = 'looplet_sidebar_collapsed';
const LS_SECTIONS = 'looplet_nav_sections';
const LS_ADVANCED = 'looplet_show_advanced';
const LS_TIMELINE = 'looplet_timeline_open';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function initialsFor(email: string): string {
  const local = email.split('@')[0] ?? '';
  return (local.slice(0, 2) || 'us').toUpperCase();
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

interface SidebarContentProps {
  items: NavItem[];
  collapsed: boolean;
  /** The phone drawer: no collapse control, and the shell closes it on navigation. */
  drawer?: boolean;
  onNavClick?: () => void;
  onToggleCollapsed?: () => void;
  onExpand?: () => void;
  userMenu: UserMenuProps;
}

function SidebarContent({ items, collapsed, drawer, onNavClick, onToggleCollapsed, onExpand, userMenu }: SidebarContentProps) {
  const [showAdvanced, setShowAdvanced] = useState(() => localStorage.getItem(LS_ADVANCED) === 'true');
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => readJson(LS_SECTIONS, {}));
  const sectionIds = useId();

  useEffect(() => {
    localStorage.setItem(LS_ADVANCED, String(showAdvanced));
  }, [showAdvanced]);

  const toggleSection = (area: NavArea) => {
    setOpenSections((prev) => {
      const next = { ...prev, [area]: !(prev[area] ?? true) };
      localStorage.setItem(LS_SECTIONS, JSON.stringify(next));
      return next;
    });
  };

  const sections = SECTION_ORDER.map((area) => ({ area, items: items.filter((i) => i.area === area) }))
    .filter((s) => s.items.length > 0)
    .filter((s) => showAdvanced || !ADVANCED_AREAS.includes(s.area));

  return (
    <div className="sidebar-inner">
      <div className="sidebar-brand">
        <BrandLogo size={28} />
        {!collapsed && <span className="sidebar-brand-name">Looplet</span>}
        {!drawer && onToggleCollapsed ? (
          <button
            type="button"
            className="btn btn-ghost btn-icon sidebar-collapse-btn"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        ) : null}
      </div>

      <div className="sidebar-org">
        <OrgSelector compact={collapsed} onExpand={onExpand} />
      </div>

      <nav className="sidebar-nav" aria-label="Main">
        {sections.map(({ area, items: sectionItems }) => {
          const open = collapsed ? true : (openSections[area] ?? true);
          const listId = `${sectionIds}-${area}`;
          return (
            <section key={area} className="sidebar-section" aria-label={area}>
              {collapsed ? (
                <span className="sr-only">{area}</span>
              ) : (
                <button
                  type="button"
                  className="sidebar-section-toggle"
                  aria-expanded={open}
                  aria-controls={listId}
                  onClick={() => toggleSection(area)}
                >
                  <span>{area}</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              )}
              <ul id={listId} className="sidebar-list" hidden={!open}>
                {sectionItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        end={item.end ?? false}
                        onClick={onNavClick}
                        className={({ isActive }) => `sidebar-link${isActive ? ' is-active' : ''}`}
                        title={collapsed ? item.label : undefined}
                      >
                        <Icon size={18} aria-hidden="true" />
                        <span className={collapsed ? 'sr-only' : 'sidebar-link-label'}>{item.label}</span>
                        {item.badge ? (
                          <span className="sidebar-badge" aria-hidden={collapsed ? 'true' : undefined}>
                            {item.badge}
                          </span>
                        ) : null}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}

        <button
          type="button"
          className="sidebar-advanced"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          aria-label={showAdvanced ? 'Hide advanced tools' : 'Show advanced tools'}
          title={showAdvanced ? 'Hide advanced tools' : 'Show advanced tools'}
        >
          <Wrench size={12} aria-hidden="true" />
          {!collapsed && <span>Advanced tools</span>}
          {!collapsed && (showAdvanced ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />)}
        </button>
      </nav>

      <div className="sidebar-footer">
        <UserMenu {...userMenu} collapsed={collapsed} />
        {!collapsed && <LegalLinks compact />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account menu (replaces the one-click sign-out avatar)
// ---------------------------------------------------------------------------

interface UserMenuProps {
  email: string;
  theme: string;
  onToggleTheme: () => void;
  onSignOut: () => void;
  onNavigate?: () => void;
  collapsed?: boolean;
}

function UserMenu({ email, theme, onToggleTheme, onSignOut, onNavigate, collapsed }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const first = ref.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [open]);

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  const close = () => setOpen(false);

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account menu for ${email}`}
        title={collapsed ? email : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="user-avatar" aria-hidden="true">
          {initialsFor(email)}
        </span>
        {!collapsed && <span className="user-menu-email">{email}</span>}
        {!collapsed && <ChevronUp size={14} aria-hidden="true" />}
      </button>
      {open ? (
        <div id={menuId} role="menu" aria-label="Account" className="user-menu-list" onKeyDown={onMenuKeyDown}>
          <div className="user-menu-identity">{email}</div>
          <Link
            role="menuitem"
            to="/settings"
            className="menu-item"
            onClick={() => {
              close();
              onNavigate?.();
            }}
          >
            <Settings size={16} aria-hidden="true" /> Settings
          </Link>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              close();
              onToggleTheme();
            }}
          >
            {theme === 'light' ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />}
            {theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item menu-item-danger"
            onClick={() => {
              close();
              onSignOut();
            }}
          >
            <LogOut size={16} aria-hidden="true" /> Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

function crumbLabel(segment: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment) || /^\d{4,}$/.test(segment)) return 'Detail';
  const words = segment.replace(/[-_]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function Breadcrumbs({ items }: { items: NavItem[] }) {
  const { pathname } = useLocation();
  const segments = pathname.split('/').filter(Boolean);
  const crumbs: { label: string; to?: string }[] = [];
  if (segments.length === 0) {
    crumbs.push({ label: 'Today' });
  } else {
    crumbs.push({ label: 'Today', to: '/' });
    let path = '';
    segments.forEach((segment, index) => {
      path += `/${segment}`;
      const match = items.find((item) => item.to === path);
      const label = match?.label ?? crumbLabel(segment);
      const last = index === segments.length - 1;
      crumbs.push(last ? { label } : { label, to: path });
    });
  }
  return (
    <nav aria-label="Breadcrumb" className="breadcrumbs">
      <ol>
        {crumbs.map((crumb, i) => (
          <li key={`${crumb.label}-${i}`}>
            {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : <span aria-current="page">{crumb.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Tag-drop (unchanged behaviour)
// ---------------------------------------------------------------------------

// Header toggle for tag-drop mode. Lives inside TagDropProvider so it can read
// the active flag; lights up while a tag is being placed.
function TagModeToggleButton() {
  const { isTagDropActive, toggleTagDrop } = useTagDrop();
  return (
    <button
      type="button"
      onClick={toggleTagDrop}
      data-no-tag-drop
      title={isTagDropActive ? 'Cancel tag drop' : 'Drop a tag (notify a teammate)'}
      aria-pressed={isTagDropActive}
      aria-label="Toggle tag drop mode"
      className={`btn btn-ghost btn-icon topbar-icon-btn${isTagDropActive ? ' is-active' : ''}`}
    >
      <Tag size={16} />
    </button>
  );
}

// Mounts the tag-drop manager globally, wiring the provider's active flag to the
// manager and scoping created tags to the current org.
function GlobalTagDrop() {
  const { currentOrg } = useOrg();
  const { isTagDropActive, activateTagDrop, deactivateTagDrop } = useTagDrop();
  return (
    <TagDropManager
      isActive={isTagDropActive}
      {...(currentOrg?.id ? { organizationId: currentOrg.id } : {})}
      onModeChange={(active) => (active ? activateTagDrop() : deactivateTagDrop())}
    />
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function Layout() {
  const { user, signOut } = useAuth();
  const { accountantClientOrgs } = useOrg();
  const isMobile = useIsMobile();
  const wide = useMediaQuery('(min-width: 1440px)');
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  // Mixed users (own books + accountant clients) get a "Clients" entry so they can
  // jump to the picker. Accountant-only users land on /clients directly (HomeRoute).
  const items: NavItem[] = useMemo(() => {
    if (accountantClientOrgs.length === 0) return navItems;
    const clientsItem: NavItem = { to: '/clients', label: 'Clients', icon: Building2, area: 'Advisor', keywords: 'accountant' };
    return navItems.flatMap((item, i) => (i === 0 ? [item, clientsItem] : [item]));
  }, [accountantClientOrgs.length]);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(LS_COLLAPSED) === 'true');
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Tax timeline right rail: open by default only on wide screens (>= 1440px), where it fits beside
  // the content; narrower screens start collapsed to the edge pill. A user's choice is remembered.
  const [timelineOpen, setTimelineOpen] = useState(() => {
    const stored = localStorage.getItem(LS_TIMELINE);
    return stored === null ? wide : stored === 'true';
  });
  useEffect(() => {
    if (localStorage.getItem(LS_TIMELINE) === null) setTimelineOpen(wide);
  }, [wide]);
  const setTimeline = useCallback((open: boolean) => {
    localStorage.setItem(LS_TIMELINE, String(open));
    setTimelineOpen(open);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      localStorage.setItem(LS_COLLAPSED, String(!c));
      return !c;
    });
  }, []);

  const { obligations, loading: tlLoading, error: tlError } = useTaxCalendar();
  const showRail = !isMobile;

  // No-op for non-accountants; for accountant role it logs pageviews + heartbeats.
  useAccountantHeartbeat();

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // Close the drawer when the route changes and on Escape.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  // ⌘K / Ctrl+K opens the command palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const email = user?.email ?? '';
  const paletteItems: CommandItem[] = useMemo(
    () => [
      ...items.map<CommandItem>((item) => ({
        id: `page:${item.to}`,
        label: item.label,
        hint: item.to,
        group: 'Pages',
        icon: item.icon,
        keywords: `${item.area} ${item.keywords ?? ''}`,
        run: () => navigate(item.to),
      })),
      { id: 'act:new-invoice', label: 'New invoice', hint: '/invoices/new', group: 'Actions', icon: FileText, run: () => navigate('/invoices/new') },
      { id: 'act:upload-bill', label: 'Upload a bill', hint: '/bills/upload', group: 'Actions', icon: Receipt, run: () => navigate('/bills/upload') },
      {
        id: 'act:theme',
        label: theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode',
        group: 'Actions',
        icon: theme === 'light' ? Moon : Sun,
        keywords: 'theme appearance',
        run: toggleTheme,
      },
      {
        id: 'act:timeline',
        label: timelineOpen ? 'Hide timeline' : 'Show timeline',
        group: 'Actions',
        icon: CalendarClock,
        keywords: 'tax calendar rail',
        run: () => setTimeline(!timelineOpen),
      },
      {
        id: 'act:sidebar',
        label: collapsed ? 'Expand sidebar' : 'Collapse sidebar',
        group: 'Actions',
        icon: collapsed ? PanelLeftOpen : PanelLeftClose,
        keywords: 'navigation menu',
        run: toggleCollapsed,
      },
      { id: 'act:signout', label: 'Sign out', group: 'Actions', icon: LogOut, keywords: 'log out', run: () => void signOut() },
    ],
    [items, navigate, theme, toggleTheme, timelineOpen, setTimeline, collapsed, toggleCollapsed, signOut],
  );

  const userMenu: UserMenuProps = {
    email,
    theme,
    onToggleTheme: toggleTheme,
    onSignOut: () => void signOut(),
    onNavigate: closeDrawer,
  };

  return (
    <TagDropProvider>
      <div className="app-shell">
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>

        {/* Desktop sidebar: expanded (240px) or an icon rail (72px). */}
        {!isMobile && (
          <aside className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`} aria-label="Sidebar">
            <SidebarContent
              items={items}
              collapsed={collapsed}
              onToggleCollapsed={toggleCollapsed}
              onExpand={() => {
                localStorage.setItem(LS_COLLAPSED, 'false');
                setCollapsed(false);
              }}
              userMenu={userMenu}
            />
          </aside>
        )}

        {/* Phone: the same sidebar as a modal drawer. */}
        {isMobile && drawerOpen && (
          <>
            <div className="drawer-backdrop" onClick={closeDrawer} />
            <aside className="sidebar sidebar-drawer animated-fade-in" role="dialog" aria-modal="true" aria-label="Navigation">
              <button type="button" className="btn btn-ghost btn-icon drawer-close" onClick={closeDrawer} aria-label="Close navigation">
                <X size={18} />
              </button>
              <SidebarContent items={items} collapsed={false} drawer onNavClick={closeDrawer} userMenu={userMenu} />
            </aside>
          </>
        )}

        <div className="app-body">
          <header className="topbar">
            {isMobile && (
              <button type="button" onClick={() => setDrawerOpen(true)} aria-label="Open navigation" className="btn btn-ghost btn-icon topbar-icon-btn">
                <Menu size={18} />
              </button>
            )}

            <Breadcrumbs items={items} />

            <div className="topbar-actions">
              <button
                type="button"
                className="palette-trigger"
                onClick={() => setPaletteOpen(true)}
                aria-label="Search pages and actions (Ctrl+K)"
                aria-keyshortcuts="Control+K Meta+K"
                aria-haspopup="dialog"
              >
                <Search size={16} aria-hidden="true" />
                <span className="palette-trigger-label">Search</span>
                <kbd className="palette-kbd" aria-hidden="true">
                  ⌘K
                </kbd>
              </button>

              <AdvisorFinishButton />
              <TagModeToggleButton />

              <button
                type="button"
                onClick={toggleTheme}
                aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
                title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
                className="btn btn-ghost btn-icon topbar-icon-btn"
              >
                {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
              </button>

              <NotificationBell />
            </div>
          </header>

          {/* Route content + the right-hand timeline rail, under the top bar. */}
          <div className="app-content-row">
            <main id="main-content" tabIndex={-1} className="app-main">
              <div className="app-main-inner">
                <Outlet />
              </div>
            </main>

            {showRail && timelineOpen && (
              <aside className="timeline-rail" aria-label="Tax timeline">
                <TaxTimeline
                  obligations={obligations}
                  loading={tlLoading}
                  error={tlError}
                  onHide={() => setTimeline(false)}
                  onAsk={(o, intent) => navigate('/ask', { state: { askPrompt: buildObligationPrompt(o, intent) } })}
                />
              </aside>
            )}
          </div>
        </div>

        {/* Collapsed rail: the edge pill brings the timeline back. */}
        {showRail && !timelineOpen && (
          <button type="button" onClick={() => setTimeline(true)} title="Show timeline" aria-label="Show timeline" className="timeline-pill">
            <CalendarClock size={16} aria-hidden="true" />
            <span>Timeline</span>
          </button>
        )}

        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={paletteItems} />
        <GlobalTagDrop />
        <Toaster />
      </div>
    </TagDropProvider>
  );
}
