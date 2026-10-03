/**
 * Focused proof for the global app shell responsive behavior.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'owner@example.com' },
    signOut: vi.fn(),
  }),
}));

vi.mock('@/hooks/useAccountantHeartbeat', () => ({
  useAccountantHeartbeat: () => undefined,
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: [{ id: 'org-1', name: 'Affordable Fencing', organization_type: 'standard' }],
    currentOrg: { id: 'org-1', name: 'Affordable Fencing', organization_type: 'standard' },
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
  useTaxCalendar: () => ({
    obligations: [],
    loading: false,
    error: null,
  }),
}));

vi.mock('@/contexts/theme-context', () => ({
  useTheme: () => ({
    theme: 'light',
    toggleTheme: vi.fn(),
  }),
}));

vi.mock('@/components/OrgSelector', () => ({
  OrgSelector: () => <button type="button">Affordable Fencing</button>,
}));

vi.mock('@/components/NotificationBell', () => ({
  NotificationBell: () => <button type="button">Notifications</button>,
}));

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

function renderLayout(path = '/bills') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/bills" element={<div>Route body</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('Layout responsive shell', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('uses the mobile drawer and hides the timeline rail below the mobile breakpoint', () => {
    setViewportMatch(true);
    renderLayout();

    expect(screen.getByRole('button', { name: /open navigation/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Bills$/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/show timeline/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open navigation/i }));

    expect(screen.getByRole('link', { name: /^Bills$/i })).toBeInTheDocument();
    expect(screen.getByText('Route body')).toBeInTheDocument();
  });

  it('uses the compact desktop sidebar and timeline rail above the mobile breakpoint', () => {
    setViewportMatch(false);
    renderLayout();

    expect(screen.queryByRole('button', { name: /open navigation/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Bills$/i })).toBeInTheDocument();
    expect(screen.getByText('Timeline')).toBeInTheDocument();
  });

  // UI-03: the timeline rail starts collapsed to its edge pill below 1440px and open from 1440px,
  // unless the user has chosen otherwise.
  function setViewportByQuery({ mobile, wide }: { mobile: boolean; wide: boolean }) {
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

  it('collapses the timeline rail to the edge pill on a desktop narrower than 1440px', () => {
    setViewportByQuery({ mobile: false, wide: false });
    renderLayout();

    expect(screen.getByRole('button', { name: /show timeline/i })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: /tax timeline/i })).not.toBeInTheDocument();
  });

  it('opens the timeline rail on a 1440px-or-wider desktop and lets the user hide it', () => {
    setViewportByQuery({ mobile: false, wide: true });
    renderLayout();

    expect(screen.getByRole('complementary', { name: /tax timeline/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show timeline/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /hide timeline/i }));
    expect(screen.getByRole('button', { name: /show timeline/i })).toBeInTheDocument();
    expect(localStorage.getItem('looplet_timeline_open')).toBe('false');
  });

  it('remembers a user who opened the rail on a narrow desktop', () => {
    localStorage.setItem('looplet_timeline_open', 'true');
    setViewportByQuery({ mobile: false, wide: false });
    renderLayout();

    expect(screen.getByRole('complementary', { name: /tax timeline/i })).toBeInTheDocument();
  });
});
