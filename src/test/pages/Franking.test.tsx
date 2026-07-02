import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { FrankingRegisterPayload } from '@/hooks/useFrankingRegister';

const h = vi.hoisted(() => ({
  franking: {
    frankingRegister: null as FrankingRegisterPayload | null,
    loading: false,
    error: null as string | null,
    refresh: vi.fn(),
  },
}));

vi.mock('@/hooks/useFrankingRegister', () => ({
  latestCompletedFrankingFyStartYear: () => 2025,
  frankingFyLabel: (fy: number) => `FY${fy}-${String(fy + 1).slice(2)}`,
  useFrankingRegister: () => h.franking,
}));

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

import { FrankingReportPage } from '@/pages/reports/Franking';

const FRANKING_REGISTER: FrankingRegisterPayload = {
  schema_version: 'build_franking_register:v1',
  organization_id: 'org-1',
  fy_start_year: 2025,
  period_start: '2025-07-01',
  period_end: '2026-06-30',
  summary: {
    opening_balance_cents: 5_000_00,
    credit_cents: 20_000_00,
    debit_cents: 6_000_00,
    closing_balance_cents: 19_000_00,
    statement_cash_dividend_cents: 18_000_00,
    statement_franking_credit_cents: 6_000_00,
    register_distribution_debit_cents: 6_000_00,
    statement_vs_register_variance_cents: 0,
    gl_dividend_cents: 18_000_00,
    statement_vs_gl_variance_cents: 0,
    benchmark_franking_percentage_bps: 10000,
    benchmark_variation_count: 1,
  },
  entries: [
    {
      id: 'entry-1',
      entry_date: '2025-09-01',
      entry_kind: 'income_tax_payment',
      description: 'Company tax instalment',
      credit_cents: 20_000_00,
      debit_cents: 0,
      source_table: null,
      source_id: null,
      source_reference: 'PAYG-I Q1',
    },
    {
      id: 'entry-2',
      entry_date: '2026-03-31',
      entry_kind: 'franked_distribution',
      description: 'Final dividend franking debit',
      credit_cents: 0,
      debit_cents: 6_000_00,
      source_table: 'company_dividend_statements',
      source_id: 'statement-1',
      source_reference: null,
    },
  ],
  dividend_statements: [
    {
      id: 'statement-1',
      statement_date: '2026-03-31',
      dividend_date: '2026-03-31',
      member_name: 'Daniel Holdings Pty Ltd',
      share_class: 'ORD',
      shares_held: 100,
      cash_dividend_cents: 18_000_00,
      franking_credit_cents: 6_000_00,
      franking_percentage_bps: 10000,
      company_tax_rate_bps: 2500,
      statement_status: 'issued',
      input_hash: 'statementhash',
    },
  ],
  evidence: {
    source_tables: [
      'franking_account_entries',
      'company_dividend_statements',
      'share_register',
      'journal_entries',
      'journal_lines',
      'chart_of_accounts',
      'business_profile',
    ],
    input_hash: 'frankinghash'.repeat(8),
    source_version: 'build_franking_register:v1',
    source_label: 'ATO Franking account tax return and benchmark rule',
    source_url:
      'https://www.ato.gov.au/businesses-and-organisations/corporate-tax-measures-and-assurance/imputation',
  },
  warnings: [],
  lodgement: {
    enabled: false,
    reason: 'Franking register and dividend statements are draft/reconciliation artifacts only',
  },
};

beforeEach(() => {
  h.franking = {
    frankingRegister: FRANKING_REGISTER,
    loading: false,
    error: null,
    refresh: vi.fn(),
  };
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <FrankingReportPage />
    </MemoryRouter>,
  );

describe('FrankingReportPage', () => {
  it('renders balances, register entries, dividend statements and evidence', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: 'Franking Register' })).toBeInTheDocument();
    expect(screen.getByText('$19,000.00')).toBeInTheDocument();
    expect(screen.getByText('Company tax instalment')).toBeInTheDocument();
    expect(screen.getByText('Final dividend franking debit')).toBeInTheDocument();
    expect(screen.getByText('Daniel Holdings Pty Ltd')).toBeInTheDocument();
    expect(screen.getByText(FRANKING_REGISTER.evidence.input_hash)).toBeInTheDocument();
  });

  it('shows reconciliation values and benchmark percentage', () => {
    renderPage();

    expect(screen.getByText('Statement vs GL variance')).toBeInTheDocument();
    expect(screen.getAllByText('$0.00').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('100.00%')).toBeInTheDocument();
  });

  it('surfaces warning and unavailable states', () => {
    h.franking = {
      frankingRegister: {
        ...FRANKING_REGISTER,
        warnings: ['franking account closing balance is in deficit'],
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    const { rerender } = renderPage();
    expect(screen.getByText(/Review before issuing statements/)).toBeInTheDocument();
    expect(screen.getByText(/franking account closing balance is in deficit/)).toBeInTheDocument();

    h.franking = {
      frankingRegister: null,
      loading: false,
      error: 'build_franking_register: not authorized',
      refresh: vi.fn(),
    };
    rerender(
      <MemoryRouter>
        <FrankingReportPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Franking register unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/No franking register is available/)).toBeInTheDocument();
  });
});
