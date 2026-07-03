import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type * as ReactRouterDom from 'react-router-dom';
import { BankCallbackPage } from '@/pages/BankCallback';

const testOrg = vi.hoisted(() => ({ id: 'org-1', name: 'Org One', organization_type: 'standard' }));
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: [testOrg],
    currentOrg: testOrg,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof ReactRouterDom>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: 'jwt-token' } },
        error: null,
      }),
    },
  },
}));

// Per-URL fetch responder configured per test.
let fetchResponders: { jobPoll?: () => unknown; exchange?: () => unknown };
const fetchMock = vi.fn(async (url: string) => {
  const body = url.includes('bank-job-poll')
    ? fetchResponders.jobPoll?.()
    : fetchResponders.exchange?.();
  return { ok: true, status: 200, json: async () => body };
});

function renderAt(query: string) {
  return render(
    <MemoryRouter initialEntries={[`/settings/bank-callback${query}`]}>
      <Routes>
        <Route path="/settings/bank-callback" element={<BankCallbackPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BankCallbackPage — Basiq connect pipeline', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
    mockNavigate.mockClear();
    fetchResponders = {};
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('Path A: a direct connectionId calls bank-exchange and reports linked accounts', async () => {
    fetchResponders.exchange = () => ({ ok: true, accounts: [{ id: 'a1' }, { id: 'a2' }] });

    renderAt('?connectionId=conn-123');

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/functions/v1/bank-exchange'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await waitFor(() => expect(screen.getByText(/2 accounts linked/i)).toBeInTheDocument());
  });

  it('surfaces a Basiq error param without calling any function', async () => {
    renderAt('?error=access_denied');

    await waitFor(() =>
      expect(screen.getByText(/basiq returned an error: access_denied/i)).toBeInTheDocument(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Path B: polls bank-job-poll, then exchanges once the job is active', async () => {
    vi.useFakeTimers();
    fetchResponders.jobPoll = () => ({ ok: true, status: 'active', connection_id: 'conn-async' });
    fetchResponders.exchange = () => ({ ok: true, accounts: [{ id: 'a1' }] });

    renderAt('?jobId=job-abc123');

    // First poll fires after the initial 1s delay.
    await vi.advanceTimersByTimeAsync(1200);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/functions/v1/bank-job-poll'),
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/functions/v1/bank-exchange'),
      expect.anything(),
    );
    expect(screen.getByText(/1 account linked/i)).toBeInTheDocument();
  });

  it('shows a clear failure (not "still activating") when the Basiq job fails', async () => {
    vi.useFakeTimers();
    fetchResponders.jobPoll = () => ({ ok: true, status: 'failed' });

    renderAt('?jobId=job-fail');

    await vi.advanceTimersByTimeAsync(1200);

    expect(screen.getByText(/the bank connection failed on basiq/i)).toBeInTheDocument();
    expect(screen.queryByText(/still activating/i)).not.toBeInTheDocument();
    // A failed job must never trigger the exchange step.
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/functions/v1/bank-exchange'),
      expect.anything(),
    );
  });

  it('shows "still activating" (not a failure) when polling times out on a pending job', async () => {
    vi.useFakeTimers();
    fetchResponders.jobPoll = () => ({ ok: true, status: 'pending' });

    renderAt('?jobId=job-slow');

    // 30 attempts × 2s ≈ 60s of polling; advance past the whole window.
    await vi.advanceTimersByTimeAsync(65000);

    expect(screen.getByText(/still activating on basiq/i)).toBeInTheDocument();
    expect(screen.queryByText(/connection failed/i)).not.toBeInTheDocument();
  });
});
