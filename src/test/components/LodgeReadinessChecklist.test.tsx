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

  it('renders a disabled header and an awaiting row per unmet requirement, with no dev-TODO copy', () => {
    render(<LodgeReadinessChecklist />);

    expect(screen.getByRole('heading', { name: /Lodgement disabled/i })).toBeInTheDocument();

    const awaiting = screen.getAllByText(/^Awaiting — /);
    expect(awaiting).toHaveLength(LODGE_REQUIREMENTS.length);

    // Product copy, not developer artefacts: no TODO markers, slice tags, or secret names.
    expect(screen.queryByText(/TODO/)).not.toBeInTheDocument();
    expect(screen.queryByText(/SC-DEPLOY/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ATO_M2M_KEYSTORE_REF/)).not.toBeInTheDocument();
    expect(screen.queryByText(/mock script/i)).not.toBeInTheDocument();
  });

  it('flips to a ready header once every requirement is done', () => {
    const allDone: LodgeRequirement[] = LODGE_REQUIREMENTS.map((r) => ({ ...r, done: true }));
    render(<LodgeReadinessChecklist requirements={allDone} />);

    expect(screen.getByRole('heading', { name: /Lodgement ready/i })).toBeInTheDocument();
    expect(screen.queryByText(/^Awaiting — /)).not.toBeInTheDocument();
  });
});
