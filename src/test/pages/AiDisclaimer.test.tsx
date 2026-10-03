/**
 * AI-01: AI answers and advisor notes are labelled general information, with a pointer to a
 * registered tax agent. Before this, Ask showed answers "tailored" to the business with no label,
 * and the advice cards on the dashboard had none either (Tax Agent Services Act 2009 risk:
 * https://www.tpb.gov.au/tax-agent-services).
 */
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AskPage } from '@/pages/Ask';
import { AdviceCard } from '@/components/AdviceCard';
import type { AdviceNote } from '@/hooks/useAdviceNotes';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: mocks.getSession } },
}));

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

vi.mock('@/hooks/useAdviceNotes', () => ({
  useAdviceNotes: () => ({
    notes: [],
    loading: false,
    actionBusy: false,
    error: null,
    backendAvailable: true,
    unavailableMessage: null,
    refresh: vi.fn(),
    createNote: vi.fn(),
    signOff: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

const NOTICE = /general information only, not tax, financial or legal advice/i;
const AGENT = /registered tax agent or BAS agent/i;

const note: AdviceNote = {
  id: 'note-1',
  organization_id: 'org-1',
  kind: 'structuring',
  title: 'Structuring tax comparison',
  summary: 'Lowest modelled tax is company at $25,000.',
  inputs: {},
  numbers: { tax_diff_cents: 1234500 },
  assumptions: {},
  citations: [],
  disclaimer: '',
  registered_agent_signoff_by: null,
  registered_agent_signoff_at: null,
  status: 'draft',
  created_at: '2026-06-27T00:00:00Z',
  updated_at: '2026-06-27T00:00:00Z',
  created_by: 'user-1',
  deleted_at: null,
};

describe('AI answers are labelled general information (AI-01)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.test');
    vi.stubGlobal('fetch', mocks.fetch);
    Element.prototype.scrollIntoView = vi.fn();
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
    mocks.fetch.mockReset();
  });

  it('Ask states the notice before any question is asked', () => {
    mocks.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    render(
      <MemoryRouter>
        <AskPage />
      </MemoryRouter>,
    );
    const notice = screen.getByRole('note', { name: /general information notice/i });
    expect(notice).toHaveTextContent(NOTICE);
    expect(notice).toHaveTextContent(AGENT);
  });

  it('every AI answer carries the notice', async () => {
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'OPTIONS') return { ok: true, status: 204, json: async () => ({}) };
      expect(url).toBe('https://supabase.test/functions/v1/ask-bot');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          route: 'knowledge',
          answer: '**It depends.** The instant asset write-off has conditions.',
          citations: [],
          sonar_citations: [],
          data_rows: [],
          data_row_count: 0,
        }),
      };
    });
    render(
      <MemoryRouter>
        <AskPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Can I claim my ute?' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(screen.getByText(/instant asset write-off has conditions/i)));
    const notices = screen.getAllByRole('note', { name: /general information notice/i });
    // One at the top of the page and one under the answer.
    expect(notices).toHaveLength(2);
    const answerCard = screen.getByText(/instant asset write-off has conditions/i).closest('.card');
    expect(answerCard).not.toBeNull();
    expect(
      within(answerCard as HTMLElement).getByRole('note', { name: /general information notice/i }),
    ).toHaveTextContent(AGENT);
  });

  it('advice cards carry the notice even when a note has no disclaimer of its own', () => {
    render(<AdviceCard note={note} onOpen={vi.fn()} />);
    const card = screen.getByRole('article', { name: /advice card: structuring tax comparison/i });
    const notice = within(card).getByRole('note', { name: /general information notice/i });
    expect(notice).toHaveTextContent(NOTICE);
    expect(notice).toHaveTextContent(AGENT);
  });
});
