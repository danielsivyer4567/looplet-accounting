import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeys } from '@/components/settings/ApiKeys';
import { supabase } from '@/test/mocks/supabase';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

let currentOrg: { id: string; name: string } | null = { id: 'org-1', name: 'Demo Org' };

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({ currentOrg }),
}));

interface ApiKeyFixture {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  rate_limit_per_min: number;
}

interface AuditFixture {
  id: string;
  api_key_id: string | null;
  key_prefix: string | null;
  endpoint: string;
  method: string;
  ingest_type: string | null;
  status: number;
  ts: string;
}

const apiKeyRows: ApiKeyFixture[] = [
  {
    id: 'key-1',
    name: 'POS bridge',
    key_prefix: 'llp_pos1234',
    scopes: ['write:receipts'],
    created_at: '2026-06-29T00:00:00.000Z',
    last_used_at: '2026-06-29T01:00:00.000Z',
    expires_at: null,
    revoked_at: null,
    rate_limit_per_min: 120,
  },
];

const auditRows: AuditFixture[] = [
  {
    id: 'audit-1',
    api_key_id: 'key-1',
    key_prefix: 'llp_pos1234',
    endpoint: 'receipt-webhook',
    method: 'POST',
    ingest_type: 'receipt',
    status: 202,
    ts: '2026-06-29T02:00:00.000Z',
  },
];

const selectedColumns: Record<string, string[]> = {};

function mockQuery(table: string) {
  const chain: Record<string, unknown> = {};
  const resolve = () =>
    Promise.resolve({
      data: table === 'api_keys' ? apiKeyRows : auditRows,
      error: null,
    });

  chain.select = (columns: string) => {
    selectedColumns[table] = [...(selectedColumns[table] ?? []), columns];
    return chain;
  };
  chain.eq = () => chain;
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.then = (callback: (value: unknown) => unknown) => resolve().then(callback);

  return chain;
}

describe('ApiKeys', () => {
  beforeEach(() => {
    currentOrg = { id: 'org-1', name: 'Demo Org' };
    selectedColumns.api_keys = [];
    selectedColumns.api_request_log = [];
    supabase.from = vi.fn((table: string) => mockQuery(table)) as typeof supabase.from;
    supabase.rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('lists non-secret key metadata and recent audit rows', async () => {
    render(<ApiKeys />);

    expect(await screen.findByText('POS bridge')).toBeInTheDocument();
    expect(screen.getAllByText('llp_pos1234')).toHaveLength(2);
    expect(screen.getByText('receipt-webhook')).toBeInTheDocument();
    expect(screen.getByText('202')).toBeInTheDocument();

    expect((selectedColumns.api_keys ?? []).join(' ')).not.toContain('hashed_key');
    expect((selectedColumns.api_keys ?? []).join(' ')).toContain('key_prefix');
    expect((selectedColumns.api_request_log ?? []).join(' ')).toContain('endpoint');
  });

  it('issues a key through the RPC and shows the one-time secret', async () => {
    supabase.rpc = vi.fn().mockResolvedValue({
      data: [{ id: 'key-2', key_prefix: 'llp_new1234', api_key: 'llp_new1234.secret' }],
      error: null,
    });

    render(<ApiKeys />);

    fireEvent.change(await screen.findByLabelText(/Key name/i), {
      target: { value: 'Nightly importer' },
    });
    fireEvent.click(screen.getByLabelText(/Write bills/i));
    fireEvent.click(screen.getByRole('button', { name: /Issue key/i }));

    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('issue_api_key', expect.anything()),
    );
    expect(supabase.rpc).toHaveBeenCalledWith(
      'issue_api_key',
      expect.objectContaining({
        p_organization_id: 'org-1',
        p_name: 'Nightly importer',
        p_scopes: ['read:financials', 'write:bills'],
        p_expires_at: null,
        p_rate_limit_per_min: 120,
      }),
    );
    expect(await screen.findByText('llp_new1234.secret')).toBeInTheDocument();
  });

  it('revokes keys through the RPC lifecycle', async () => {
    render(<ApiKeys />);

    fireEvent.click(await screen.findByRole('button', { name: /Revoke/i }));

    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('revoke_api_key', { p_key_id: 'key-1' }),
    );
  });

  it('renders nothing without an active org', () => {
    currentOrg = null;
    const { container } = render(<ApiKeys />);
    expect(container.firstChild).toBeNull();
  });
});
