import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AskPage } from '@/pages/Ask';
import type { AdviceNote } from '@/hooks/useAdviceNotes';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  fetch: vi.fn(),
  refreshAdvice: vi.fn(),
  signOff: vi.fn(),
  dismiss: vi.fn(),
  adviceState: {
    current: null as unknown,
  },
  org: {
    current: {
      id: 'org-1',
      name: 'Test Org',
      organization_type: 'standard' as const,
    } as {
      id: string;
      name: string;
      organization_type: 'standard' | 'agency' | 'sub_account';
    } | null,
  },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
    },
  },
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: mocks.org.current ? [mocks.org.current] : [],
    currentOrg: mocks.org.current,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useAdviceNotes', () => ({
  useAdviceNotes: () => mocks.adviceState.current,
}));

const note: AdviceNote = {
  id: 'note-1',
  organization_id: 'org-1',
  kind: 'forecast',
  title: 'Cash-flow forecast and vCFO variance brief',
  summary: 'Runway is 8 weeks.',
  inputs: { mode: 'forecast' },
  numbers: { runway_weeks: 8, projected_closing_balance_cents: 4750000 },
  assumptions: { forecast_horizon: 'current week plus 12 future weeks' },
  citations: [
    {
      doc_ref: 'ATO cash-flow guidance',
      section_ref: 'Record-keeping',
      citation_url: 'https://example.test/source',
    },
  ],
  disclaimer: 'General information only.',
  registered_agent_signoff_by: null,
  registered_agent_signoff_at: null,
  status: 'draft',
  created_at: '2026-06-27T00:00:00Z',
  updated_at: '2026-06-27T00:00:00Z',
  created_by: 'user-1',
  deleted_at: null,
};

function setAdviceState(
  notes: AdviceNote[] = [note],
  overrides: Partial<{
    backendAvailable: boolean;
    unavailableMessage: string | null;
    error: string | null;
  }> = {},
) {
  mocks.adviceState.current = {
    notes,
    loading: false,
    actionBusy: false,
    error: overrides.error ?? null,
    backendAvailable: overrides.backendAvailable ?? true,
    unavailableMessage: overrides.unavailableMessage ?? null,
    refresh: mocks.refreshAdvice,
    createNote: vi.fn(),
    signOff: mocks.signOff,
    dismiss: mocks.dismiss,
  };
}

function renderAsk() {
  return render(
    <MemoryRouter>
      <AskPage />
    </MemoryRouter>,
  );
}

describe('AskPage advisor surface', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.test');
    vi.stubGlobal('fetch', mocks.fetch);
    Element.prototype.scrollIntoView = vi.fn();
    mocks.getSession.mockReset();
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    mocks.refreshAdvice.mockReset();
    mocks.signOff.mockReset();
    mocks.dismiss.mockReset();
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'token-1' } },
    });
    mocks.org.current = {
      id: 'org-1',
      name: 'Test Org',
      organization_type: 'standard',
    };
    setAdviceState();
  });

  it('lists advice notes and opens the detail view without removing suggested chat prompts', () => {
    renderAsk();

    expect(screen.getByText('Suggested Inquiries')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Cash-flow forecast and vCFO/i }));

    expect(
      screen.getByRole('heading', { name: 'Cash-flow forecast and vCFO variance brief' }),
    ).toBeInTheDocument();
    expect(screen.getByText('General information only.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /sign off/i }));
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(mocks.signOff).toHaveBeenCalledWith('note-1');
    expect(mocks.dismiss).toHaveBeenCalledWith('note-1');
  });

  it('runs an advisor scenario through the advisor function and opens the returned note', async () => {
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, advice_note_id: 'note-1' }),
      });

    renderAsk();
    await waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith(
        'https://supabase.test/functions/v1/advisor',
        expect.objectContaining({ method: 'OPTIONS' }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Run Forecast/i }));

    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    const postCall = mocks.fetch.mock.calls.find(
      ([, init]) => (init as RequestInit).method === 'POST',
    ) as [string, RequestInit];
    const [url, init] = postCall;
    expect(url).toBe('https://supabase.test/functions/v1/advisor');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer token-1',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      organization_id: 'org-1',
      mode: 'forecast',
    });
    await waitFor(() => expect(mocks.refreshAdvice).toHaveBeenCalled());
    expect(await screen.findByText('Advisor note created.')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Cash-flow forecast and vCFO variance brief' }),
    ).toBeInTheDocument();
  });

  it('disables advisor actions when the advice-note backend is unavailable', () => {
    setAdviceState([], {
      backendAvailable: false,
      unavailableMessage: 'Advisor notes are not deployed in this Supabase project yet.',
    });

    renderAsk();

    expect(screen.getByRole('button', { name: /Run Forecast/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Refresh/i })).toBeDisabled();
    expect(
      screen.getByText('Advisor notes are not deployed in this Supabase project yet.'),
    ).toBeInTheDocument();
  });

  it('disables advisor actions when the advisor edge function is not deployed', async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    renderAsk();

    expect(
      await screen.findByText(
        'Advisor edge function is not deployed to this Supabase project yet.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run Forecast/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Refresh/i })).toBeDisabled();
  });

  it('keeps the existing ask-bot chat flow working', async () => {
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          route: 'knowledge',
          answer: 'GST answer from ask-bot.',
          sonar_citations: [],
        }),
      });

    renderAsk();
    await waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith(
        'https://supabase.test/functions/v1/advisor',
        expect.objectContaining({ method: 'OPTIONS' }),
      ),
    );
    fireEvent.change(screen.getByPlaceholderText(/Ask anything/i), {
      target: { value: 'What is GST?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findAllByText('GST answer from ask-bot.')).toHaveLength(2);
    const askCall = mocks.fetch.mock.calls.find(
      ([url]) => url === 'https://supabase.test/functions/v1/ask-bot',
    ) as [string, RequestInit];
    const [url, init] = askCall;
    expect(url).toBe('https://supabase.test/functions/v1/ask-bot');
    expect(JSON.parse(init.body as string)).toMatchObject({
      organization_id: 'org-1',
      question: 'What is GST?',
    });
  });
});
