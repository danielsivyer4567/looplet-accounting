import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useAdviceNotes,
  type AdviceNote,
  type AdviceNoteMutationResult,
} from '@/hooks/useAdviceNotes';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  org: {
    current: {
      id: 'org-1',
      name: 'Org One',
      organization_type: 'standard',
    } as {
      id: string;
      name: string;
      organization_type: 'standard' | 'agency' | 'sub_account';
    } | null,
  },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: mocks.from,
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

const baseNote: AdviceNote = {
  id: 'note-1',
  organization_id: 'org-1',
  kind: 'structuring',
  title: 'Fixture note',
  summary: 'Fixture summary',
  inputs: { source: 'test' },
  numbers: { tax_diff_cents: 100 },
  assumptions: {},
  citations: [],
  disclaimer: 'General information only.',
  registered_agent_signoff_by: null,
  registered_agent_signoff_at: null,
  status: 'draft',
  created_at: '2026-06-27T00:00:00Z',
  updated_at: '2026-06-27T00:00:00Z',
  created_by: 'user-1',
  deleted_at: null,
};

function rpcOk(data: unknown) {
  return Promise.resolve({ data, error: null });
}

function rpcError(message: string) {
  return Promise.resolve({ data: null, error: { message } });
}

function tableQuery(data: unknown, error: { message: string } | null = null) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    is: vi.fn(() => query),
    order: vi.fn(() => query),
    then: vi.fn((resolve) => Promise.resolve({ data, error }).then(resolve)),
  };
  return query;
}

function mutation(status: AdviceNoteMutationResult['status']): AdviceNoteMutationResult {
  return {
    ok: true,
    advice_note_id: 'note-1',
    organization_id: 'org-1',
    status,
  };
}

describe('useAdviceNotes', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.from.mockReset();
    mocks.org.current = {
      id: 'org-1',
      name: 'Org One',
      organization_type: 'standard',
    };
  });

  it('loads notes through the list_advice_notes RPC with optional filters', async () => {
    mocks.rpc.mockReturnValueOnce(rpcOk([baseNote]));

    const { result } = renderHook(() => useAdviceNotes({ kind: 'structuring', status: 'draft' }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mocks.rpc).toHaveBeenCalledWith('list_advice_notes', {
      p_org: 'org-1',
      p_kind: 'structuring',
      p_status: 'draft',
    });
    expect(result.current.notes).toEqual([baseNote]);
    expect(result.current.error).toBeNull();
    expect(result.current.backendAvailable).toBe(true);
  });

  it('falls back to the RLS-scoped table read when the list RPC is missing from schema cache', async () => {
    const query = tableQuery([baseNote]);
    mocks.rpc.mockReturnValueOnce(
      rpcError('Could not find the function public.list_advice_notes(p_kind, p_org, p_status)'),
    );
    mocks.from.mockReturnValueOnce(query);

    const { result } = renderHook(() => useAdviceNotes({ kind: 'structuring', status: 'draft' }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mocks.from).toHaveBeenCalledWith('advice_notes');
    expect(query.select).toHaveBeenCalledWith('*');
    expect(query.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(query.eq).toHaveBeenCalledWith('kind', 'structuring');
    expect(query.eq).toHaveBeenCalledWith('status', 'draft');
    expect(query.is).toHaveBeenCalledWith('deleted_at', null);
    expect(result.current.notes).toEqual([baseNote]);
    expect(result.current.error).toBeNull();
    expect(result.current.backendAvailable).toBe(true);
  });

  it('marks the advice-note backend unavailable when the table is missing from schema cache', async () => {
    const query = tableQuery(null, {
      message: "Could not find the table 'public.advice_notes' in the schema cache",
    });
    mocks.rpc.mockReturnValueOnce(
      rpcError('Could not find the function public.list_advice_notes(p_kind, p_org, p_status)'),
    );
    mocks.from.mockReturnValueOnce(query);

    const { result } = renderHook(() => useAdviceNotes());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.notes).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.backendAvailable).toBe(false);
    expect(result.current.unavailableMessage).toBe(
      'Advisor notes are not deployed in this Supabase project yet.',
    );
  });

  it('creates a note through create_advice_note and refreshes the list', async () => {
    const created = { ...baseNote, id: 'note-2', title: 'Created note' };
    mocks.rpc
      .mockReturnValueOnce(rpcOk([]))
      .mockReturnValueOnce(
        rpcOk({ ...mutation('draft'), advice_note_id: 'note-2', kind: 'forecast' }),
      )
      .mockReturnValueOnce(rpcOk([created]));

    const { result } = renderHook(() => useAdviceNotes());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let response: AdviceNoteMutationResult | undefined;
    await act(async () => {
      response = await result.current.createNote({
        kind: 'forecast',
        title: 'Created note',
        summary: 'Created summary',
        numbers: { revenue_cents: 123 },
      });
    });

    expect(response?.advice_note_id).toBe('note-2');
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'create_advice_note', {
      p_org: 'org-1',
      p_kind: 'forecast',
      p_title: 'Created note',
      p_summary: 'Created summary',
      p_inputs: {},
      p_numbers: { revenue_cents: 123 },
      p_assumptions: {},
      p_citations: [],
      p_disclaimer: null,
    });
    expect(result.current.notes).toEqual([created]);
  });

  it('signs off a note through sign_off_advice_note and refreshes the issued row', async () => {
    const issuedNote: AdviceNote = {
      ...baseNote,
      status: 'issued',
      registered_agent_signoff_by: 'user-1',
      registered_agent_signoff_at: '2026-06-27T00:05:00Z',
    };
    mocks.rpc
      .mockReturnValueOnce(rpcOk([baseNote]))
      .mockReturnValueOnce(rpcOk(mutation('issued')))
      .mockReturnValueOnce(rpcOk([issuedNote]));

    const { result } = renderHook(() => useAdviceNotes());
    await waitFor(() => expect(result.current.notes[0]?.status).toBe('draft'));

    let response: AdviceNoteMutationResult | undefined;
    await act(async () => {
      response = await result.current.signOff('note-1');
    });

    expect(response?.status).toBe('issued');
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'sign_off_advice_note', { p_id: 'note-1' });
    expect(result.current.notes[0]?.status).toBe('issued');
    expect(result.current.notes[0]?.registered_agent_signoff_by).toBe('user-1');
  });

  it('dismisses a note through dismiss_advice_note and clears state without an org', async () => {
    const dismissedNote: AdviceNote = { ...baseNote, status: 'dismissed' };
    mocks.rpc
      .mockReturnValueOnce(rpcOk([baseNote]))
      .mockReturnValueOnce(rpcOk(mutation('dismissed')))
      .mockReturnValueOnce(rpcOk([dismissedNote]));

    const { result, rerender } = renderHook(() => useAdviceNotes());
    await waitFor(() => expect(result.current.notes).toHaveLength(1));

    let response: AdviceNoteMutationResult | undefined;
    await act(async () => {
      response = await result.current.dismiss('note-1');
    });

    expect(response?.status).toBe('dismissed');
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'dismiss_advice_note', { p_id: 'note-1' });
    expect(result.current.notes[0]?.status).toBe('dismissed');

    mocks.org.current = null;
    rerender();
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.notes).toEqual([]);
  });
});
