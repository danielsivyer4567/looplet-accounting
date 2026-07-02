/**
 * Tests for src/components/settings/XeroConnect.tsx
 *
 * Proves Settings has a real Xero OAuth entry point instead of a dead/deployed-only
 * pair of edge functions.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { XeroConnect } from '@/components/settings/XeroConnect';
import { mockSupabaseResponse, supabase } from '@/test/mocks/supabase';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

vi.mock('@/hooks/useOrg', () => {
  const currentOrg = { id: 'org-1', name: 'AFGC Plumbing', organization_type: 'standard' };
  const orgValue = {
    organizations: [currentOrg],
    currentOrg,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  };
  return { useOrg: () => orgValue };
});

describe('XeroConnect', () => {
  beforeEach(() => {
    mockSupabaseResponse({ data: [], error: null });
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          state: 'state-123',
          auth_url: window.location.href,
        }),
      }),
    );
    vi.spyOn(supabase.auth, 'getSession').mockResolvedValue({
      data: { session: { access_token: 'jwt-123' } },
      error: null,
    });
  });

  it('renders a Connect Xero button when no integration is enabled', async () => {
    render(<XeroConnect />);

    expect(await screen.findByRole('button', { name: /\+ connect xero/i })).toBeInTheDocument();
  });

  it('uses a skeleton while the Xero integration is loading', async () => {
    render(<XeroConnect />);

    expect(screen.getByLabelText(/loading xero integration/i)).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(await screen.findByRole('button', { name: /\+ connect xero/i })).toBeInTheDocument();
    expect(screen.queryByText(/^loading/i)).not.toBeInTheDocument();
  });

  it('renders an enabled Xero tenant in a responsive connected-state card', async () => {
    mockSupabaseResponse({
      data: {
        id: 'xero-1',
        xero_tenant_id: 'tenant-1234567890',
        xero_tenant_name: 'Looplet Demo Pty Ltd',
        is_enabled: true,
        status: 'active',
        last_synced_at: '2026-07-01T03:30:00Z',
        last_error: null,
        token_expires_at: '2026-07-31T03:30:00Z',
      },
      error: null,
    });

    const { container } = render(<XeroConnect />);

    expect(await screen.findByText('Looplet Demo Pty Ltd')).toBeInTheDocument();
    expect(container.querySelector('.settings-xero-card')).toBeTruthy();
    expect(screen.getByText('tenant-1234567890')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sync accounts/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sync payments/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
  });

  it('shows categorized load errors in an alert', async () => {
    mockSupabaseResponse({
      data: null,
      error: { message: 'permission denied for table xero_integrations' },
    });

    render(<XeroConnect />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load Xero integration');
    expect(alert).toHaveTextContent('Authentication or permission issue');
  });

  it('starts Xero OAuth with the selected organization and stores the CSRF state', async () => {
    render(<XeroConnect />);

    fireEvent.click(await screen.findByRole('button', { name: /\+ connect xero/i }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/functions/v1/xero-oauth-start'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer jwt-123',
            'Content-Type': 'application/json',
          }),
          body: expect.stringContaining('"organization_id":"org-1"'),
        }),
      );
    });
    expect(sessionStorage.getItem('xero_oauth_state')).toBe('state-123');
  });

  it('has a breakpoint contract for connected Xero tenant actions', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

    expect(css).toMatch(/\.settings-xero-card__content\s*\{[\s\S]*display: flex/);
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.settings-xero-card__content\s*\{[\s\S]*display: grid/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.settings-xero-card__actions button\s*\{[\s\S]*width: 100%/,
    );
  });
});
