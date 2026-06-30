import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage, orderAdviceNotesForSeason } from '@/pages/Dashboard';
import type { AdviceNote } from '@/hooks/useAdviceNotes';
import type { RealtimePnl } from '@/hooks/useRealtimePnl';
import type { TaxObligation } from '@/hooks/useTaxCalendar';
import type { WorkstreamTask } from '@/hooks/useWorkstreamTasks';

const mocks = vi.hoisted(() => ({
  adviceNotes: [] as AdviceNote[],
  obligations: [] as TaxObligation[],
  onboardingProgress: {
    total_entities: 0,
    pending_count: 0,
    needs_review_count: 0,
    approved_count: 0,
    dismissed_count: 0,
    pct_complete: 100,
    is_complete: true,
  },
  workstreamTasks: [] as WorkstreamTask[],
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

vi.mock('@/hooks/onboarding/useStagedEntities', () => ({
  useOnboardingProgress: () => ({
    progress: mocks.onboardingProgress,
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useWorkstreamTasks', () => ({
  useWorkstreamTasks: () => ({
    tasks: mocks.workstreamTasks,
    loading: false,
    error: null,
  }),
}));

function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

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
    mocks.onboardingProgress = {
      total_entities: 0,
      pending_count: 0,
      needs_review_count: 0,
      approved_count: 0,
      dismissed_count: 0,
      pct_complete: 100,
      is_complete: true,
    };
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
    renderDashboard();

    const cards = screen.getAllByLabelText(/Advice card:/i);
    expect(cards[0]).toHaveTextContent('Year-end planning levers');
    expect(cards[1]).toHaveTextContent('Structuring tax comparison');
    expect(cards[2]).toHaveTextContent('Cash-flow forecast');
    expect(screen.queryByText('Dismissed FBT note')).not.toBeInTheDocument();

    const firstOpenButton = screen.getAllByRole('button', { name: /open/i })[0];
    expect(firstOpenButton).toBeDefined();
    if (!firstOpenButton) throw new Error('Expected an advice-card open button');
    fireEvent.click(firstOpenButton);
    expect(screen.getByRole('heading', { name: 'Year-end planning levers' })).toBeInTheDocument();
    expect(screen.getByText('General information only.')).toBeInTheDocument();
  });

  it('renders workstream tasks in the Today feed', () => {
    mocks.workstreamTasks = [
      {
        id: 'wt-1',
        organization_id: 'org-1',
        task_kind: 'tax_obligation',
        owner_label: 'BAS — Q1 FY26',
        why_now: '14 days OVERDUE',
        source_refs: { table: 'v_tax_calendar' },
        suggested_action: 'Prepare and lodge BAS',
        confidence: 'advisor_required',
        impact_cents: 500000,
        due_at: '2026-04-21T00:00:00Z',
        blocking_reason: null,
        completion_event: { status: 'lodged' },
        urgency: 2,
        created_at: '2026-06-30T00:00:00Z',
      },
      {
        id: 'wt-2',
        organization_id: 'org-1',
        task_kind: 'unapproved_bill',
        owner_label: '3 bills need approval',
        why_now: '3 received bills have not been approved yet',
        source_refs: { table: 'bills', count: 3 },
        suggested_action: 'Review and approve bills',
        confidence: 'quick_confirm',
        impact_cents: 150000,
        due_at: null,
        blocking_reason: null,
        completion_event: { table: 'bills', status: 'verified' },
        urgency: 4,
        created_at: '2026-06-30T00:00:00Z',
      },
    ];

    renderDashboard();

    expect(screen.getByText('BAS — Q1 FY26')).toBeInTheDocument();
    expect(screen.getByText('14 days OVERDUE')).toBeInTheDocument();
    expect(screen.getByText('3 bills need approval')).toBeInTheDocument();
    expect(screen.getByText('2 tasks')).toBeInTheDocument();
    expect(screen.getByText('Advisor')).toBeInTheDocument();
    expect(screen.getByText('Quick')).toBeInTheDocument();
  });

  it('renders anomaly tasks in the Today feed', () => {
    mocks.workstreamTasks = [
      {
        id: 'wt-anomaly-1',
        organization_id: 'org-1',
        task_kind: 'duplicate_bill',
        owner_label: '2 duplicate bills from Acme Supplies',
        why_now: '2 bills share the same supplier, date, and amount',
        source_refs: { table: 'bills', dup_count: 2 },
        suggested_action: 'Review and remove duplicate bills',
        confidence: 'review_needed',
        impact_cents: 500000,
        due_at: null,
        blocking_reason: 'May distort expense reporting',
        completion_event: { action: 'void_or_dismiss' },
        urgency: 9,
        created_at: '2026-06-30T00:00:00Z',
      },
      {
        id: 'wt-anomaly-2',
        organization_id: 'org-1',
        task_kind: 'bas_coverage_gap',
        owner_label: 'BAS Q1 FY26 — GST gap',
        why_now: '72.5% of bills have GST — needs to be 95%+',
        source_refs: { table: 'bills', coverage_pct: 72.5 },
        suggested_action: 'Review bills missing GST amounts for Q1',
        confidence: 'review_needed',
        impact_cents: null,
        due_at: null,
        blocking_reason: 'Blocks BAS lodgement',
        completion_event: { gst_ready: true },
        urgency: 11,
        created_at: '2026-06-30T00:00:00Z',
      },
    ];

    renderDashboard();

    expect(screen.getByText('2 duplicate bills from Acme Supplies')).toBeInTheDocument();
    expect(screen.getByText('BAS Q1 FY26 — GST gap')).toBeInTheDocument();
    expect(screen.getByText('2 tasks')).toBeInTheDocument();
  });

  it('hides Today feed when there are no tasks', () => {
    mocks.workstreamTasks = [];
    renderDashboard();
    expect(screen.queryByText(/tasks/)).not.toBeInTheDocument();
  });

  it('surfaces pending onboarding triage with a direct link', () => {
    mocks.onboardingProgress = {
      total_entities: 20,
      pending_count: 9,
      needs_review_count: 3,
      approved_count: 8,
      dismissed_count: 0,
      pct_complete: 40,
      is_complete: false,
    };

    renderDashboard();

    expect(screen.getByLabelText(/onboarding triage prompt/i)).toHaveTextContent(
      '12 staged senders need approval',
    );
    expect(screen.getByRole('link', { name: /review 12 staged senders/i })).toHaveAttribute(
      'href',
      '/onboarding/triage',
    );
  });
});
