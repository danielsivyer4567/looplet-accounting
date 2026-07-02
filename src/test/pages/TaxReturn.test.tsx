import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TaxReturn, TaxPayable } from '@/hooks/useTaxReturn';
import type { BookToTax, CgtCalc } from '@/hooks/useBookToTax';
import type { ApprovalRow } from '@/hooks/useApprovals';

/**
 * TaxReturnPage runtime test (SC-4.I.02 page + SC-4.I.03 approve-to-finalise gate).
 * Drives the page with mocked useTaxReturn / useBookToTax / useApprovals / useCgtEvents
 * so no Supabase/network is needed — the runtime look the check skill wants (Preview/
 * Chrome MCP is unavailable in this env, same as the BAS prep-card test). Asserts:
 *   - the entity-aware return, reconciliation, tax-payable waterfall and CGT schedule
 *     render for a company return; the page degrades (banner + empty card) on null RPCs;
 *   - "Approve return" calls request_approval (Tier-2);
 *   - "Finalise return" is GATED until a matching approval row exists (is_action_approved
 *     true), and finalising locks the draft read-only (CGT capture surface hidden).
 */

const h = vi.hoisted(() => ({
  ret: {
    taxReturn: null as TaxReturn | null,
    taxPayable: null as TaxPayable | null,
    loading: false,
    error: null as string | null,
    refresh: vi.fn(),
  },
  book: {
    bookToTax: null as BookToTax | null,
    cgt: null as CgtCalc | null,
    loading: false,
    error: null as string | null,
    refresh: vi.fn(),
  },
  approvals: {
    pending: [] as ApprovalRow[],
    isApprovedResult: false,
    requestApproval: vi.fn(),
    isApproved: vi.fn(),
    refresh: vi.fn(),
  },
}));

vi.mock('@/hooks/useTaxReturn', () => ({ useTaxReturn: () => h.ret }));
vi.mock('@/hooks/useBookToTax', () => ({ useBookToTax: () => h.book }));
vi.mock('@/hooks/useApprovals', () => ({
  useApprovals: () => ({
    pending: h.approvals.pending,
    loading: false,
    error: null,
    refresh: h.approvals.refresh,
    approve: vi.fn(),
    reject: vi.fn(),
    requestApproval: h.approvals.requestApproval,
    isApproved: h.approvals.isApproved,
  }),
}));
vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({ currentOrg: { id: 'org-1', name: 'Test Org' } }),
}));
// The embedded CgtEventsPanel pulls useCgtEvents (→ supabase); stub it to an empty list.
vi.mock('@/hooks/useCgtEvents', () => ({
  useCgtEvents: () => ({
    events: [],
    loading: false,
    error: null,
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
  costBaseCents: () => 0,
}));
vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

import { TaxReturnPage } from '@/pages/reports/TaxReturn';

const COMPANY_RETURN: TaxReturn = {
  entity_type: 'company',
  organization_id: 'org-1',
  fy_start_year: 2025,
  period_start: '2025-07-01',
  period_end: '2026-06-30',
  basis: 'cumulative_to_date',
  return_form: 'NAT 0656 Company tax return',
  item6_total_profit_or_loss: {
    income: {
      lines: [
        {
          account_code: '4000',
          account_name: 'Sales',
          form_item: '6',
          label_code: 'C',
          label_name: 'Gross income',
          amount_cents: 10_000_000,
        },
      ],
      total: {
        form_item: '6',
        label_code: 'S',
        label_name: 'Total income',
        amount_cents: 10_000_000,
      },
    },
    expenses: {
      lines: [
        {
          account_code: '5000',
          account_name: 'Subcontractors',
          form_item: '6',
          label_code: null,
          label_name: 'Expense',
          amount_cents: 3_000_000,
        },
      ],
      total: {
        form_item: '6',
        label_code: 'Q',
        label_name: 'Total expenses',
        amount_cents: 3_000_000,
      },
    },
    total_profit_or_loss: {
      form_item: '6',
      label_code: 'T',
      label_name: 'Total profit or loss',
      amount_cents: 7_000_000,
    },
  },
};

const TAX_PAYABLE: TaxPayable = {
  organization_id: 'org-1',
  fy_start_year: 2025,
  period_start: '2025-07-01',
  period_end: '2026-06-30',
  entity_type: 'company',
  taxable_income_cents: 7_310_000,
  rate_basis: {
    kind: 'company_flat',
    note: 'Company base-rate entity (25%)',
    rate: 0.25,
    base_rate_entity: true,
    turnover_cents: 1_000_000,
  },
  income_tax_cents: 1_827_500,
  medicare_levy_cents: 0,
  offsets: {
    non_refundable: {
      sbito_cents: 0,
      company_franking_cents: 0,
      total_cents: 0,
      unused_cents: 0,
      note: '',
    },
    refundable: {
      franking_cents: 0,
      payg_instalments_paid_cents: 2_000_000,
      total_cents: 2_000_000,
      note: '',
    },
  },
  tax_after_non_refundable_offsets_cents: 1_827_500,
  total_liability_cents: 1_827_500,
  net_tax_payable_cents: 0,
  net_refund_cents: 172_500,
  result: 'refundable',
  caveats: ['Passive-income ≤80% test deferred.'],
  note: '',
};

const BOOK_TO_TAX: BookToTax = {
  organization_id: 'org-1',
  fy_start_year: 2025,
  period_start: '2025-07-01',
  period_end: '2026-06-30',
  entity_type: 'company',
  basis: 'cumulative_to_date',
  accounting_profit_cents: 7_000_000,
  add_backs: {
    lines: [
      {
        account_code: '6710',
        account_name: 'Entertainment',
        amount_cents: 50_000,
        reason: 'Entertainment (Div 32)',
      },
    ],
    total_cents: 50_000,
  },
  depreciation_reconciliation: {
    book_depreciation_cents: 300_000,
    tax_depreciation_cents: 240_000,
    difference_cents: 60_000,
    note: '',
  },
  taxable_income_subtotal_cents: 7_110_000,
  capital_gains: {
    net_capital_gain_cents: 200_000,
    current_year_capital_gains_cents: 200_000,
    current_year_capital_losses_cents: 0,
    carried_forward_capital_losses_applied_cents: 0,
    net_capital_loss_carried_forward_cents: 0,
    source: 'cgt_calc',
  },
  franking: {
    credits_received_cents: 0,
    grossed_up_into_assessable_income: false,
    note: 'No franking credits',
  },
  assessable_income_before_losses_cents: 7_310_000,
  revenue_losses: {
    available_cents: 0,
    applied_cents: 0,
    current_year_loss_cents: 0,
    carried_forward_cents: 0,
    source: 'business_profile',
  },
  taxable_income_cents: 7_310_000,
  caveats: ['Single-balance revenue-loss input, not FY-keyed.'],
  note: '',
};

const CGT: CgtCalc = {
  organization_id: 'org-1',
  fy_start_year: 2025,
  period_start: '2025-07-01',
  period_end: '2026-06-30',
  entity_type: 'company',
  cgt_discount_rate: 0,
  sbe_eligible: false,
  size_condition: {
    passed: false,
    turnover_test: {
      passed: false,
      threshold_cents: 200_000_000,
      aggregated_turnover_cents: 1_000_000,
      turnover_bracket: 'under_2m',
      source: 'estimate',
      reason: '',
    },
    mnav_test: {
      passed: false,
      threshold_cents: 600_000_000,
      net_asset_value_cents: 0,
      total_assets_cents: 0,
      total_liabilities_cents: 0,
      basis: 'balance_sheet',
    },
  },
  event_count: 1,
  current_year_capital_gains_cents: 200_000,
  current_year_capital_losses_cents: 0,
  carried_forward_losses_available_cents: 0,
  carried_forward_losses_applied_cents: 0,
  discountable_gain_cents: 0,
  cgt_discount_cents: 0,
  active_asset_reduction_cents: 0,
  fifteen_year_exemption_cents: 0,
  retirement_exemption_elected_cents: 0,
  retirement_exemption_cap_remaining_cents: 0,
  retirement_exemption_applied_cents: 0,
  small_business_rollover_elected_cents: 0,
  small_business_rollover_deferred_cents: 0,
  sbe_election_clamped: false,
  net_capital_gain_before_discount_cents: 200_000,
  net_capital_gain_before_sbe_concessions_cents: 200_000,
  net_capital_gain_cents: 200_000,
  net_capital_loss_carried_forward_cents: 0,
  sbe_concession_caveats: [],
  events: [],
};

const withCompanyData = () => {
  h.ret = {
    taxReturn: COMPANY_RETURN,
    taxPayable: TAX_PAYABLE,
    loading: false,
    error: null,
    refresh: vi.fn(),
  };
  h.book = { bookToTax: BOOK_TO_TAX, cgt: CGT, loading: false, error: null, refresh: vi.fn() };
};

beforeEach(() => {
  h.ret = { taxReturn: null, taxPayable: null, loading: false, error: null, refresh: vi.fn() };
  h.book = { bookToTax: null, cgt: null, loading: false, error: null, refresh: vi.fn() };
  h.approvals.pending = [];
  h.approvals.isApprovedResult = false;
  h.approvals.requestApproval.mockReset();
  h.approvals.isApproved.mockReset();
  h.approvals.isApproved.mockImplementation(async () => h.approvals.isApprovedResult);
  h.approvals.refresh.mockReset();
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <TaxReturnPage />
    </MemoryRouter>,
  );

describe('TaxReturnPage (SC-4.I.02 / SC-4.I.03)', () => {
  it('uses a skeleton while the draft return is loading', () => {
    h.ret = { taxReturn: null, taxPayable: null, loading: true, error: null, refresh: vi.fn() };
    h.book = { bookToTax: null, cgt: null, loading: true, error: null, refresh: vi.fn() };

    renderPage();

    expect(screen.getByLabelText(/loading tax return draft/i)).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.queryByText(/loading draft return/i)).not.toBeInTheDocument();
  });

  it('renders the entity-aware return, reconciliation, tax-payable waterfall and CGT schedule', () => {
    withCompanyData();
    renderPage();

    expect(screen.getByText('Tax Return (Draft)')).toBeInTheDocument();
    expect(screen.getByText('Return labels')).toBeInTheDocument();
    expect(screen.getByText('Item 6 income')).toBeInTheDocument();
    expect(screen.getByText('Item 6 expenses')).toBeInTheDocument();
    expect(screen.getByText('Book-to-tax reconciliation')).toBeInTheDocument();
    expect(screen.getByText('Tax payable')).toBeInTheDocument();
    expect(screen.getByText('Capital gains (CGT)')).toBeInTheDocument();
    expect(screen.getByText('Company')).toBeInTheDocument();
    expect(screen.getByText('refundable')).toBeInTheDocument();
    expect(screen.getByText('CGT events')).toBeInTheDocument();
    expect(screen.getByText('Caveats & assumptions')).toBeInTheDocument();
    expect(screen.getByText(/Passive-income/)).toBeInTheDocument();

    // Finalisation gate present; Finalise is disabled until approved.
    expect(screen.getByText('Finalisation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Finalise return/i })).toBeDisabled();
  });

  it('degrades to the unavailable banner + empty-return card without crashing when the RPCs return null', () => {
    h.ret = {
      taxReturn: null,
      taxPayable: null,
      loading: false,
      error: 'build_return: feature_not_supported',
      refresh: vi.fn(),
    };
    h.book = {
      bookToTax: null,
      cgt: null,
      loading: false,
      error: 'book_to_tax: missing',
      refresh: vi.fn(),
    };
    renderPage();

    expect(screen.getByText(/Some figures are unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/No mapped return for this entity/)).toBeInTheDocument();
    expect(screen.getByText('CGT events')).toBeInTheDocument();
    // Nothing to approve → both gate actions are disabled.
    expect(screen.getByRole('button', { name: /Approve return/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Finalise return/i })).toBeDisabled();
  });

  it('"Approve return" opens a Tier-2 approval bound to the return (request_approval)', async () => {
    withCompanyData();
    renderPage();

    const approve = screen.getByRole('button', { name: /Approve return/i });
    expect(approve).not.toBeDisabled();
    fireEvent.click(approve);

    await waitFor(() => expect(h.approvals.requestApproval).toHaveBeenCalledTimes(1));
    expect(h.approvals.requestApproval).toHaveBeenCalledWith(
      'tax_return',
      'org-1',
      expect.objectContaining({ kind: 'tax_return_finalise' }),
    );
  });

  it('gates Finalise until an approval row exists, then locks the draft read-only', async () => {
    withCompanyData();
    h.approvals.isApprovedResult = true; // a matching approved Tier-2 row exists
    renderPage();

    const finalise = await screen.findByRole('button', { name: /Finalise return/i });
    // The is_action_approved check resolves async → Finalise enables once approved.
    await waitFor(() => expect(finalise).not.toBeDisabled());
    expect(screen.getByText(/ready to finalise/i)).toBeInTheDocument();

    fireEvent.click(finalise);

    expect(screen.getByText(/finalised and read-only/i)).toBeInTheDocument();
    expect(screen.getByText(/CGT events are locked/i)).toBeInTheDocument();
  });
});
