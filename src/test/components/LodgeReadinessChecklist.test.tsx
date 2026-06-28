import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  LODGE_REQUIREMENTS,
  LodgeReadinessChecklist,
  type LodgeRequirement,
} from '@/components/lodge/LodgeReadinessChecklist';

describe('LodgeReadinessChecklist', () => {
  it('defaults to all requirements unmet (honest blocked state)', () => {
    expect(LODGE_REQUIREMENTS.length).toBeGreaterThan(0);
    expect(LODGE_REQUIREMENTS.every((r) => r.done === false)).toBe(true);
  });

  it('renders a blocked header and a TODO for every unmet requirement', () => {
    render(<LodgeReadinessChecklist />);

    expect(screen.getByRole('heading', { name: /Lodgement blocked/i })).toBeInTheDocument();

    // Every requirement shows as an outstanding TODO with its blocking secrets.
    const todos = screen.getAllByText(/^TODO — /);
    expect(todos).toHaveLength(LODGE_REQUIREMENTS.length);
    expect(screen.getByText(/ATO_M2M_KEYSTORE_REF/)).toBeInTheDocument();
    expect(screen.getByText(/SBR_TAXONOMY_BASE_URL/)).toBeInTheDocument();
  });

  it('flips to a ready header once every requirement is done', () => {
    const allDone: LodgeRequirement[] = LODGE_REQUIREMENTS.map((r) => ({ ...r, done: true }));
    render(<LodgeReadinessChecklist requirements={allDone} />);

    expect(screen.getByRole('heading', { name: /Lodgement ready/i })).toBeInTheDocument();
    expect(screen.queryByText(/^TODO — /)).not.toBeInTheDocument();
  });
});
