/**
 * Tests for src/pages/LegalHorizon.tsx (SC-LC.F.04).
 *
 * The deterministic runtime look for the "Upcoming changes" surface: mock the
 * useLegalHorizon data hook (no Supabase / network) and assert the route renders
 * each horizon item as a card that is UNMISTAKABLY forward-looking — a "Proposed ·
 * not yet law" guard badge + the stage label + a confidence read + a source link —
 * and the empty/framing states. The page uses no router hooks, so it renders bare.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { LegalHorizonRow } from '@/hooks/useLegalHorizon';

// Mutable state the mocked hook returns (hoisted so the vi.mock factory can close
// over it without a TDZ error); each test sets the fields it cares about.
const h = vi.hoisted(() => ({
  state: {
    items: [] as unknown[],
    loading: false,
    error: null as string | null,
    scanBusy: false,
    scanStatus: null as string | null,
    refresh: vi.fn(),
    runSonarScan: vi.fn(),
  },
}));

vi.mock('@/hooks/useLegalHorizon', () => ({
  useLegalHorizon: () => h.state,
}));

import { LegalHorizonPage } from '@/pages/LegalHorizon';

function makeRow(
  over: Partial<LegalHorizonRow> & Pick<LegalHorizonRow, 'id' | 'title'>,
): LegalHorizonRow {
  return {
    id: over.id,
    title: over.title,
    summary: over.summary ?? null,
    topic: over.topic ?? null,
    stage: over.stage ?? 'announced',
    confidence: over.confidence ?? 0.7,
    proposed_effective_from: over.proposed_effective_from ?? null,
    source_url: over.source_url ?? null,
    source_excerpt: over.source_excerpt ?? null,
    first_seen_at: over.first_seen_at ?? '2026-06-01T00:00:00Z',
    last_seen_at: over.last_seen_at ?? '2026-06-01T00:00:00Z',
  };
}

describe('LegalHorizonPage', () => {
  beforeEach(() => {
    h.state.items = [];
    h.state.loading = false;
    h.state.error = null;
    h.state.scanBusy = false;
    h.state.scanStatus = null;
    h.state.refresh.mockReset();
    h.state.runSonarScan.mockReset();
  });

  it('renders each item as a forward-looking card with stage, confidence and a source link', () => {
    h.state.items = [
      makeRow({
        id: 'a',
        title: 'Instant asset write-off extended',
        topic: 'instant asset write-off',
        stage: 'before_parliament',
        confidence: 0.8,
        proposed_effective_from: '2026-07-01',
        source_url: 'https://treasury.gov.au/measure-a',
      }),
    ];

    render(<LegalHorizonPage />);

    // The "not settled law" guard: a per-card badge + the framing paragraph.
    expect(screen.getAllByText(/not yet law/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/not settled law/i)).toBeInTheDocument();

    // Item content + human-readable stage label + confidence read.
    expect(screen.getByText('Instant asset write-off extended')).toBeInTheDocument();
    expect(screen.getByText('Before Parliament')).toBeInTheDocument();
    expect(screen.getByText(/Confidence 80%/)).toBeInTheDocument();

    // Source link opens externally to the exact URL (the click-through target).
    const link = screen.getByRole('link', { name: /View source/i });
    expect(link).toHaveAttribute('href', 'https://treasury.gov.au/measure-a');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('flags low-confidence items so they are not read as reliable', () => {
    h.state.items = [
      makeRow({ id: 'b', title: 'Speculative measure', confidence: 0.3, stage: 'announced' }),
    ];

    render(<LegalHorizonPage />);

    expect(screen.getByText(/low — treat with caution/i)).toBeInTheDocument();
  });

  it('shows an explanatory empty state when nothing is on the radar', () => {
    h.state.items = [];

    render(<LegalHorizonPage />);

    expect(screen.getByText(/No upcoming changes on the radar/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Scan with Sonar/i })).toBeInTheDocument();
    // No card / source link when empty.
    expect(screen.queryByRole('link', { name: /View source/i })).toBeNull();
  });

  it('uses a skeleton while upcoming changes are loading', () => {
    h.state.loading = true;

    render(<LegalHorizonPage />);

    expect(screen.getByLabelText(/loading legal horizon/i)).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/^loading/i)).not.toBeInTheDocument();
  });

  it('lets accountants trigger a Sonar scan from the page', () => {
    h.state.runSonarScan.mockResolvedValueOnce(true);

    render(<LegalHorizonPage />);

    fireEvent.click(screen.getByRole('button', { name: /Scan with Sonar/i }));

    expect(h.state.runSonarScan).toHaveBeenCalledTimes(1);
  });

  it('shows scan completion status returned by the hook', () => {
    h.state.scanStatus = 'Sonar scan complete: 1 item scanned, 1 new item, 0 refreshed items.';

    render(<LegalHorizonPage />);

    expect(screen.getByText(/Sonar scan complete/i)).toBeInTheDocument();
  });
});
