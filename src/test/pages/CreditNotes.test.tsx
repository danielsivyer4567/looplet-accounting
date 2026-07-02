import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditNotesPage } from '@/pages/CreditNotes';

const h = vi.hoisted(() => ({
  createCustomer: vi.fn(),
  createSupplier: vi.fn(),
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({ currentOrg: { id: 'org-1', name: 'Test Org' } }),
}));

vi.mock('@/hooks/useCreditNotes', () => ({
  useCreditNotes: () => ({
    notes: [
      {
        id: 'cn-1',
        kind: 'customer',
        credit_note_number: 'CN-1001',
        credit_note_date: '2026-06-29',
        counterparty_name: 'Acme Pty Ltd',
        source_number: 'INV-1001',
        status: 'posted',
        total_inc_gst_cents: 11000,
        journal_entry_id: 'je-1',
        created_at: '2026-06-29T00:00:00.000Z',
      },
      {
        id: 'scn-1',
        kind: 'supplier',
        credit_note_number: 'SCN-1001',
        credit_note_date: '2026-06-28',
        counterparty_name: 'Supplier Co',
        source_number: 'BILL-1001',
        status: 'posted',
        total_inc_gst_cents: 22000,
        journal_entry_id: 'je-2',
        created_at: '2026-06-28T00:00:00.000Z',
      },
    ],
    customerSources: [
      {
        id: 'inv-1',
        label: 'INV-1001 - Acme Pty Ltd',
        subtotal_ex_gst_cents: 10000,
        gst_cents: 1000,
        total_inc_gst_cents: 11000,
      },
    ],
    supplierSources: [
      {
        id: 'bill-1',
        label: 'BILL-1001 - Supplier Co',
        subtotal_ex_gst_cents: 20000,
        gst_cents: 2000,
        total_inc_gst_cents: 22000,
      },
    ],
    loading: false,
    error: null,
    createCustomer: h.createCustomer,
    createSupplier: h.createSupplier,
  }),
}));

beforeEach(() => {
  h.createCustomer = vi.fn().mockResolvedValue(undefined);
  h.createSupplier = vi.fn().mockResolvedValue(undefined);
});

describe('CreditNotesPage', () => {
  it('lists posted AR/AP credit notes with source and journal status', () => {
    render(<CreditNotesPage />);

    expect(screen.getByRole('heading', { name: /Credit notes/i })).toBeInTheDocument();
    expect(screen.getByText('CN-1001')).toBeInTheDocument();
    expect(screen.getByText('SCN-1001')).toBeInTheDocument();
    expect(screen.getByText('Acme Pty Ltd')).toBeInTheDocument();
    expect(screen.getByText('Supplier Co')).toBeInTheDocument();
    expect(screen.getAllByText('posted')).toHaveLength(2);
  });

  it('posts a customer credit note through the hook RPC wrapper', async () => {
    render(<CreditNotesPage />);

    fireEvent.change(screen.getByLabelText(/Credit note #/i), { target: { value: 'CN-1002' } });
    fireEvent.click(screen.getByRole('button', { name: /Post credit note/i }));

    await waitFor(() => expect(h.createCustomer).toHaveBeenCalledTimes(1));
    expect(h.createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: 'inv-1',
        creditNoteNumber: 'CN-1002',
        subtotalExGstCents: 10000,
        gstCents: 1000,
        revenueAccountCode: '4000',
      }),
    );
    expect(await screen.findByText(/posted to the general ledger/i)).toBeInTheDocument();
  });
});
