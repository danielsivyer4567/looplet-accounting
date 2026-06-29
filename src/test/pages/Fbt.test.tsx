import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ApprovalRow } from '@/hooks/useApprovals';
import type { FbtReturnPayload } from '@/hooks/useFbtReturn';

const h = vi.hoisted(() => ({
  fbt: {
    fbtReturn: null as FbtReturnPayload | null,
    approvalPayload: null as Record<string, unknown> | null,
    loading: false,
    error: null as string | null,
    refresh: vi.fn(),
  },
  approvals: {
    pending: [] as ApprovalRow[],
    isApprovedResult: false,
    requestApproval: vi.fn(),
    refresh: vi.fn(),
  },
}));

vi.mock('@/hooks/useFbtReturn', () => {
  return {
    fbtYearLabel: (year: number) => `FBT ${year}`,
    latestCompletedFbtYearEndYear: () => 2026,
    useFbtReturn: () => h.fbt,
  };
});

vi.mock('@/hooks/useApprovals', () => ({
  useApprovals: () => ({
    pending: h.approvals.pending,
    loading: false,
    error: null,
    refresh: h.approvals.refresh,
    approve: vi.fn(),
    reject: vi.fn(),
    requestApproval: h.approvals.requestApproval,
    isApproved: vi.fn(async () => h.approvals.isApprovedResult),
  }),
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({ currentOrg: { id: 'org-1', name: 'Test Org' } }),
}));

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

import { FbtReportPage } from '@/pages/reports/Fbt';

const FBT_RETURN: FbtReturnPayload = {
  schema_version: 'build_fbt_return:v1',
  organization_id: 'org-1',
  fbt_year_end_year: 2026,
  period_start: '2025-04-01',
  period_end: '2026-03-31',
  due_date: '2026-05-21',
  registration: {
    is_fbt_registered: true,
    employees_count: 4,
    vehicle_count: 1,
    has_logbook: true,
  },
  rates: {
    fbt_year_end_year: 2026,
    fbt_rate_bps: 4700,
    type_1_gross_up_rate_bps: 20802,
    type_2_gross_up_rate_bps: 18868,
    source_label: 'ATO FBT rates and thresholds 2026',
    source_url:
      'https://www.ato.gov.au/tax-rates-and-codes/fringe-benefits-tax-rates-and-thresholds',
  },
  summary: {
    type_1_taxable_value_cents: 1_000_000,
    type_2_taxable_value_cents: 200_000,
    aggregate_taxable_value_cents: 1_200_000,
    employee_contributions_cents: 50_000,
    exempt_taxable_value_cents: 100_000,
    grossed_up_taxable_amount_cents: 2_457_560,
    fbt_payable_cents: 1_155_053,
  },
  benefits: [
    {
      id: 'benefit-1',
      benefit_kind: 'car',
      description: 'Director ute private use',
      employee_reference: 'Director',
      taxable_value_cents: 1_050_000,
      employee_contribution_cents: 50_000,
      net_taxable_value_cents: 1_000_000,
      gross_up_type: 'type_1',
      is_exempt: false,
      exempt_reason: null,
      source_reference: 'logbook',
    },
  ],
  evidence: {
    source_tables: ['fbt_benefit_inputs', 'business_profile', 'fbt_rates'],
    input_hash: 'abcd'.repeat(16),
    source_version: 'build_fbt_return:v1',
  },
  approval: {
    resource_type: 'fbt_return',
    resource_id: 'org-1:2026',
    payload_rpc: 'fbt_return_approval_payload',
  },
  warnings: [],
  lodgement: {
    enabled: false,
    reason: 'FBT return builder is draft-only',
  },
};

beforeEach(() => {
  h.fbt = {
    fbtReturn: FBT_RETURN,
    approvalPayload: {
      kind: 'fbt_return_approve',
      organization_id: 'org-1',
      fbt_year_end_year: 2026,
      resource_id: 'org-1:2026',
      input_hash: FBT_RETURN.evidence.input_hash,
      fbt_payable_cents: FBT_RETURN.summary.fbt_payable_cents,
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
  };
  h.approvals = {
    pending: [],
    isApprovedResult: false,
    requestApproval: vi.fn(),
    refresh: vi.fn(),
  };
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <FbtReportPage />
    </MemoryRouter>,
  );

describe('FbtReportPage', () => {
  it('renders the draft FBT return, benefit rows and evidence', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: 'FBT Return' })).toBeInTheDocument();
    expect(screen.getByText('$12,000.00')).toBeInTheDocument();
    expect(screen.getByText('$24,575.60')).toBeInTheDocument();
    expect(screen.getByText('$11,550.53')).toBeInTheDocument();
    expect(screen.getByText('Director ute private use')).toBeInTheDocument();
    expect(screen.getByText(FBT_RETURN.evidence.input_hash)).toBeInTheDocument();
    expect(screen.getByText(/draft-only/)).toBeInTheDocument();
  });

  it('opens a Tier-2 approval bound to the FBT approval payload', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /Request approval/i }));

    await waitFor(() => expect(h.approvals.requestApproval).toHaveBeenCalledTimes(1));
    expect(h.approvals.requestApproval).toHaveBeenCalledWith(
      'fbt_return',
      'org-1:2026',
      expect.objectContaining({
        kind: 'fbt_return_approve',
        resource_id: 'org-1:2026',
        input_hash: FBT_RETURN.evidence.input_hash,
      }),
    );
  });

  it('shows pending approval and refreshes status', async () => {
    h.approvals.pending = [
      {
        id: 'approval-1',
        organization_id: 'org-1',
        risk_tier: 'tier2_approve',
        status: 'pending',
        resource_type: 'fbt_return',
        resource_id: 'org-1:2026',
        payload_hash: 'hash',
        requested_by: null,
        requested_at: '2026-05-01T00:00:00Z',
        resolved_by: null,
        resolved_at: null,
        reject_reason: null,
        created_at: '2026-05-01T00:00:00Z',
      },
    ];
    renderPage();

    expect(screen.getByText('Pending approval')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approval requested/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Check status/i }));

    await waitFor(() => expect(h.fbt.refresh).toHaveBeenCalledTimes(1));
    expect(h.approvals.refresh).toHaveBeenCalledTimes(1);
  });

  it('degrades when the RPC is unavailable', () => {
    h.fbt = {
      fbtReturn: null,
      approvalPayload: null,
      loading: false,
      error: 'build_fbt_return: no business_profile',
      refresh: vi.fn(),
    };
    renderPage();

    expect(screen.getByText(/FBT return unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/No FBT return is available/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Request approval/i })).toBeDisabled();
  });
});
