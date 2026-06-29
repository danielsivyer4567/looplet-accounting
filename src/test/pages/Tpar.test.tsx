import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TparReportPayload } from '@/hooks/useTparReport';
import { downloadCsv } from '@/lib/csv';

const h = vi.hoisted(() => ({
  tpar: {
    tparReport: null as TparReportPayload | null,
    loading: false,
    error: null as string | null,
    refresh: vi.fn(),
  },
}));

vi.mock('@/hooks/useTparReport', () => ({
  latestCompletedTparFyStartYear: () => 2025,
  tparFyLabel: (fy: number) => `FY${fy}-${String(fy + 1).slice(2)}`,
  useTparReport: () => h.tpar,
}));

vi.mock('@/lib/csv', () => ({
  downloadCsv: vi.fn(),
}));

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

import { TparReportPage } from '@/pages/reports/Tpar';

const TPAR_REPORT: TparReportPayload = {
  schema_version: 'build_tpar_report:v1',
  organization_id: 'org-1',
  fy_start_year: 2025,
  period_start: '2025-07-01',
  period_end: '2026-06-30',
  due_date: '2026-08-28',
  obligation: {
    is_tpar_required: true,
    subbies_count: 2,
    source_label: 'ATO Taxable payments annual report',
    source_url:
      'https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/reports-and-returns/taxable-payments-annual-report',
  },
  summary: {
    supplier_count: 2,
    payment_count: 3,
    bill_count: 3,
    gross_paid_cents: 33_000_00,
    gst_component_cents: 3_000_00,
    net_paid_cents: 30_000_00,
    missing_abn_count: 1,
    missing_gst_count: 1,
  },
  suppliers: [
    {
      supplier_key: 'supplier-1',
      supplier_id: 'supplier-1',
      supplier_name: 'Ace Electrical Contractors',
      supplier_abn: '12345678901',
      gross_paid_cents: 22_000_00,
      gst_component_cents: 2_000_00,
      net_paid_cents: 20_000_00,
      payment_count: 2,
      bill_count: 2,
      first_payment_date: '2025-08-15',
      last_payment_date: '2026-02-01',
      missing_abn: false,
      missing_gst_count: 0,
      payments: [],
    },
    {
      supplier_key: 'raw:missing',
      supplier_id: null,
      supplier_name: 'Unknown Site Labour',
      supplier_abn: null,
      gross_paid_cents: 11_000_00,
      gst_component_cents: 1_000_00,
      net_paid_cents: 10_000_00,
      payment_count: 1,
      bill_count: 1,
      first_payment_date: '2026-04-10',
      last_payment_date: '2026-04-10',
      missing_abn: true,
      missing_gst_count: 1,
      payments: [],
    },
  ],
  evidence: {
    source_tables: [
      'bills',
      'payment_runs',
      'payment_run_items',
      'suppliers',
      'intake_rules',
      'business_profile',
    ],
    reportable_basis:
      'bills.auto_category_code = subcontractor OR supplier intake_rules.category_code = subcontractor',
    input_hash: 'tparhash'.repeat(8),
    source_version: 'build_tpar_report:v1',
  },
  warnings: ['1 TPAR payee(s) are missing ABN details'],
  export: {
    format: 'csv',
    enabled: true,
    filename: 'tpar-FY2025-26.csv',
  },
  lodgement: {
    enabled: false,
    reason: 'TPAR builder produces a review/export artifact only',
  },
};

beforeEach(() => {
  h.tpar = {
    tparReport: TPAR_REPORT,
    loading: false,
    error: null,
    refresh: vi.fn(),
  };
  vi.mocked(downloadCsv).mockReset();
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <TparReportPage />
    </MemoryRouter>,
  );

describe('TparReportPage', () => {
  it('renders summary, reportable payees and evidence', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: 'TPAR' })).toBeInTheDocument();
    expect(screen.getByText('$33,000.00')).toBeInTheDocument();
    expect(screen.getByText('$3,000.00')).toBeInTheDocument();
    expect(screen.getByText('Ace Electrical Contractors')).toBeInTheDocument();
    expect(screen.getByText('Unknown Site Labour')).toBeInTheDocument();
    expect(screen.getByText(TPAR_REPORT.evidence.input_hash)).toBeInTheDocument();
    expect(screen.getAllByText('Missing ABN').length).toBeGreaterThan(0);
  });

  it('exports payee rows as CSV', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /Export CSV/i }));

    await waitFor(() => expect(downloadCsv).toHaveBeenCalledTimes(1));
    expect(downloadCsv).toHaveBeenCalledWith(
      expect.stringMatching(/^tpar-FY2025-26-export-\d{4}-\d{2}-\d{2}\.csv$/),
      [
        expect.objectContaining({
          'Supplier name': 'Ace Electrical Contractors',
          ABN: '12345678901',
          'Gross payments': '22000.00',
        }),
        expect.objectContaining({
          'Supplier name': 'Unknown Site Labour',
          ABN: '',
          'Missing ABN': 'Yes',
          'Missing GST rows': 1,
        }),
      ],
    );
  });

  it('degrades when the RPC is unavailable', () => {
    h.tpar = {
      tparReport: null,
      loading: false,
      error: 'build_tpar_report: not authorized',
      refresh: vi.fn(),
    };
    renderPage();

    expect(screen.getByText(/TPAR report unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/No TPAR report is available/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Export CSV/i })).not.toBeInTheDocument();
  });
});
