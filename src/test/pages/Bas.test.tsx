import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BasWorksheetPayload, BasBlockers } from '@/hooks/useBasWorksheet';

/**
 * BasPrepCard runtime test (SC-3.E.01). Drives the guided-prep card with a mocked
 * useBasWorksheet so no Supabase/network is needed — the runtime look the check
 * skill wants (Preview MCP is unavailable in this env, same as D.02/F.04). Asserts:
 *  - worksheet labels + blocker states render from the hook,
 *  - approve-and-lodge is ENABLED only when there are no blockers, and clicking it
 *    invokes the Tier-2 approval,
 *  - a blocker (exceptions or variance) DISABLES lodge,
 *  - an unavailable check reads "unavailable" (not a fabricated "clean") — the
 *    fail-open guard.
 */

const h = vi.hoisted(() => ({
  worksheet: null as BasWorksheetPayload | null,
  blockers: { treatmentExceptions: null, reconciliationVarianceCents: null } as BasBlockers,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  requestLodgeApproval: vi.fn(),
}));

vi.mock('@/hooks/useBasWorksheet', () => ({
  useBasWorksheet: () => ({
    worksheet: h.worksheet,
    blockers: h.blockers,
    loading: h.loading,
    error: h.error,
    refresh: h.refresh,
    requestLodgeApproval: h.requestLodgeApproval,
  }),
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({ currentOrg: { id: 'org-1', name: 'Test Org' } }),
}));

// Bas.tsx imports @/lib/supabase at module load (it throws on missing env);
// route it to the shared test mock, the established pattern (cf. Customers.test).
vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

import { BasPrepCard } from '@/pages/reports/Bas';
import { supabase } from '@/test/mocks/supabase';

const SAMPLE: BasWorksheetPayload = {
  organization_id: 'org-1',
  fy_start_year: 2025,
  quarter: 4,
  quarter_start: '2026-04-01',
  quarter_end: '2026-06-30',
  due_date: '2026-07-28',
  gst: { G1: 110000, G10: 0, G11: 55000, '1A': 10000, '1B': 5000 },
  payg_withholding: { W1: 800000, W2: 160000, W4: 0, W5: 160000, '4': 160000 },
  payg_instalment: null,
  summary: { '9_net_amount_cents': 165000 },
};

beforeEach(() => {
  h.worksheet = null;
  h.blockers = { treatmentExceptions: null, reconciliationVarianceCents: null };
  h.loading = false;
  h.error = null;
  h.refresh = vi.fn();
  h.requestLodgeApproval = vi.fn();
  vi.mocked(supabase.from).mockClear();
});

const renderCard = () =>
  render(<BasPrepCard fy={2025} quarter={4} quarterName="Q4 (Apr-Jun)" dueDate="2026-07-28" />);

describe('BasPrepCard (SC-3.E.01)', () => {
  it('renders worksheet labels and lets you approve-and-lodge when there are no blockers', async () => {
    h.worksheet = SAMPLE;
    h.blockers = { treatmentExceptions: 0, reconciliationVarianceCents: 0 };
    renderCard();

    expect(screen.getByText('1A GST on sales')).toBeInTheDocument();
    expect(screen.getByText('1B GST on purchases')).toBeInTheDocument();
    expect(screen.getByText('9 Net amount')).toBeInTheDocument();
    expect(screen.getByText('No GST-treatment exceptions')).toBeInTheDocument();
    expect(screen.getByText(/GL reconciles to the BAS/)).toBeInTheDocument();

    const lodge = screen.getByRole('button', { name: /Request lodge approval/i });
    expect(lodge).not.toBeDisabled();
    fireEvent.click(lodge);
    await waitFor(() => expect(h.requestLodgeApproval).toHaveBeenCalledTimes(1));
    expect(supabase.from).not.toHaveBeenCalledWith('obligation_status');
    expect(await screen.findByText(/will only be marked lodged after/i)).toBeInTheDocument();
  });

  it('disables approve-and-lodge and surfaces both blockers when exceptions or variance exist', () => {
    h.worksheet = SAMPLE;
    h.blockers = { treatmentExceptions: 3, reconciliationVarianceCents: -5000 };
    renderCard();

    expect(screen.getByText(/3 GST-treatment exceptions - resolve/)).toBeInTheDocument();
    expect(screen.getByText(/GL vs BAS variance .* reconcile/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Request lodge approval/i })).toBeDisabled();
    expect(h.requestLodgeApproval).not.toHaveBeenCalled();
  });

  it('reads "check unavailable" (not "clean") when a blocker view is not deployed', () => {
    h.worksheet = SAMPLE;
    h.blockers = { treatmentExceptions: null, reconciliationVarianceCents: null };
    renderCard();

    expect(screen.getByText('GST-treatment check unavailable')).toBeInTheDocument();
    expect(screen.getByText('Reconciliation not available')).toBeInTheDocument();
  });
});
