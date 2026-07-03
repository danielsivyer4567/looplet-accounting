import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SgcStatementPayload } from '@/hooks/useSgcStatement';

const h = vi.hoisted(() => ({
  sgc: {
    sgcStatement: null as SgcStatementPayload | null,
    loading: false,
    error: null as string | null,
    refresh: vi.fn(),
  },
}));

vi.mock('@/hooks/useSgcStatement', () => ({
  latestCompletedSgcPeriod: () => ({ fyStartYear: 2025, quarter: 3 }),
  sgcFyLabel: (fy: number) => `FY${fy}-${String(fy + 1).slice(2)}`,
  sgcQuarterLabel: (quarter: number) => `Q${quarter}`,
  useSgcStatement: () => h.sgc,
}));

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

import { SgcReportPage } from '@/pages/reports/Sgc';

const SGC_STATEMENT: SgcStatementPayload = {
  schema_version: 'build_sgc_statement:v1',
  organization_id: 'org-1',
  fy_start_year: 2025,
  quarter: 3,
  quarter_start: '2026-01-01',
  quarter_end: '2026-03-31',
  due_date: '2026-04-28',
  summary: {
    employee_count: 2,
    slip_count: 4,
    gross_total_cents: 26_000_00,
    ordinary_time_earnings_cents: 24_000_00,
    overtime_excluded_cents: 2_000_00,
    required_super_cents: 2_880_00,
    payroll_super_cents: 2_780_00,
    calculation_shortfall_cents: 100_00,
    shortfall_employee_count: 1,
    recorded_rate_min_pct: 11.5,
    recorded_rate_max_pct: 12,
    statutory_rate_min_pct: 12,
    statutory_rate_max_pct: 12,
  },
  sgc_components: {
    super_shortfall_cents: 100_00,
    nominal_interest_cents: null,
    nominal_interest_reason:
      'Requires actual payment/lodgment dates; calculate in the ATO SGC statement before lodgment',
    admin_fee_cents_per_employee: 20_00,
    admin_fee_cents: 20_00,
    draft_total_ex_interest_cents: 120_00,
  },
  employees: [
    {
      employee_id: 'emp-1',
      employee_name: 'Avery Sparks',
      slip_count: 2,
      gross_total_cents: 12_000_00,
      ordinary_time_earnings_cents: 10_000_00,
      overtime_excluded_cents: 2_000_00,
      required_super_cents: 1_200_00,
      payroll_super_cents: 1_150_00,
      calculation_shortfall_cents: 50_00,
      recorded_rate_min_pct: 11.5,
      recorded_rate_max_pct: 11.5,
      statutory_rate_min_pct: 12,
      statutory_rate_max_pct: 12,
      pay_slips: [],
    },
    {
      employee_id: 'emp-2',
      employee_name: 'Morgan Lee',
      slip_count: 2,
      gross_total_cents: 14_000_00,
      ordinary_time_earnings_cents: 14_000_00,
      overtime_excluded_cents: 0,
      required_super_cents: 1_680_00,
      payroll_super_cents: 1_630_00,
      calculation_shortfall_cents: 50_00,
      recorded_rate_min_pct: 12,
      recorded_rate_max_pct: 12,
      statutory_rate_min_pct: 12,
      statutory_rate_max_pct: 12,
      pay_slips: [],
    },
  ],
  evidence: {
    source_tables: ['pay_runs', 'pay_slips', 'employees', 'system_defaults'],
    calculation_basis:
      'SG required = ordinary time earnings (gross ordinary + leave) x statutory SG rate; overtime excluded',
    input_hash: 'sgchash'.repeat(8),
    source_version: 'build_sgc_statement:v1',
    source_label: 'ATO Super guarantee and Super guarantee charge',
    source_urls: [],
  },
  warnings: [
    'overtime wages are excluded from the OTE super guarantee base',
    '1 employee(s) have a calculated SG shortfall',
  ],
  lodgement: {
    enabled: false,
    reason:
      'SGC statement builder is a draft review artifact only; live ATO lodgement remains on the external-gated ATO TODO list',
  },
};

beforeEach(() => {
  h.sgc = {
    sgcStatement: SGC_STATEMENT,
    loading: false,
    error: null,
    refresh: vi.fn(),
  };
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <SgcReportPage />
    </MemoryRouter>,
  );

describe('SgcReportPage', () => {
  it('renders OTE, shortfall rows, SGC components, and evidence', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: 'SGC Statement' })).toBeInTheDocument();
    expect(screen.getByText('$24,000.00')).toBeInTheDocument();
    expect(screen.getByText('$2,880.00')).toBeInTheDocument();
    expect(screen.getByText('Avery Sparks')).toBeInTheDocument();
    expect(screen.getByText('Morgan Lee')).toBeInTheDocument();
    expect(screen.getByText(/Draft total excluding interest/)).toBeInTheDocument();
    expect(screen.getByText(SGC_STATEMENT.evidence.input_hash)).toBeInTheDocument();
  });

  it('surfaces warning and unavailable states', () => {
    const { rerender } = renderPage();
    expect(screen.getByText(/Review before lodging externally/)).toBeInTheDocument();
    expect(screen.getByText(/overtime wages are excluded/)).toBeInTheDocument();

    h.sgc = {
      sgcStatement: null,
      loading: false,
      error: 'build_sgc_statement: not authorized',
      refresh: vi.fn(),
    };
    rerender(
      <MemoryRouter>
        <SgcReportPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/SGC statement unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/No SGC statement is available/)).toBeInTheDocument();
  });
});
