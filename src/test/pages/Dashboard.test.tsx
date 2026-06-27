import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage, orderAdviceNotesForSeason } from '@/pages/Dashboard';
import type { AdviceNote } from '@/hooks/useAdviceNotes';
import type { RealtimePnl } from '@/hooks/useRealtimePnl';
import type { TaxObligation } from '@/hooks/useTaxCalendar';

const mocks = vi.hoisted(() => ({
  adviceNotes: [] as AdviceNote[],
  obligations: [] as TaxObligation[],
  signOff: vi.fn(),
  dismiss: vi.fn(),
}));

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

const pnl: RealtimePnl = {
  organization_id: 'org-1',
  organization_name: 'Test Org',
  revenue_inc_gst_cents: 12500000,
  revenue_ex_gst_cents: 11363636,
  gst_collected_cents: 1136364,
  gst_input_credit_cents: 250000,
  gst_set_aside_cents: 886364,
  cost_bills_cents: 2500000,
  cost_wages_cents: 3000000,
  cost_overhead_cents: 1250000,
  total_cost_cents: 6750000,
  gross_profit_cents: 4613636,
  tax_set_aside_cents: 1153409,
  really_yours_cents: 2573863,
};

vi.mock('@/hooks/useRealtimePnl', () => ({
  useRealtimePnl: () => ({ pnl, loading: false, error: null }),
}));

vi.mock('@/hooks/useAdviceNotes', () => ({
  useAdviceNotes: () => ({
    notes: mocks.adviceNotes,
    loading: false,
    actionBusy: false,
    error: null,
    refresh: vi.fn(),
    createNote: vi.fn(),
    signOff: mocks.signOff,
    dismiss: mocks.dismiss,
  }),
}));

vi.mock('@/hooks/useTaxCalendar', () => ({
  useTaxCalendar: () => ({
    obligations: mocks.obligations,
    loading: false,
    error: null,
  }),
}));

function note(kind: AdviceNote['kind'], title: string, updated_at: string): AdviceNote {
  return {
    id: `${kind}-note`,
    organization_id: 'org-1',
    kind,
    title,
    summary: `${title} summary.`,
    inputs: {},
    numbers: kind === 'forecast' ? { runway_weeks: 8 } : { tax_diff_cents: 1200000 },
    assumptions: {},
    citations: [],
    disclaimer: 'General information only.',
    registered_agent_signoff_by: null,
    registered_agent_signoff_at: null,
    status: 'draft',
    created_at: updated_at,
    updated_at,
    created_by: 'user-1',
    deleted_at: null,
  };
}

const june30Obligation: TaxObligation = {
  organization_id: 'org-1',
  obligation_key: 'year-end',
  category: 'income_tax',
  title: 'Year-end planning',
  period_label: 'FY2026',
  period_start: '2025-07-01',
  period_end: '2026-06-30',
  due_date: '2026-06-30',
  fy_start_year: 2025,
  display_name: null,
  description: null,
  cadence: null,
  default_lead_days: 30,
  sort_order: 1,
  days_until_due: 3,
  stage: 'due_soon',
  status: 'due_soon',
};

describe('Dashboard advice cards', () => {
  beforeEach(() => {
    mocks.signOff.mockReset();
    mocks.dismiss.mockReset();
    mocks.obligations = [june30Obligation];
    mocks.adviceNotes = [
      note('forecast', 'Cash-flow forecast', '2026-06-27T03:00:00Z'),
      note('structuring', 'Structuring tax comparison', '2026-06-27T02:00:00Z'),
      note('year_end', 'Year-end planning levers', '2026-06-27T01:00:00Z'),
      { ...note('fbt', 'Dismissed FBT note', '2026-06-27T04:00:00Z'), status: 'dismissed' },
    ];
  });

  it('orders year-end and structuring notes first during the June year-end season', () => {
    const ordered = orderAdviceNotesForSeason(
      mocks.adviceNotes,
      mocks.obligations,
      new Date('2026-06-27T00:00:00Z'),
    );

    expect(ordered.map((item) => item.kind)).toEqual(['year_end', 'structuring', 'forecast']);
  });

  it('renders seasonal advice cards and opens the detail view', () => {
    render(<DashboardPage />);

    const cards = screen.getAllByLabelText(/Advice card:/i);
    expect(cards[0]).toHaveTextContent('Year-end planning levers');
    expect(cards[1]).toHaveTextContent('Structuring tax comparison');
    expect(cards[2]).toHaveTextContent('Cash-flow forecast');
    expect(screen.queryByText('Dismissed FBT note')).not.toBeInTheDocument();

    const firstOpenButton = screen.getAllByRole('button', { name: /open/i })[0];
    expect(firstOpenButton).toBeDefined();
    fireEvent.click(firstOpenButton!);
    expect(screen.getByRole('heading', { name: 'Year-end planning levers' })).toBeInTheDocument();
    expect(screen.getByText('General information only.')).toBeInTheDocument();
  });
});
