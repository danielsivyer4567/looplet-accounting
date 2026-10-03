/**
 * FAKE-01: the Receipt Hub must never post a made-up receipt into the real books or show invented
 * figures. The old "POS simulator" posted a fixed Bunnings Trade sale (with Bunnings' real ABN) through
 * receipt-webhook, which created a real bill and GST credit, and a phone mock-up showed hard-coded
 * totals and fake payees. Real capture (typed receipt, photo/PDF, POS bridge) must keep working.
 */
import { readFileSync } from 'node:fs';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ReceiptHubPage } from '@/pages/ReceiptHub';
import { mockSupabaseResponse, supabase } from '@/test/mocks/supabase';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

// A stable org object: the page reloads whenever currentOrg changes identity.
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

const fetchMock = vi.fn();

// Text that only ever came from the simulator or the phone mock-up.
const DEMO_MARKERS = [
  /bunnings/i,
  /26 008 672 179/,
  /pos simulator/i,
  /running simulator/i,
  /\$129,493\.75/,
  /\$129,133\.75/,
  /jackson ryan/i,
  /paul finch/i,
  /pine frame/i,
  /payable pulse/i,
];

describe('Receipt Hub has no simulator, demo receipt or hard-coded figures (FAKE-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_SUPABASE_URL', 'https://looplet.supabase.co');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    mockSupabaseResponse({ data: [], error: null });
    (supabase.rpc as unknown as Mock).mockImplementation((name: string) =>
      Promise.resolve(
        name === 'issue_receipt_identity'
          ? {
              data: [{ id: 'rid-1', receipt_token: 'rhp_owner.secret', token_prefix: 'rhp_owner' }],
              error: null,
            }
          : { data: [], error: null },
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders no simulator control, demo merchant, fake totals or fake payees', async () => {
    render(<ReceiptHubPage />);
    await waitFor(() => expect(supabase.from).toHaveBeenCalledWith('receipt_events'));
    expect(await screen.findByText('Receipt Hub')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /simulat/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/mobile app preview/i)).not.toBeInTheDocument();
    const html = document.body.innerHTML;
    for (const marker of DEMO_MARKERS) {
      expect(html, `found demo marker ${marker}`).not.toMatch(marker);
    }
    // With no receipts, the empty state points at real capture, not at a simulator.
    expect(await screen.findByText(/no receipts captured yet/i)).toBeInTheDocument();
  });

  it('never calls receipt-webhook unless the owner captures a real receipt', async () => {
    render(<ReceiptHubPage />);
    await waitFor(() => expect(supabase.from).toHaveBeenCalledWith('receipt_sync_jobs'));
    fireEvent.click(screen.getByRole('button', { name: /generate pass/i }));
    expect(await screen.findByText('Scan this at POS')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still captures a typed receipt through receipt-webhook with what the owner entered', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, receipt_event_id: 'evt-12345678', bill_id: 'bill-1' }),
    });
    render(<ReceiptHubPage />);
    await waitFor(() => expect(supabase.from).toHaveBeenCalledWith('receipt_events'));

    fireEvent.change(screen.getByPlaceholderText(/supplier or store name/i), {
      target: { value: 'Corner Hardware' },
    });
    fireEvent.change(screen.getByPlaceholderText('360.00'), { target: { value: '55.00' } });
    fireEvent.change(screen.getByLabelText(/^gst/i, { selector: 'input' }), {
      target: { value: '5.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: /capture receipt/i }));

    expect(await screen.findByText(/captured receipt event evt-1234/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://looplet.supabase.co/functions/v1/receipt-webhook');
    const body = JSON.parse(String(init.body)) as {
      organization_id: string;
      identity_token: string;
      source_channel: string;
      idempotency_key: string;
      payload: {
        merchant: { name: string; abn?: string };
        receipt: { total_inc_gst_cents: number; gst_cents: number };
      };
    };
    expect(body.organization_id).toBe('org-1');
    expect(body.identity_token).toBe('rhp_owner.secret');
    expect(body.source_channel).toBe('epost');
    expect(body.idempotency_key).toMatch(/^manual:/);
    expect(body.payload.merchant).toEqual({ name: 'Corner Hardware' });
    expect(body.payload.receipt.total_inc_gst_cents).toBe(5500);
    expect(body.payload.receipt.gst_cents).toBe(500);
  });

  it('keeps the demo payload builder and simulator navigation out of the source', () => {
    const page = readFileSync('src/pages/ReceiptHub.tsx', 'utf8');
    expect(page).not.toMatch(/buildDemoReceiptPayload|runPosSimulator|bunnings-demo|DEMO-TERM/);
    expect(page).not.toMatch(/26 008 672 179/);
    const layout = readFileSync('src/components/Layout.tsx', 'utf8');
    expect(layout).not.toMatch(/simulat|demo/i);
  });
});
