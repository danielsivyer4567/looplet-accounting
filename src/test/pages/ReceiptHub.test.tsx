import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ReceiptHubPage } from '@/pages/ReceiptHub';
import { mockSupabaseResponse, supabase } from '@/test/mocks/supabase';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: [{ id: 'org-1', name: 'Test Org', organization_type: 'standard' }],
    currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe('ReceiptHubPage POS bridge setup copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_SUPABASE_URL', 'https://looplet.supabase.co');
    mockSupabaseResponse({ data: [], error: null });
    (supabase.rpc as unknown as Mock).mockImplementation(() =>
      Promise.resolve({ data: [], error: null }),
    );
  });

  it('explains that the bridge identity token is a fallback and production receipts carry scanned identities', async () => {
    render(<ReceiptHubPage />);

    expect(await screen.findByText('POS bridge setup')).toBeInTheDocument();
    expect(
      screen.getByText(/fallback\/readiness receipt identity token/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/customer's scanned Looplet identity per receipt/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText('https://looplet.supabase.co/functions/v1/receipt-webhook'),
    ).toBeInTheDocument();
    expect(screen.getByText('Business side must have')).toBeInTheDocument();
    expect(
      screen.getByText(/POS webhook\/API, vendor plugin, cloud connector, or Looplet bridge/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Stable POS receipt\/payment event id/i)).toBeInTheDocument();
    expect(screen.getByText(/scheduled task enabled with healthy run logs/i)).toBeInTheDocument();
    expect(screen.getByText(/Customer-scanned Looplet identity_token/i)).toBeInTheDocument();
    expect(screen.getByText(/Site manifest records POS merchant_name/i)).toBeInTheDocument();
    expect(screen.getByText(/completed POS trigger, source format, and field capture method/i)).toBeInTheDocument();
    expect(screen.getByText(/refund\/void original sale references/i)).toBeInTheDocument();
    expect(screen.getByText(/Integration profile passes integration-fit\.mjs/i)).toBeInTheDocument();
    expect(screen.getByText('Go-live evidence must prove')).toBeInTheDocument();
    expect(screen.getByText(/Keep pos-integration-profile\.json for --fit-profile/i)).toBeInTheDocument();
    expect(screen.getByText(/archive pos-integration-fit\.json as the fit result/i)).toBeInTheDocument();
    expect(screen.getByText(/real POS sale, refund, and void field samples/i)).toBeInTheDocument();
    expect(screen.getByText(/Connector mode, receipt source format, and field capture method match/i)).toBeInTheDocument();
    expect(screen.getByText(/Refund and void field samples point back to the sale/i)).toBeInTheDocument();
    expect(screen.getByText(/Run go-live\.mjs with --fit-profile pos-integration-profile\.json/i)).toBeInTheDocument();
    expect(screen.getByText(/Verifier field-file reconciliation matches/i)).toBeInTheDocument();
    expect(screen.getByText(/EFTPOS-only data can confirm payment/i)).toBeInTheDocument();
    expect(screen.queryByText(/LOOPLET_BRIDGE_INBOX=/)).not.toBeInTheDocument();

    await waitFor(() => expect(supabase.from).toHaveBeenCalledWith('receipt_events'));
  });

  it('renders an issued receipt identity as a scannable POS pass barcode', async () => {
    (supabase.rpc as unknown as Mock).mockResolvedValue({
      data: [
        {
          id: 'rid-1',
          receipt_token: 'rhp_customer.receiptsecret',
          token_prefix: 'rhp_customer',
        },
      ],
      error: null,
    });

    render(<ReceiptHubPage />);

    fireEvent.click(await screen.findByRole('button', { name: /generate pass/i }));

    expect(await screen.findByText('Scan this at POS')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /pos scannable receipt identity barcode/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('rhp_customer.receiptsecret')).toBeInTheDocument();
    expect(screen.getByText(/cashier scans this Looplet identity before tender/i)).toBeInTheDocument();
    expect(supabase.rpc).toHaveBeenCalledWith(
      'issue_receipt_identity',
      expect.objectContaining({
        p_channel: 'phone-pass',
        p_organization_id: 'org-1',
      }),
    );
  });

  it('renders an install env file that matches the POS bridge runtime variable names', async () => {
    (supabase.rpc as unknown as Mock).mockImplementation((name: string) => {
      if (name === 'issue_receipt_identity') {
        return Promise.resolve({
          data: [{ id: 'rid-1', receipt_token: 'rhp_pos.receiptsecret', token_prefix: 'rhp_pos' }],
          error: null,
        });
      }
      if (name === 'issue_api_key') {
        return Promise.resolve({
          data: [{ id: 'key-1', api_key: 'llp_pos.apisecret', key_prefix: 'llp_pos' }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
    });

    render(<ReceiptHubPage />);

    fireEvent.click(await screen.findByRole('button', { name: /generate config/i }));

    expect(await screen.findByText(/LOOPLET_BRIDGE_INBOX_DIR=/)).toBeInTheDocument();
    expect(screen.getByText(/LOOPLET_BRIDGE_LOG_DIR=/)).toBeInTheDocument();
    expect(screen.getByText(/LOOPLET_BRIDGE_MIN_FILE_AGE_MS=1000/)).toBeInTheDocument();
    expect(screen.queryByText(/LOOPLET_BRIDGE_INBOX=/)).not.toBeInTheDocument();
    expect(screen.getByText(/LOOPLET_RECEIPT_WEBHOOK_URL=https:\/\/looplet\.supabase\.co\/functions\/v1\/receipt-webhook/)).toBeInTheDocument();
    expect(supabase.rpc).toHaveBeenCalledWith(
      'issue_api_key',
      expect.objectContaining({
        p_scopes: ['write:receipts'],
        p_rate_limit_per_min: 120,
      }),
    );
  });
});
