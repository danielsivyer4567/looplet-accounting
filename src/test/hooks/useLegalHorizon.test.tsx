import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLegalHorizon, type LegalHorizonRow } from '@/hooks/useLegalHorizon';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mocks.from,
    functions: {
      invoke: mocks.invoke,
    },
  },
}));

const row: LegalHorizonRow = {
  id: 'horizon-1',
  title: 'Payday super start date',
  summary: 'Super guarantee would move to payday reporting.',
  topic: 'superannuation',
  stage: 'before_parliament',
  confidence: 0.82,
  proposed_effective_from: '2026-07-01',
  source_url: 'https://treasury.gov.au/example',
  source_excerpt: 'Example source text',
  first_seen_at: '2026-06-01T00:00:00Z',
  last_seen_at: '2026-06-01T00:00:00Z',
};

// A chainable stand-in for a Supabase query builder. Typed explicitly because each method returns the object itself.
type TableQuery = Record<string, ReturnType<typeof vi.fn>>;

function tableQuery(data: unknown, error: { message: string } | null = null) {
  const query: TableQuery = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    is: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    then: vi.fn((resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data, error }).then(resolve),
    ),
  };
  return query;
}

describe('useLegalHorizon', () => {
  beforeEach(() => {
    mocks.from.mockReset();
    mocks.invoke.mockReset();
  });

  it('loads open legal horizon rows from the global radar table', async () => {
    const query = tableQuery([row]);
    mocks.from.mockReturnValueOnce(query);

    const { result } = renderHook(() => useLegalHorizon());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mocks.from).toHaveBeenCalledWith('legal_horizon');
    expect(query.eq).toHaveBeenCalledWith('status', 'open');
    expect(query.is).toHaveBeenCalledWith('deleted_at', null);
    expect(result.current.items).toEqual([row]);
    expect(result.current.error).toBeNull();
  });

  it('runs the authenticated Sonar trigger and refreshes rows after success', async () => {
    mocks.from.mockReturnValueOnce(tableQuery([])).mockReturnValueOnce(tableQuery([row]));
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: true,
        stats: { scanned: 1, inserted: 1, updated: 0, skipped: 0, dropped: 0 },
      },
      error: null,
    });

    const { result } = renderHook(() => useLegalHorizon());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = false;
    await act(async () => {
      ok = await result.current.runSonarScan();
    });

    expect(ok).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith('legal-horizon-run', { body: {} });
    expect(result.current.scanStatus).toMatch(/Sonar scan complete/i);
    expect(result.current.scanStatus).toMatch(/1 new item/i);
    expect(result.current.items).toEqual([row]);
    expect(result.current.scanBusy).toBe(false);
  });

  it('surfaces scan failures without replacing the current radar rows', async () => {
    mocks.from.mockReturnValueOnce(tableQuery([row]));
    mocks.invoke.mockResolvedValueOnce({
      data: {
        ok: false,
        error: 'Only accountants, admins, or owners can run legal horizon scans.',
      },
      error: null,
    });

    const { result } = renderHook(() => useLegalHorizon());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = true;
    await act(async () => {
      ok = await result.current.runSonarScan();
    });

    expect(ok).toBe(false);
    expect(result.current.items).toEqual([row]);
    expect(result.current.error).toMatch(/Only accountants/i);
  });
});
