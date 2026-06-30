import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  tableCalls: [] as string[],
  fetch: vi.fn(),
  downloadBlob: vi.fn(),
  currentOrg: {
    id: 'org-1',
    name: 'Client Books',
    organization_type: 'standard',
    role_enum: 'accountant',
    accepted_at: '2026-06-30T00:00:00.000Z',
  },
  user: { id: 'user-1', email: 'advisor@example.test' },
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    currentOrg: mocks.currentOrg,
  }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: mocks.user,
  }),
}));

vi.mock('@/lib/download', () => ({
  downloadBlob: mocks.downloadBlob,
}));

vi.mock('@/lib/supabase', () => {
  function rowsFor(table: string) {
    if (table === 'accountant_sessions') {
      return [
        {
          id: 'session-1',
          started_at: '2026-06-30T00:00:00.000Z',
          ended_at: null,
          end_reason: null,
          pageview_count: 2,
          action_count: 1,
          total_seconds: null,
        },
      ];
    }
    if (table === 'accountant_activity_log') {
      return [
        {
          id: 'activity-1',
          occurred_at: '2026-06-30T00:05:00.000Z',
          event_type: 'pageview',
          path: '/bills',
          description: null,
          duration_ms: 64000,
          resource_type: null,
          resource_id: null,
        },
      ];
    }
    if (table === 'audit_log') {
      return [
        {
          id: 'audit-1',
          occurred_at: '2026-06-30T00:06:00.000Z',
          action: 'UPDATE',
          operation: 'UPDATE',
          resource_type: 'bill',
          resource_id: 'bill-1',
          table_name: 'bills',
          record_id: 'bill-1',
          changes: { status: ['received', 'verified'] },
        },
      ];
    }
    return [];
  }

  function chain(table: string) {
    const api: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'gte', 'lte', 'order']) {
      api[method] = vi.fn(() => api);
    }
    api.limit = vi.fn(() => Promise.resolve({ data: rowsFor(table), error: null }));
    return api;
  }

  return {
    supabase: {
      from: vi.fn((table: string) => {
        mocks.tableCalls.push(table);
        return chain(table);
      }),
      rpc: vi.fn((name: string, args: Record<string, unknown>) => {
        mocks.rpcCalls.push({ name, args });
        return Promise.resolve({
          data: {
            ok: true,
            proof_id: 'proof-1',
            snapshot_hash: 'abc123',
            summary: {
              activity_count: 1,
              audit_event_count: 1,
              invoice_seed: {
                description:
                  'Advisor work proof 2026-06-30 to 2026-06-30: 1 activity events, 1 audited write events',
              },
            },
            snapshot: { kind: 'advisor_work_proof', audit_log: [{ id: 'audit-1' }] },
          },
          error: null,
        });
      }),
      auth: {
        getSession: vi.fn(() =>
          Promise.resolve({
            data: { session: { access_token: 'token-1' } },
          }),
        ),
      },
    },
  };
});

import { AdvisorFinishButton } from '@/components/AdvisorFinishButton';

describe('AdvisorFinishButton', () => {
  beforeEach(() => {
    mocks.rpcCalls = [];
    mocks.tableCalls = [];
    mocks.fetch.mockReset();
    mocks.downloadBlob.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, recipient: 'advisor@example.test' }),
    });
  });

  it('opens the finish modal and saves a server-compiled proof', async () => {
    render(<AdvisorFinishButton />);

    fireEvent.click(screen.getByRole('button', { name: /finish/i }));

    expect(await screen.findByRole('dialog', { name: /finish work proof/i })).toBeInTheDocument();
    expect(await screen.findByText('/bills')).toBeInTheDocument();
    expect(await screen.findByText(/UPDATE bill/i)).toBeInTheDocument();
    expect(await screen.findByText(/Billing proof line/i)).toBeInTheDocument();
    expect(
      await screen.findByText(/1 activity events, 1 audited write events/i),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/optional note/i), {
      target: { value: 'Prepared June bills' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save in looplet/i }));

    await waitFor(() => {
      expect(mocks.rpcCalls).toEqual([
        expect.objectContaining({
          name: 'finish_advisor_work_session',
          args: expect.objectContaining({
            p_organization_id: 'org-1',
            p_note: 'Prepared June bills',
          }),
        }),
      ]);
    });
    expect(await screen.findByText(/Saved proof proof-1/i)).toBeInTheDocument();
  });

  it('emails the saved proof through accountant-session-digest', async () => {
    render(<AdvisorFinishButton />);

    fireEvent.click(screen.getByRole('button', { name: /finish/i }));
    await screen.findByRole('dialog', { name: /finish work proof/i });

    fireEvent.click(await screen.findByRole('button', { name: /email me/i }));

    await waitFor(() => {
      expect(mocks.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/functions/v1/accountant-session-digest'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer token-1' }),
          body: JSON.stringify({ proof_id: 'proof-1' }),
        }),
      );
    });
    expect(await screen.findByText(/Emailed proof to advisor@example.test/i)).toBeInTheDocument();
  });

  it('downloads the currently visible proof data', async () => {
    render(<AdvisorFinishButton />);

    fireEvent.click(screen.getByRole('button', { name: /finish/i }));
    await screen.findByRole('dialog', { name: /finish work proof/i });
    fireEvent.click(await screen.findByRole('button', { name: /download proof/i }));

    expect(mocks.downloadBlob).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.stringMatching(/^advisor-work-proof-/),
    );
  });
});
