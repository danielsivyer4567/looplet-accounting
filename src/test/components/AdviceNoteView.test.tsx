import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AdviceNoteView } from '@/components/AdviceNoteView';
import type { AdviceNote } from '@/hooks/useAdviceNotes';

const note: AdviceNote = {
  id: 'note-1',
  organization_id: 'org-1',
  kind: 'forecast',
  title: 'Cash-flow forecast and vCFO variance brief',
  summary: 'Runway is 8 weeks.\nLargest budget variance: 2026-06-29 at $3,000.',
  inputs: { mode: 'forecast', current_entity_type: 'company' },
  numbers: {
    runway_weeks: 8,
    tax_diff_cents: 123456,
    largest_budget_variances: [
      {
        week_start: '2026-06-29',
        job_id: 'job-1',
        actual_cents: 1100000,
        budget_cents: 800000,
        variance_cents: 300000,
      },
    ],
  },
  assumptions: {
    forecast_horizon: 'current week plus 12 future weeks',
  },
  citations: [
    {
      doc_ref: 'TR 2024/1',
      section_ref: 's 8-1',
      quoted_text: 'Deduction context excerpt.',
      citation_url: 'https://example.test/tax-ruling',
    },
  ],
  disclaimer: 'General information only. Review before acting.',
  registered_agent_signoff_by: null,
  registered_agent_signoff_at: null,
  status: 'draft',
  created_at: '2026-06-27T00:00:00Z',
  updated_at: '2026-06-27T00:00:00Z',
  created_by: 'user-1',
  deleted_at: null,
};

describe('AdviceNoteView', () => {
  it('renders the note detail, numbers, assumptions, linked citations, and action gate', () => {
    const onSignOff = vi.fn();
    const onDismiss = vi.fn();

    render(<AdviceNoteView note={note} onSignOff={onSignOff} onDismiss={onDismiss} />);

    expect(screen.getByRole('heading', { name: note.title })).toBeInTheDocument();
    expect(screen.getAllByText(/Runway is 8 weeks/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Tax Diff')).toBeInTheDocument();
    expect(screen.getByText('$1,234.56')).toBeInTheDocument();
    expect(screen.getByText('Largest Budget Variances')).toBeInTheDocument();
    expect(screen.getAllByText('Forecast Horizon').length).toBeGreaterThanOrEqual(2);

    const citation = screen.getByRole('link', { name: /TR 2024\/1 s 8-1/i });
    expect(citation).toHaveAttribute('href', 'https://example.test/tax-ruling');
    expect(screen.getByText('Deduction context excerpt.')).toBeInTheDocument();
    expect(screen.getByText('General information only. Review before acting.')).toBeInTheDocument();
    expect(screen.getByText('Reasoning map')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /sign off/i }));
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onSignOff).toHaveBeenCalledWith('note-1');
    expect(onDismiss).toHaveBeenCalledWith('note-1');
    expect(screen.getByRole('button', { name: /act on this/i })).toBeDisabled();
  });

  it('disables sign-off once a note has been issued', () => {
    render(
      <AdviceNoteView
        note={{
          ...note,
          status: 'issued',
          registered_agent_signoff_by: 'user-1',
          registered_agent_signoff_at: '2026-06-27T01:00:00Z',
        }}
        onSignOff={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Signed off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign off/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /dismiss/i })).not.toBeDisabled();
  });
});
