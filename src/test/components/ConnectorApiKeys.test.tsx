import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ConnectorApiKeys } from '@/components/settings/ConnectorApiKeys';
import { supabase } from '@/lib/supabase';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

interface SelectCall {
  table: string;
  columns: string;
}

const selectCalls: SelectCall[] = [];

let keyRows: unknown[] = [];
let logRows: unknown[] = [];

function tableData(table: string): unknown[] {
  if (table === 'api_keys') return keyRows;
  if (table === 'api_request_log') return logRows;
  return [];
}

function queryBuilder(table: string) {
  const chain: Record<string, unknown> = {};
  const result = () => Promise.resolve({ data: tableData(table), error: null });

  chain.select = (columns: string) => {
    selectCalls.push({ table, columns });
    return chain;
  };

  for (const method of ['eq', 'order', 'limit']) {
    chain[method] = () => chain;
  }

  chain.then = (resolve: (value: unknown) => unknown) => result().then(resolve);

  return chain;
}

describe('ConnectorApiKeys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectCalls.length = 0;
    keyRows = [
      {
        id: 'key-1',
        name: 'Main connector',
        key_prefix: 'llp_main',
        scopes: ['read:financials', 'write:bills'],
        last_used_at: '2026-07-01T01:00:00Z',
        expires_at: null,
        revoked_at: null,
        created_at: '2026-07-01T00:00:00Z',
        rate_limit_per_min: 120,
      },
    ];
    logRows = [
      {
        id: 1,
        key_prefix: 'llp_main',
        endpoint: 'ingest',
        method: 'POST',
        ingest_type: 'bill',
        status: 200,
        ts: '2026-07-01T01:01:00Z',
      },
    ];

    (supabase.from as unknown as Mock).mockImplementation((table: string) => queryBuilder(table));
    (supabase.rpc as unknown as Mock).mockResolvedValue({ data: null, error: null });
  });

  it('lists connector keys and recent API calls without selecting the stored hash', async () => {
    render(<ConnectorApiKeys organizationId="org-1" />);

    expect(screen.getByLabelText(/loading connector api keys/i)).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(await screen.findByText(/Main connector · llp_main/)).toBeInTheDocument();
    expect(screen.getByText(/ingest · 200/)).toBeInTheDocument();
    expect(screen.queryByText(/^loading/i)).not.toBeInTheDocument();

    const keySelect = selectCalls.find((call) => call.table === 'api_keys');
    expect(keySelect?.columns).toContain('key_prefix');
    expect(keySelect?.columns).not.toContain('hashed_key');
  });

  it('issues a scoped key and displays the one-time secret', async () => {
    keyRows = [];
    logRows = [];
    (supabase.rpc as unknown as Mock).mockResolvedValueOnce({
      data: [{ id: 'key-new', api_key: 'llp_new.secret', key_prefix: 'llp_new' }],
      error: null,
    });

    render(<ConnectorApiKeys organizationId="org-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /issue key/i }));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Portal connector' } });
    fireEvent.click(screen.getByLabelText('write:bills'));
    fireEvent.click(screen.getByRole('button', { name: /create key/i }));

    expect(await screen.findByText('llp_new.secret')).toBeInTheDocument();
    expect(supabase.rpc).toHaveBeenCalledWith(
      'issue_api_key',
      expect.objectContaining({
        p_organization_id: 'org-1',
        p_name: 'Portal connector',
        p_scopes: ['read:financials', 'write:bills'],
        p_rate_limit_per_min: 120,
      }),
    );
  });

  it('revokes an active key through the audit-preserving RPC', async () => {
    render(<ConnectorApiKeys organizationId="org-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /revoke main connector/i }));

    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('revoke_api_key', { p_key_id: 'key-1' }),
    );
  });
});
