/**
 * The app shell (UI-03): skip link, labelled collapsible sectioned sidebar with the organisation
 * switcher at the top and the account menu at the bottom, a 56px top bar with breadcrumbs, the
 * Ctrl/⌘K command palette and the bell, no dead app switcher, and a timeline rail that is
 * collapsed below 1440px.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

const signOut = vi.fn();
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'owner@example.com' },
    session: null,
    loading: false,
    signOut,
  }),
}));

vi.mock('@/hooks/useAccountantHeartbeat', () => ({
  useAccountantHeartbeat: () => undefined,
}));

const orgs = [
  { id: 'org-1', name: 'Affordable Fencing', organization_type: 'standard' },
  { id: 'org-2', name: 'Beta Builders', organization_type: 'standard' },
];
vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: orgs,
    currentOrg: orgs[0],
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
    accountantClientOrgs: [],
    isAccountantOnly: false,
  }),
}));

vi.mock('@/hooks/useTaxCalendar', () => ({
  buildObligationPrompt: () => 'Explain BAS due soon',
  useTaxCalendar: () => ({ obligations: [], loading: false, error: null }),
}));

const toggleTheme = vi.fn();
vi.mock('@/contexts/theme-context', () => ({
  useTheme: () => ({ theme: 'light', toggleTheme }),
}));

/** matchMedia keyed by query: the shell asks for the phone and the wide-screen breakpoints. */
function setViewport({ mobile = false, wide = false }: { mobile?: boolean; wide?: boolean }) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: /max-width/.test(query) ? mobile : /min-width:\s*1440px/.test(query) ? wide : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function renderShell(path = '/bills') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<div>Today body</div>} />
          <Route path="/bills" element={<div>Bills body</div>} />
          <Route path="/bills/upload" element={<div>Upload body</div>} />
          <Route path="/invoices" element={<div>Invoices body</div>} />
          <Route path="/settings" element={<div>Settings body</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('App shell', () => {
  beforeEach(() => {
    localStorage.clear();
    signOut.mockClear();
    toggleTheme.mockClear();
    setViewport({});
  });

  it('starts with a skip link that targets the main landmark', () => {
    renderShell();
    const skip = screen.getByRole('link', { name: /skip to main content/i });
    expect(skip).toHaveAttribute('href', '#main-content');
    expect(document.querySelectorAll('a, button')[0]).toBe(skip);
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(main).toHaveAttribute('tabindex', '-1');
  });

  it('has a labelled sidebar with sections that collapse and remember it, and the org switcher at the top', () => {
    renderShell();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const money = within(nav).getByRole('button', { name: /^money$/i });
    expect(money).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav).getByRole('link', { name: 'Bills' })).toBeInTheDocument();

    fireEvent.click(money);
    expect(money).toHaveAttribute('aria-expanded', 'false');
    expect(within(nav).queryByRole('link', { name: 'Bills' })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('looplet_nav_sections') ?? '{}')).toMatchObject({ Money: false });

    // Org switcher sits in the sidebar, above the navigation.
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    const orgSelect = within(sidebar).getByRole('combobox', { name: /organisation/i });
    expect(within(orgSelect).getByRole('option', { name: 'Beta Builders' })).toBeInTheDocument();
    expect(orgSelect.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('collapses the whole sidebar to an icon rail, keeping link names, and remembers it', () => {
    renderShell();
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    fireEvent.click(within(sidebar).getByRole('button', { name: /collapse sidebar/i }));
    expect(sidebar).toHaveClass('sidebar-collapsed');
    expect(localStorage.getItem('looplet_sidebar_collapsed')).toBe('true');
    expect(screen.getByRole('link', { name: 'Bills' })).toBeInTheDocument();
    expect(within(sidebar).getByRole('button', { name: /organisation: affordable fencing/i })).toBeInTheDocument();
    fireEvent.click(within(sidebar).getByRole('button', { name: /expand sidebar/i }));
    expect(sidebar).not.toHaveClass('sidebar-collapsed');
  });

  it('puts an account menu at the bottom of the sidebar in place of the one-click sign-out', () => {
    renderShell();
    expect(screen.queryByTitle('Sign out')).not.toBeInTheDocument();
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    const trigger = within(sidebar).getByRole('button', { name: /account menu/i });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('owner@example.com')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /settings/i })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /sign out/i }));
    expect(signOut).toHaveBeenCalledTimes(1);
    // The nav is below the org switcher and above the account menu.
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has a 56px top bar with breadcrumbs, the palette trigger and the bell, and no app switcher', () => {
    renderShell('/bills/upload');
    const topbar = screen.getByRole('banner');
    expect(topbar).toHaveClass('topbar');
    const crumbs = within(topbar).getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Today' })).toHaveAttribute('href', '/');
    expect(within(crumbs).getByRole('link', { name: 'Bills' })).toHaveAttribute('href', '/bills');
    expect(within(crumbs).getByText('Upload')).toHaveAttribute('aria-current', 'page');
    expect(within(topbar).getByRole('button', { name: /search pages and actions/i })).toBeInTheDocument();
    expect(within(topbar).getByRole('button', { name: /notifications/i })).toBeInTheDocument();
    expect(within(topbar).getByRole('button', { name: /switch to dark mode/i })).toBeInTheDocument();
    expect(screen.queryByTitle(/app switcher/i)).not.toBeInTheDocument();
    expect(screen.queryByText('CRM')).not.toBeInTheDocument();
    // One h1 per page: the shell no longer renders its own.
    expect(within(topbar).queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('opens the command palette with Ctrl+K, filters pages and actions, and navigates with the keyboard', () => {
    renderShell('/bills');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = screen.getByRole('dialog', { name: /command palette/i });
    const input = within(dialog).getByRole('combobox', { name: /search pages and actions/i });
    expect(input).toHaveFocus();
    expect(within(dialog).getByRole('option', { name: /sign out/i })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'invoi' } });
    expect(within(dialog).getByRole('option', { name: /invoices/i })).toBeInTheDocument();
    expect(within(dialog).queryByRole('option', { name: /^bills/i })).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('dialog', { name: /command palette/i })).not.toBeInTheDocument();
    expect(screen.getByText('Invoices body')).toBeInTheDocument();

    // The trigger button opens it too, and Escape closes it.
    fireEvent.click(screen.getByRole('button', { name: /search pages and actions/i }));
    fireEvent.keyDown(screen.getByRole('combobox', { name: /search pages and actions/i }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /command palette/i })).not.toBeInTheDocument();
  });

  it('collapses the timeline rail below 1440px and shows it from 1440px', () => {
    setViewport({ wide: false });
    const narrow = renderShell();
    expect(screen.getByRole('button', { name: /show timeline/i })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: /tax timeline/i })).not.toBeInTheDocument();
    narrow.unmount();

    setViewport({ wide: true });
    renderShell();
    expect(screen.getByRole('complementary', { name: /tax timeline/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show timeline/i })).not.toBeInTheDocument();
  });

  it('uses a modal drawer for the sidebar on a phone', () => {
    setViewport({ mobile: true });
    renderShell();
    expect(screen.queryByRole('complementary', { name: 'Sidebar' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /open navigation/i }));
    const drawer = screen.getByRole('dialog', { name: /navigation/i });
    expect(within(drawer).getByRole('link', { name: 'Bills' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /navigation/i })).not.toBeInTheDocument();
  });
});
