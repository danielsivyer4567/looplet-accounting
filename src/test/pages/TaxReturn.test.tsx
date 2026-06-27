import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TaxReturn, TaxPayable } from '@/hooks/useTaxReturn';
import type { BookToTax, CgtCalc } from '@/hooks/useBookToTax';

/**
 * TaxReturnPage runtime smoke test (SC-4.I.02). Drives the draft-return page with
 * mocked useTaxReturn / useBookToTax / useCgtEvents so no Supabase/network is needed
 * — the runtime look the check skill wants (Preview/Chrome MCP is unavailable in this
 * env, same as the BAS prep-card test). Asserts:
 *   - the entity-aware return labels, book-to-tax reconciliation, tax-payable
 *     waterfall and CGT schedule all render for a company return (the "compiles but
 *     throws at render" class tsc is blind to),
 *   - the page degrades to the unavailable-banner + empty-return card (no crash) when
 *     build_return / book_to_tax return null.
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
}));

vi.mock('@/hooks/useTaxReturn', () => ({ useTaxReturn: () => h.ret }));
vi.mock('@/hooks/useBookToTax', () => ({ useBookToTax: () => h.book }));
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
        { account_code: '4000', account_name: 'Sales', form_item: '6', label_code: 'C', label_name: 'Gross income', amount_cents: 10_000_000 },
      ],
      total: { form_item: '6', label_code: 'S', label_name: 'Total income', amount_cents: 10_000_000 },
    },
    expenses: {
      lines: [
        { account_code: '5000', account_name: 'Subcontractors', form_item: '6', label_code: null, label_name: 'Expense', amount_cents: 3_000_000 },
      ],
      total: { form_item: '6', label_code: 'Q', label_name: 'Total expenses', amount_cents: 3_000_000 },
    },
    total_profit_or_loss: { form_item: '6', label_code: 'T', label_name: 'Total profit or loss', amount_cents: 7_000_000 },
  },
};

const TAX_PAYABLE: TaxPayable = {
  organization_id: 'org-1',
  fy_start_year: 2025,
  period_start: '2025-07-01',
  period_end: '2026-06-30',
  entity_type: 'company',
  taxable_income_cents: 7_310_000,
  rate_basis: { kind: 'company_flat', note: 'Company base-rate entity (25%)', rate: 0.25, base_rate_entity: true, turnover_cents: 1_000_000 },
  income_tax_cents: 1_827_500,
  medicare_levy_cents: 0,
  offsets: {
    non_refundable: { sbito_cents: 0, company_franking_cents: 0, total_cents: 0, unused_cents: 0, note: '' },
    refundable: { franking_cents: 0, payg_instalments_paid_cents: 2_000_000, total_cents: 2_000_000, note: '' },
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
    lines: [{ account_code: '6710', account_name: 'Entertainment', amount_cents: 50_000, reason: 'Entertainment (Div 32)' }],
    total_cents: 50_000,
  },
  depreciation_reconciliation: { book_depreciation_cents: 300_000, tax_depreciation_cents: 240_000, difference_cents: 60_000, note: '' },
  taxable_income_subtotal_cents: 7_110_000,
  capital_gains: {
    net_capital_gain_cents: 200_000,
    current_year_capital_gains_cents: 200_000,
    current_year_capital_losses_cents: 0,
    carried_forward_capital_losses_applied_cents: 0,
    net_capital_loss_carried_forward_cents: 0,
    source: 'cgt_calc',
  },
  franking: { credits_received_cents: 0, grossed_up_into_assessable_income: false, note: 'No franking credits' },
  assessable_income_before_losses_cents: 7_310_000,
  revenue_losses: { available_cents: 0, applied_cents: 0, current_year_loss_cents: 0, carried_forward_cents: 0, source: 'business_profile' },
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
    turnover_test: { passed: false, threshold_cents: 200_000_000, aggregated_turnover_cents: 1_000_000, turnover_bracket: 'under_2m', source: 'estimate', reason: '' },
    mnav_test: { passed: false, threshold_cents: 600_000_000, net_asset_value_cents: 0, total_assets_cents: 0, total_liabilities_cents: 0, basis: 'balance_sheet' },
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

beforeEach(() => {
  h.ret = { taxReturn: null, taxPayable: null, loading: false, error: null, refresh: vi.fn() };
  h.book = { bookToTax: null, cgt: null, loading: false, error: null, refresh: vi.fn() };
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <TaxReturnPage />
    </MemoryRouter>,
  );

describe('TaxReturnPage (SC-4.I.02)', () => {
  it('renders the entity-aware return, reconciliation, tax-payable waterfall and CGT schedule', () => {
    h.ret = { taxReturn: COMPANY_RETURN, taxPayable: TAX_PAYABLE, loading: false, error: null, refresh: vi.fn() };
    h.book = { bookToTax: BOOK_TO_TAX, cgt: CGT, loading: false, error: null, refresh: vi.fn() };
    renderPage();

    // Page shell + the four sections render (would throw, not just type-mismatch, if a branch were broken).
    expect(screen.getByText('Tax Return (Draft)')).toBeInTheDocument();
    expect(screen.getByText('Return labels')).toBeInTheDocument();
    expect(screen.getByText('Item 6 income')).toBeInTheDocument();
    expect(screen.getByText('Item 6 expenses')).toBeInTheDocument();
    expect(screen.getByText('Book-to-tax reconciliation')).toBeInTheDocument();
    expect(screen.getByText('Tax payable')).toBeInTheDocument();
    expect(screen.getByText('Capital gains (CGT)')).toBeInTheDocument();
    // Entity + a refundable result surface; the embedded CGT capture panel renders.
    expect(screen.getByText('Company')).toBeInTheDocument();
    expect(screen.getByText('refundable')).toBeInTheDocument();
    expect(screen.getByText('CGT events')).toBeInTheDocument();
    // Caveats from book_to_tax + compute_tax_payable are de-duplicated into one list.
    expect(screen.getByText('Caveats & assumptions')).toBeInTheDocument();
    expect(screen.getByText(/Passive-income/)).toBeInTheDocument();
  });

  it('degrades to the unavailable banner + empty-return card without crashing when the RPCs return null', () => {
    h.ret = { taxReturn: null, taxPayable: null, loading: false, error: 'build_return: feature_not_supported', refresh: vi.fn() };
    h.book = { bookToTax: null, cgt: null, loading: false, error: 'book_to_tax: missing', refresh: vi.fn() };
    renderPage();

    expect(screen.getByText(/Some figures are unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/No mapped return for this entity/)).toBeInTheDocument();
    // The CGT capture surface is always available, even with no computed figures.
    expect(screen.getByText('CGT events')).toBeInTheDocument();
  });
});
