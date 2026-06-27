import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AdviceCard } from '@/components/AdviceCard';
import type { AdviceNote } from '@/hooks/useAdviceNotes';

const baseNote: AdviceNote = {
  id: 'note-1',
  organization_id: 'org-1',
  kind: 'structuring',
  title: 'Structuring tax comparison',
  summary:
    'Lowest modelled tax is company at $25,000. Potential difference versus sole trader is $12,345.',
  inputs: {},
  numbers: { tax_diff_cents: 1234500 },
  assumptions: {},
  citations: [],
  disclaimer: 'General information only.',
  registered_agent_signoff_by: null,
  registered_agent_signoff_at: null,
  status: 'draft',
  created_at: '2026-06-27T00:00:00Z',
  updated_at: '2026-06-27T00:00:00Z',
  created_by: 'user-1',
  deleted_at: null,
};

describe('AdviceCard', () => {
  it('renders a glanceable note card with a headline money metric and open action', () => {
    const onOpen = vi.fn();

    render(<AdviceCard note={baseNote} onOpen={onOpen} />);

    expect(screen.getByText('Structuring tax comparison')).toBeInTheDocument();
    expect(screen.getByText('Tax delta')).toBeInTheDocument();
    expect(screen.getByText('$12,345')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Structuring')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open/i }));
    expect(onOpen).toHaveBeenCalledWith('note-1');
  });

  it('falls back to runway weeks when forecast notes have no saving metric', () => {
    render(
      <AdviceCard
        note={{
          ...baseNote,
          kind: 'forecast',
          title: 'Cash-flow forecast',
          numbers: { runway_weeks: 8 },
          status: 'issued',
        }}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText('Runway')).toBeInTheDocument();
    expect(screen.getByText('8 wks')).toBeInTheDocument();
    expect(screen.getByText('Issued')).toBeInTheDocument();
    expect(screen.getByText('Forecast')).toBeInTheDocument();
  });
});
