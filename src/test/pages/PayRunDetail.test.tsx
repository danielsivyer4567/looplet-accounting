import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * TerminationWizard flow (SC-3.L.03). Runtime look (Preview MCP unavailable): drives
 * the notice→leave→ETP→review wizard with a mocked supabase — Calculate invokes
 * payroll-termination (SC-3.L.01) and Save writes run.metadata.termination (which the
 * SC-3.L.02 STP export reads). Asserts the calc invoke + the persisted termination
 * shape, then "Save & finalise" runs the existing finalise path.
 */

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  updatePayload: null as unknown,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: (name: string, opts: unknown) => h.invoke(name, opts) },
    from: () => ({
      update: (payload: unknown) => {
        h.updatePayload = payload;
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  },
}));

import { TerminationWizard } from '@/pages/PayRunDetail';

const Wizard = TerminationWizard as unknown as (p: Record<string, unknown>) => JSX.Element;

const CALC_RESULT = {
  redundancy_tax_free_cents: 7_516_400,
  etp_taxable_cents: 2_483_600,
  etp_tax_cents: 794_752,
  unused_leave_tax_cents: 960_000,
  tax_free_cents: 7_516_400,
  total_tax_cents: 1_754_752,
  net_cents: 11_245_248,
  gross_termination_cents: 13_000_000,
};

const run = { id: 'run-1', pay_date: '2026-06-30', metadata: { existing: true } };
const slips = [{ employee_id: 'e1', employee: { full_name: 'Jane Doe', email: null } }];

let onClose: ReturnType<typeof vi.fn>;
let onSaved: ReturnType<typeof vi.fn>;
let onFinalise: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.invoke = vi.fn().mockResolvedValue({ data: { ok: true, result: CALC_RESULT }, error: null });
  h.updatePayload = null;
  onClose = vi.fn();
  onSaved = vi.fn();
  onFinalise = vi.fn().mockResolvedValue(undefined);
});

function renderWizard(isOwner = true) {
  render(
    <Wizard
      run={run}
      slips={slips}
      organizationId="org-1"
      isOwner={isOwner}
      onClose={onClose}
      onSaved={onSaved}
      onFinalise={onFinalise}
    />,
  );
}

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));

describe('TerminationWizard (SC-3.L.03)', () => {
  it('steps through, calculates via payroll-termination, and saves the termination metadata', async () => {
    renderWizard(true);
    // notice → leave → ETP → review
    next();
    next();
    next();
    fireEvent.click(screen.getByRole('button', { name: /Calculate breakdown/i }));

    // calc invoked with the right fn + payload
    await waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1));
    const [invokeName, invokeOpts] = h.invoke.mock.calls[0] ?? [];
    expect(invokeName).toBe('payroll-termination');
    const body = (
      invokeOpts as
        | { body: { organization_id: string; employee_id: string; input: { reason: string } } }
        | undefined
    )?.body;
    expect(body?.organization_id).toBe('org-1');
    expect(body?.employee_id).toBe('e1');
    expect(body?.input.reason).toBe('genuine_redundancy');

    // breakdown renders
    expect(await screen.findByText(/Total tax withheld/i)).toBeInTheDocument();

    // Save details → writes run.metadata.termination (preserving existing metadata)
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const payload = h.updatePayload as {
      metadata: { existing?: boolean; termination: Record<string, unknown> };
    };
    expect(payload.metadata.existing).toBe(true); // spread preserved
    expect(payload.metadata.termination).toMatchObject({
      employee_id: 'e1',
      cessation_date: '2026-06-30',
      reason: 'genuine_redundancy',
      etp: { taxable_cents: 2_483_600, tax_free_cents: 7_516_400, tax_withheld_cents: 794_752 },
    });
    expect(onFinalise).not.toHaveBeenCalled(); // "Save details" does not finalise
  });

  it('"Save & finalise" runs the existing finalise path (owner only)', async () => {
    renderWizard(true);
    next();
    next();
    next();
    fireEvent.click(screen.getByRole('button', { name: /Calculate breakdown/i }));
    await screen.findByText(/Total tax withheld/i);
    fireEvent.click(screen.getByRole('button', { name: /Save & finalise/i }));
    await waitFor(() => expect(onFinalise).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('hides "Save & finalise" for non-owners', async () => {
    renderWizard(false);
    next();
    next();
    next();
    fireEvent.click(screen.getByRole('button', { name: /Calculate breakdown/i }));
    await screen.findByText(/Total tax withheld/i);
    expect(screen.queryByRole('button', { name: /Save & finalise/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save details' })).toBeInTheDocument();
  });
});
