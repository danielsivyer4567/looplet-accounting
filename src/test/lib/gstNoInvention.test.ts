/**
 * GST-01: no GST credit is invented when a bill or receipt does not show GST, or when the supplier
 * is not registered for GST. The old code filled a missing GST figure with 1/11 of the total in the
 * Receipt Hub (typed and photo capture) and in Bill detail, which put a GST credit on the BAS that
 * the document never supported.
 *
 * ATO: no GST credit for purchases with no GST in the price, including from a supplier that is not
 * registered for GST; a tax invoice is needed for purchases over $82.50.
 * https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/claiming-gst-credits/when-you-cannot-claim-a-gst-credit
 */
import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gstIncludedInTotal, resolveDocumentGst } from '@/lib/gst';
import { buildManualReceiptPayload, buildReceiptPayloadFromExtraction } from '@/lib/receiptCapture';
import { BillDetailPage } from '@/pages/BillDetail';
import {
  clearSupabaseOperations,
  getSupabaseOperations,
  mockSupabaseResponse,
} from '@/test/mocks/supabase';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));
vi.mock('@/hooks/useOrg', () => {
  const currentOrg = { id: 'org-1', name: 'Test', organization_type: 'standard' as const };
  const value = {
    organizations: [currentOrg],
    currentOrg,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  };
  return { useOrg: () => value };
});
vi.mock('@/hooks/useBill', () => ({
  useBill: vi.fn(),
  getBillFileUrl: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/components/JobPicker', () => ({ JobPicker: () => null }));
vi.mock('@/components/MoveToOrgButton', () => ({ MoveToOrgButton: () => null }));
vi.mock('@/components/AllocationSplitButton', () => ({ AllocationSplitButton: () => null }));
vi.mock('@/lib/automationDecision', () => ({
  recordOverride: vi.fn(),
  recordFeedback: vi.fn().mockResolvedValue(undefined),
}));

describe('resolveDocumentGst', () => {
  it('leaves GST unknown when only a total is known (no 1/11 credit)', () => {
    expect(resolveDocumentGst({ totalCents: 11000, gstCents: null, subtotalCents: null })).toEqual({
      totalCents: 11000,
      gstCents: null,
      subtotalCents: null,
      source: 'unknown',
    });
  });

  it('uses GST the document shows, and fills the subtotal from it', () => {
    expect(resolveDocumentGst({ totalCents: 11000, gstCents: 1000, subtotalCents: null })).toEqual({
      totalCents: 11000,
      gstCents: 1000,
      subtotalCents: 10000,
      source: 'document',
    });
    expect(resolveDocumentGst({ totalCents: null, gstCents: 1000, subtotalCents: 10000 })).toEqual({
      totalCents: 11000,
      gstCents: 1000,
      subtotalCents: 10000,
      source: 'document',
    });
  });

  it('works GST out from a printed subtotal and total, and says so', () => {
    expect(resolveDocumentGst({ totalCents: 11000, gstCents: null, subtotalCents: 10000 })).toEqual(
      { totalCents: 11000, gstCents: 1000, subtotalCents: 10000, source: 'subtotal_difference' },
    );
    expect(
      resolveDocumentGst({ totalCents: 4000, gstCents: null, subtotalCents: 4000 }).source,
    ).toBe('none');
  });

  it('gives no GST credit for a supplier that is not registered for GST', () => {
    expect(
      resolveDocumentGst({
        totalCents: 11000,
        gstCents: 1000,
        subtotalCents: null,
        supplierGstRegistered: false,
      }),
    ).toEqual({ totalCents: 11000, gstCents: 0, subtotalCents: 11000, source: 'none' });
  });

  it('only computes 1/11 when asked to, rounded to the nearest cent', () => {
    expect(gstIncludedInTotal(11000)).toBe(1000);
    expect(gstIncludedInTotal(1000)).toBe(91); // 90.9 cents
    expect(gstIncludedInTotal(1004)).toBe(91); // 91.27 cents
  });
});

describe('Receipt Hub capture payloads', () => {
  const base = {
    merchant: 'Corner Hardware',
    totalCents: 5500,
    purchaseAt: '2026-09-30T02:00:00.000Z',
    receiptNumber: 'MAN-1',
    jobReference: '',
    organizationId: 'org-1',
  };

  it('a typed receipt with GST left blank sends no GST or subtotal', () => {
    const payload = buildManualReceiptPayload({ ...base, gstCents: null });
    expect(payload.receipt.total_inc_gst_cents).toBe(5500);
    expect(payload.receipt).not.toHaveProperty('gst_cents');
    expect(payload.receipt).not.toHaveProperty('subtotal_ex_gst_cents');
    expect(payload.line_items[0]).not.toHaveProperty('gst_cents');
  });

  it('a typed receipt with GST sends exactly what was entered', () => {
    const payload = buildManualReceiptPayload({ ...base, gstCents: 500 });
    expect(payload.receipt).toMatchObject({ gst_cents: 500, subtotal_ex_gst_cents: 5000 });
    expect(payload.line_items[0]).toMatchObject({ gst_cents: 500 });
    const noGst = buildManualReceiptPayload({ ...base, gstCents: 0 });
    expect(noGst.receipt).toMatchObject({ gst_cents: 0, subtotal_ex_gst_cents: 5500 });
  });

  it('a photo or PDF that only shows a total sends no GST, at receipt or line level', () => {
    const payload = buildReceiptPayloadFromExtraction(
      {
        supplier_name: 'Corner Hardware',
        supplier_abn: null,
        invoice_number: 'R-9',
        invoice_date: '2026-09-30',
        subtotal_ex_gst: null,
        gst_amount: null,
        total_inc_gst: 55,
        currency: 'AUD',
        job_reference: null,
        line_items: [{ description: 'Timber', quantity: 1, unit_price: 55, total: 55 }],
      },
      'org-1',
      'org-org-1/2026-09-30/abc-receipt.jpg',
    );
    expect(payload.receipt.total_inc_gst_cents).toBe(5500);
    expect(payload.receipt.gst_cents).toBeUndefined();
    expect(payload.receipt.subtotal_ex_gst_cents).toBeUndefined();
    expect(payload.line_items[0]).not.toHaveProperty('gst_cents');
  });

  it('a photo or PDF that shows GST sends it', () => {
    const payload = buildReceiptPayloadFromExtraction(
      {
        supplier_name: 'Corner Hardware',
        supplier_abn: '51 824 753 556',
        invoice_number: 'R-10',
        invoice_date: '2026-09-30',
        subtotal_ex_gst: 50,
        gst_amount: 5,
        total_inc_gst: 55,
        currency: 'AUD',
        job_reference: null,
        line_items: [],
      },
      'org-1',
      'key',
    );
    expect(payload.receipt).toMatchObject({ gst_cents: 500, subtotal_ex_gst_cents: 5000 });
  });
});

const billWithoutGst = {
  id: 'bill-1',
  organization_id: 'org-1',
  job_id: null,
  status: 'received' as const,
  source: 'email',
  storage_key: 'bills/bill-1.pdf',
  original_filename: 'invoice.pdf',
  mime_type: 'application/pdf',
  supplier_name_raw: 'Corner Hardware',
  supplier_abn: null,
  invoice_number: 'INV-7',
  invoice_date: '2026-09-30',
  due_date: '2026-10-30',
  total_inc_gst_cents: null,
  gst_cents: null,
  subtotal_ex_gst_cents: null,
  currency_code: 'AUD',
  job_reference_raw: null,
  notes: null,
  ocr_provider: null,
  ocr_confidence: null,
  xero_status: 'not_in_xero',
  xero_invoice_id: null,
  attached_at: null,
  is_personal: false,
  suggested_job_id: null,
  suggested_match_score: null,
  raw_extracted: null,
  created_at: '2026-09-30T00:00:00Z',
  deleted_at: null,
  line_items: [],
};

async function renderBillAndEdit(bill: Record<string, unknown>) {
  const { useBill } = await import('@/hooks/useBill');
  vi.mocked(useBill).mockReturnValue({
    bill: bill as never,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  });
  render(
    createElement(
      MemoryRouter,
      { initialEntries: ['/bills/bill-1'] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: '/bills/:id', element: createElement(BillDetailPage) }),
      ),
    ),
  );
  fireEvent.click(await screen.findByRole('button', { name: /edit details/i }));
}

function savedBillUpdate(): Record<string, unknown> | undefined {
  return getSupabaseOperations().find((op) => op.table === 'bills' && op.method === 'update')
    ?.payload as Record<string, unknown> | undefined;
}

describe('Bill detail saves only the GST the owner gives it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSupabaseOperations();
    mockSupabaseResponse({ data: [], error: null });
  });

  it('a total with GST left blank saves GST as unknown, not total ÷ 11', async () => {
    await renderBillAndEdit(billWithoutGst);
    fireEvent.change(screen.getByLabelText(/total inc gst/i), { target: { value: '110.00' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(savedBillUpdate()).toBeTruthy());
    expect(savedBillUpdate()).toMatchObject({
      total_inc_gst_cents: 11000,
      gst_cents: null,
      subtotal_ex_gst_cents: null,
      gst_estimated: false,
    });
  });

  it('"No GST" records zero GST for an unregistered supplier', async () => {
    await renderBillAndEdit(billWithoutGst);
    fireEvent.change(screen.getByLabelText(/total inc gst/i), { target: { value: '110.00' } });
    fireEvent.click(screen.getByRole('button', { name: /no gst \(supplier not registered/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(savedBillUpdate()).toBeTruthy());
    expect(savedBillUpdate()).toMatchObject({
      total_inc_gst_cents: 11000,
      gst_cents: 0,
      subtotal_ex_gst_cents: 11000,
    });
  });

  it('"Bill says total includes GST" is the only way to get 1/11, and it is explicit', async () => {
    await renderBillAndEdit(billWithoutGst);
    fireEvent.change(screen.getByLabelText(/total inc gst/i), { target: { value: '110.00' } });
    fireEvent.click(screen.getByRole('button', { name: /bill says total includes gst/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(savedBillUpdate()).toBeTruthy());
    expect(savedBillUpdate()).toMatchObject({
      total_inc_gst_cents: 11000,
      gst_cents: 1000,
      subtotal_ex_gst_cents: 10000,
      gst_estimated: false,
    });
  });

  it('shows a bill with no GST figure as "not shown", not as $0.00', async () => {
    const { useBill } = await import('@/hooks/useBill');
    vi.mocked(useBill).mockReturnValue({
      bill: { ...billWithoutGst, total_inc_gst_cents: 11000 } as never,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/bills/bill-1'] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/bills/:id', element: createElement(BillDetailPage) }),
        ),
      ),
    );
    expect(await screen.findByText(/not shown: no gst credit claimed/i)).toBeInTheDocument();
  });
});
