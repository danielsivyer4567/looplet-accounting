/**
 * Every button has an accessible name (UI-04).
 *
 * Renders the app shell (Layout with the real OrgSelector and NotificationBell) around the key
 * list pages, with Supabase mocked to return empty data, and asserts that every <button> in the
 * document has a name a screen reader can announce: visible text, aria-label, aria-labelledby or
 * a title. Icon-only buttons are the usual offenders; scripts/check-a11y-tokens.mjs catches them
 * statically, and this test proves it at render time, including buttons built from props.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { Layout } from '@/components/Layout';
import { BillsPage } from '@/pages/Bills';
import { InvoicesPage } from '@/pages/Invoices';
import { JobsPage } from '@/pages/Jobs';
import { EmployeesPage } from '@/pages/Employees';
import { PayrollPage } from '@/pages/Payroll';
import { CustomersPage } from '@/pages/Customers';
import { SuppliersPage } from '@/pages/Suppliers';
import { DebtsPage } from '@/pages/Debts';
import { PaymentRunsPage } from '@/pages/PaymentRuns';
import { NotificationsPage } from '@/pages/Notifications';
import { LodgementsPage } from '@/pages/Lodgements';
import { SubscriptionsPage } from '@/pages/Subscriptions';
import { ReportsIndexPage } from '@/pages/reports/Index';
import { CgtEventsPanel } from '@/components/CgtEventsPanel';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

vi.mock('@/hooks/useCgtEvents', () => ({
  useCgtEvents: () => ({
    events: [],
    loading: false,
    error: null,
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
  costBaseCents: () => 0,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'owner@example.com' },
    session: null,
    loading: false,
    signOut: vi.fn(),
  }),
}));

vi.mock('@/hooks/useAccountantHeartbeat', () => ({
  useAccountantHeartbeat: () => undefined,
}));

const org = {
  id: 'org-1',
  name: 'Affordable Fencing',
  organization_type: 'standard',
  role_enum: 'owner',
};
vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: [org],
    currentOrg: org,
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

vi.mock('@/contexts/theme-context', () => ({
  useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }),
}));

const PAGES: [string, ReactElement][] = [
  ['/bills', <BillsPage />],
  ['/invoices', <InvoicesPage />],
  ['/jobs', <JobsPage />],
  ['/employees', <EmployeesPage />],
  ['/payroll', <PayrollPage />],
  ['/customers', <CustomersPage />],
  ['/suppliers', <SuppliersPage />],
  ['/debts', <DebtsPage />],
  ['/payment-runs', <PaymentRunsPage />],
  ['/notifications', <NotificationsPage />],
  ['/lodgements', <LodgementsPage />],
  ['/subscriptions', <SubscriptionsPage />],
  ['/reports', <ReportsIndexPage />],
  // Team is not listed: its invite flow calls fetch() against the edge-function URL, which has no
  // mock here and never resolves under jsdom. Its buttons are covered by the static checker.
];

function setViewportMatch(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
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

async function renderInShell(path: string, element: ReactElement) {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path={path} element={element} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  // Let the mocked queries resolve and the pages leave their loading state.
  await act(() => new Promise((resolve) => setTimeout(resolve, 40)));
  await act(() => new Promise((resolve) => setTimeout(resolve, 40)));
  return view;
}

function expectEveryButtonNamed(where: string) {
  const buttons = screen.getAllByRole('button');
  expect(buttons.length, `${where}: expected some buttons`).toBeGreaterThan(0);
  const unnamed = buttons.filter((b) => {
    const name =
      b.getAttribute('aria-label') ??
      (b.getAttribute('aria-labelledby') ? 'labelledby' : null) ??
      b.getAttribute('title') ??
      b.textContent?.trim();
    return !name;
  });
  expect(
    unnamed.map((b) => b.outerHTML.slice(0, 140)),
    `${where}: every button needs an accessible name`,
  ).toEqual([]);
  for (const b of buttons) expect(b).toHaveAccessibleName();
}

describe('every button has an accessible name', () => {
  for (const [path, element] of PAGES) {
    it(`shell + ${path}`, async () => {
      setViewportMatch(false);
      const { unmount } = await renderInShell(path, element);
      expectEveryButtonNamed(path);
      unmount();
    });
  }

  it('shell at phone width (drawer toggle, org switcher, bell, theme toggle)', async () => {
    setViewportMatch(true);
    const { unmount } = await renderInShell('/bills', <BillsPage />);
    expectEveryButtonNamed('phone shell');
    unmount();
  });

  // A form that opens inside a page: its close (×) button used to be an unnamed icon.
  it('an opened add-event form (CGT events) names its close button', async () => {
    setViewportMatch(false);
    render(<CgtEventsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /add event/i }));
    expect(screen.getByRole('heading', { name: /add cgt event/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expectEveryButtonNamed('CGT event form');
  });
});
