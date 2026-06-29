import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TaxTimeline } from '@/components/TaxTimeline';
import { buildObligationPrompt, type TaxObligation } from '@/hooks/useTaxCalendar';

function obligation(overrides: Partial<TaxObligation> = {}): TaxObligation {
  return {
    organization_id: 'org-1',
    obligation_key: 'bas',
    category: 'gst',
    title: 'BAS Q4 FY2025-26',
    period_label: 'Q4 FY2025-26',
    period_start: '2026-04-01',
    period_end: '2026-06-30',
    due_date: '2026-07-28',
    fy_start_year: 2025,
    display_name: 'BAS / GST',
    description: 'Business Activity Statement.',
    cadence: 'quarterly',
    default_lead_days: 14,
    sort_order: 10,
    days_until_due: -12,
    stage: 'overdue',
    status: 'overdue',
    ...overrides,
  };
}

describe('TaxTimeline persisted statuses', () => {
  it('renders paid/lodged/accepted obligations as done instead of overdue', () => {
    render(
      <TaxTimeline obligations={[obligation({ status: 'paid' })]} loading={false} error={null} />,
    );

    expect(screen.getByText('done')).toBeInTheDocument();
    expect(screen.queryByText(/overdue/)).not.toBeInTheDocument();
    expect(screen.getByText('1 obligations · tap any item')).toBeInTheDocument();
  });

  it('still renders genuinely overdue obligations as overdue', () => {
    render(<TaxTimeline obligations={[obligation()]} loading={false} error={null} />);

    expect(screen.getByText('12d overdue')).toBeInTheDocument();
    expect(screen.getByText('1 overdue · 1 tracked · tap any item')).toBeInTheDocument();
  });

  it('builds Ask prompts from the persisted completion status', () => {
    const prompt = buildObligationPrompt(obligation({ status: 'accepted' }), 'prepare');

    expect(prompt).toContain('already completed');
    expect(prompt).not.toContain('OVERDUE');
  });
});
