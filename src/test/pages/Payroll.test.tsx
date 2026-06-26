import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SuperBatch } from '@/hooks/useSuperBatch';

/**
 * SuperBatchSection runtime test (SC-3.H.01). Drives the super-batch review/approve
 * section with a mocked useSuperBatch so no Supabase/network is needed — the runtime
 * look (Preview MCP unavailable, per D.02/F.04/E.01). Asserts: empty state offers
 * Generate (calls generate); a draft batch lists per-employee SG + total and the
 * Approve&send button invokes send + surfaces the gate verdict (approval-pending);
 * an already-sent batch disables send.
 */

const h = vi.hoisted(() => ({
  batch: null as SuperBatch | null,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  generate: vi.fn(),
  send: vi.fn(),
  markObligationStatus: vi.fn(),
}));

vi.mock('@/hooks/useSuperBatch', () => ({
  useSuperBatch: () => ({
    batch: h.batch,
    loading: h.loading,
    error: h.error,
    refresh: h.refresh,
    generate: h.generate,
    send: h.send,
  }),
}));
vi.mock('@/hooks/useTaxCalendar', () => ({
  markObligationStatus: (a: unknown) => h.markObligationStatus(a),
}));
vi.mock('@/hooks/useOrg', () => ({ useOrg: () => ({ currentOrg: { id: 'org-1', name: 'Test Org' } }) }));
vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

import { SuperBatchSection } from '@/pages/Payroll';

const BATCH: SuperBatch = {
  id: 'b1',
  status: 'draft',
  total_super_cents: 92000,
  line_count: 2,
  fy_start_year: 2025,
  quarter: 4,
  lines: [
    { id: 'l1', employee_id: 'e1', employee_name: 'Emp A', super_cents: 57500 },
    { id: 'l2', employee_id: 'e2', employee_name: 'Emp B', super_cents: 34500 },
  ],
};

beforeEach(() => {
  h.batch = null;
  h.loading = false;
  h.error = null;
  h.refresh = vi.fn();
  h.generate = vi.fn();
  h.send = vi.fn();
  h.markObligationStatus = vi.fn();
});

const renderSection = () => render(<SuperBatchSection fy={2025} quarter={4} />);

describe('SuperBatchSection (SC-3.H.01)', () => {
  it('offers Generate in the empty state and calls generate on click', async () => {
    renderSection();
    expect(screen.getByText(/No batch for this quarter yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Generate batch/i }));
    await waitFor(() => expect(h.generate).toHaveBeenCalledTimes(1));
  });

  it('lists per-employee SG + total and sends via the approve-gate (pending verdict)', async () => {
    h.batch = BATCH;
    h.send = vi.fn().mockResolvedValue({ ok: false, approval_id: 'appr-1' });
    renderSection();

    expect(screen.getByText('Emp A')).toBeInTheDocument();
    expect(screen.getByText('Emp B')).toBeInTheDocument();
    expect(screen.getByText(/Total \(2 employees\)/)).toBeInTheDocument();

    const sendBtn = screen.getByRole('button', { name: /Approve & send/i });
    expect(sendBtn).not.toBeDisabled();
    fireEvent.click(sendBtn);
    await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Approval requested/)).toBeInTheDocument();
    // A refused (pending) send must NOT flip the obligation — only a real send does.
    expect(h.markObligationStatus).not.toHaveBeenCalled();
  });

  it('flips the super obligation to paid on a successful send (SC-3.H.02)', async () => {
    h.batch = BATCH;
    h.send = vi.fn().mockResolvedValue({ ok: true, sent: true });
    h.markObligationStatus = vi.fn().mockResolvedValue(undefined);
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: /Approve & send/i }));
    await waitFor(() => expect(h.markObligationStatus).toHaveBeenCalledTimes(1));
    expect(h.markObligationStatus).toHaveBeenCalledWith({
      organizationId: 'org-1',
      obligationKey: 'super',
      periodLabel: 'Q4 FY2025-26',
      status: 'paid',
    });
    expect(await screen.findByText(/quarter paid/)).toBeInTheDocument();
  });

  it('disables Approve & send for an already-sent batch', () => {
    h.batch = { ...BATCH, status: 'sent' };
    renderSection();
    expect(screen.getByRole('button', { name: /Approve & send/i })).toBeDisabled();
  });
});
