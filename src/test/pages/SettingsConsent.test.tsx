/**
 * CONSENT-01: Settings has no pre-ticked, unsaved or unrelated template consent switches.
 *
 * The old Notification tab had seven switches held only in React state: marketing emails, pushes,
 * in-app offers and "share my name, email address and app events with social media platforms" were
 * all ON by default, plus "Commodities volatility alerts" and "Crypto volatility alerts" left over
 * from a template. The Privacy tab had a pre-ticked disabled switch and one that saved nothing.
 * Nothing persisted. The one consent kept (product news email) must start off and be saved.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { SettingsPage } from '@/pages/Settings';
import { supabase } from '@/test/mocks/supabase';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));
vi.mock('@/hooks/useOrg', () => {
  const currentOrg = { id: 'org-1', name: 'Test Org', organization_type: 'standard' };
  const value = {
    organizations: [currentOrg],
    currentOrg,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  };
  return { useOrg: () => value };
});

const getUser = supabase.auth.getUser as unknown as Mock;
const updateUser = supabase.auth.updateUser as unknown as Mock;

function signedInAs(userMetadata: Record<string, unknown>) {
  getUser.mockResolvedValue({
    data: { user: { id: 'user-1', email: 'owner@example.test', user_metadata: userMetadata } },
    error: null,
  });
}

function renderSettings() {
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

function openTab(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('Settings consent switches (CONSENT-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateUser.mockResolvedValue({ data: { user: null }, error: null });
    signedInAs({});
  });

  it('has no advertising, social-media, third-party, commodity or crypto switches', async () => {
    renderSettings();
    for (const tab of [/notification/i, /privacy/i]) {
      openTab(tab);
      await screen.findByRole('heading', { level: 3 });
      const text = document.body.textContent ?? '';
      expect(text).not.toMatch(/social media platforms|advertise to me/i);
      expect(text).not.toMatch(/third party promotions|looplet partners/i);
      expect(text).not.toMatch(/commodit|precious metals/i);
      expect(text).not.toMatch(/crypto/i);
      expect(text).not.toMatch(/personali[sz]ed pushes|in-app recommendations/i);
      expect(text).not.toMatch(/anonymi[sz]ed audits/i);
    }
  });

  it('no switch anywhere in Settings starts on', async () => {
    renderSettings();
    for (const tab of [/notification/i, /privacy/i, /appearance/i]) {
      openTab(tab);
      await screen.findByRole('heading', { level: 3 });
      await waitFor(() => expect(getUser).toHaveBeenCalled());
      for (const box of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
        expect(
          box.checked,
          `${box.getAttribute('aria-labelledby') ?? 'switch'} is pre-ticked`,
        ).toBe(false);
      }
    }
  });

  it('product news email starts off and turning it on is saved to the account', async () => {
    renderSettings();
    const consent = await screen.findByRole('switch', { name: /product news from looplet/i });
    await waitFor(() => expect(consent).not.toBeDisabled());
    expect(consent).not.toBeChecked();

    fireEvent.click(consent);

    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));
    const [{ data }] = updateUser.mock.calls[0] as [
      { data: { product_email_consent: { granted: boolean; updated_at: string } } },
    ];
    expect(data.product_email_consent.granted).toBe(true);
    expect(Number.isNaN(Date.parse(data.product_email_consent.updated_at))).toBe(false);
    expect(await screen.findByRole('status')).toHaveTextContent(/saved/i);
    expect(consent).toBeChecked();
  });

  it('shows the saved choice when the page loads again', async () => {
    signedInAs({ product_email_consent: { granted: true, updated_at: '2026-10-01T00:00:00Z' } });
    renderSettings();
    const consent = await screen.findByRole('switch', { name: /product news from looplet/i });
    await waitFor(() => expect(consent).toBeChecked());

    fireEvent.click(consent);
    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));
    const [{ data }] = updateUser.mock.calls[0] as [
      { data: { product_email_consent: { granted: boolean } } },
    ];
    expect(data.product_email_consent.granted).toBe(false);
    await waitFor(() => expect(consent).not.toBeChecked());
  });

  it('a failed save leaves the switch as it was and says it was not saved', async () => {
    updateUser.mockResolvedValue({ data: { user: null }, error: { message: 'network down' } });
    renderSettings();
    const consent = await screen.findByRole('switch', { name: /product news from looplet/i });
    await waitFor(() => expect(consent).not.toBeDisabled());

    fireEvent.click(consent);

    expect(await screen.findByRole('alert')).toHaveTextContent(/not saved: network down/i);
    expect(consent).not.toBeChecked();
  });
});
