/**
 * INV-01: an invoice can be issued as a tax invoice (a PDF headed "Tax invoice" with the seller's
 * ABN and GST) and sent. Before this there was no PDF, no "Tax invoice" heading and no ABN anywhere;
 * "Mark sent" only flipped a status.
 *
 * ATO tax invoice requirements (https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/tax-invoices):
 * under $1,000: intended to be a tax invoice, seller identity, seller ABN, date issued, items with
 * quantity and price, GST amount, extent each sale is taxable; $1,000 or more: also the buyer's
 * identity or ABN. Not registered for GST: a standard invoice, without the words "tax invoice"
 * (https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/record-keeping-for-business/setting-up-and-managing-records/setting-up-your-business-invoices).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  invoiceIssueProblems,
  renderInvoicePdf,
  type InvoiceDocumentInput,
} from '@/lib/taxInvoice';

const db = vi.hoisted(() => ({
  tables: {} as Record<string, unknown>,
  writes: [] as { table: string; method: string; payload: unknown }[],
}));

vi.mock('@/lib/supabase', () => {
  function builder(table: string) {
    const result = (one: boolean) => {
      const data = db.tables[table];
      if (one)
        return { data: Array.isArray(data) ? (data[0] ?? null) : (data ?? null), error: null };
      return { data: data ?? [], error: null };
    };
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'order', 'in', 'limit', 'neq']) {
      chain[method] = () => chain;
    }
    for (const method of ['insert', 'update', 'upsert']) {
      chain[method] = (payload: unknown) => {
        db.writes.push({ table, method, payload });
        return chain;
      };
    }
    chain['delete'] = () => {
      db.writes.push({ table, method: 'delete', payload: null });
      return chain;
    };
    chain['single'] = () => Promise.resolve(result(true));
    chain['maybeSingle'] = () => Promise.resolve(result(true));
    chain['then'] = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(result(false)).then(resolve);
    return chain;
  }
  return {
    supabase: {
      from: vi.fn((table: string) => builder(table)),
      rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }) },
    },
  };
});

vi.mock('@/hooks/useOrg', () => {
  const currentOrg = { id: 'org-1', name: 'Corner Fencing', organization_type: 'standard' };
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
vi.mock('@/components/MoveToOrgButton', () => ({ MoveToOrgButton: () => null }));
vi.mock('@/components/ArchiveButton', () => ({ ArchiveButton: () => null }));
vi.mock('@/lib/automationJobs', () => ({ enqueueJob: vi.fn().mockResolvedValue(undefined) }));

import { InvoiceDetailPage } from '@/pages/InvoiceDetail';

const SELLER_ABN = '12 345 678 901';

const base: InvoiceDocumentInput = {
  invoiceNumber: 'INV-0042',
  issueDate: '2026-10-03',
  dueDate: '2026-10-17',
  seller: { name: 'Corner Fencing', abn: SELLER_ABN, gstRegistered: true },
  buyer: { name: 'Acme Homes', abn: null, email: 'accounts@example.com' },
  lines: [
    {
      description: 'Colorbond fence install',
      quantity: 2,
      unitPriceCents: 25000,
      gstTreatment: 'ex',
      totalIncGstCents: 55000,
      gstCents: 5000,
    },
    {
      description: 'Council permit fee',
      quantity: 1,
      unitPriceCents: 12000,
      gstTreatment: 'free',
      totalIncGstCents: 12000,
      gstCents: 0,
    },
  ],
  notes: 'Thanks for your business',
  amountPaidCents: 0,
};

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;
  const parts: string[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    for (const item of content.items) if ('str' in item) parts.push(item.str);
  }
  return parts.join(' ');
}

describe('tax invoice document (INV-01)', () => {
  it('a GST-registered seller gets a valid PDF with every tax-invoice detail', async () => {
    const text = await pdfText(renderInvoicePdf(base));
    expect(text).toMatch(/^Tax invoice/); // intended to be a tax invoice
    expect(text).toContain('Corner Fencing'); // seller identity
    expect(text).toContain('ABN 12 345 678 901'); // seller ABN
    expect(text).toContain('Date issued: 03/10/2026'); // date issued
    expect(text).toContain('Colorbond fence install'); // items, quantity, price
    expect(text).toContain('$250.00');
    expect(text).toContain('Acme Homes'); // buyer identity (needed at $1,000 or more)
    expect(text).toContain('Taxable - unit price excludes GST'); // extent taxable
    expect(text).toContain('GST-free');
    expect(text).toContain('Total GST');
    expect(text).toContain('$50.00'); // GST payable
    expect(text).toContain('Total including GST');
    expect(text).toContain('$670.00'); // total payable
  });

  it('a seller not registered for GST gets a plain invoice without the words "tax invoice"', async () => {
    const input: InvoiceDocumentInput = {
      ...base,
      seller: { name: 'Corner Fencing', abn: null, gstRegistered: false },
      lines: base.lines.map((line) => ({
        ...line,
        gstTreatment: 'free' as const,
        gstCents: 0,
        totalIncGstCents: line.quantity * line.unitPriceCents,
      })),
    };
    expect(invoiceIssueProblems(input)).toEqual([]);
    const text = await pdfText(renderInvoicePdf(input));
    expect(text).toMatch(/^Invoice/);
    expect(text.toLowerCase()).not.toContain('tax invoice');
    expect(text).toContain('No GST has been charged.');
  });

  it('refuses to issue a tax invoice without the seller ABN', () => {
    const input = { ...base, seller: { ...base.seller, abn: null } };
    expect(invoiceIssueProblems(input)).toEqual([expect.stringMatching(/ABN/)]);
    expect(() => renderInvoicePdf(input)).toThrow(/ABN/);
    expect(invoiceIssueProblems({ ...base, seller: { ...base.seller, abn: '123' } })).toHaveLength(
      1,
    );
  });

  it('needs the buyer at $1,000 or more, and stops an unregistered seller charging GST', () => {
    const big = {
      ...base,
      buyer: { name: null, abn: null, email: null },
      lines: [
        {
          description: 'Colorbond fence install',
          quantity: 4,
          unitPriceCents: 25000,
          gstTreatment: 'ex' as const,
          totalIncGstCents: 110000,
          gstCents: 10000,
        },
      ],
    };
    expect(invoiceIssueProblems(big)).toEqual([expect.stringMatching(/\$1,000 or more/)]);
    expect(
      invoiceIssueProblems({ ...big, buyer: { name: null, abn: '98 765 432 109', email: null } }),
    ).toEqual([]);
    expect(
      invoiceIssueProblems({ ...base, seller: { ...base.seller, gstRegistered: false } }),
    ).toEqual([expect.stringMatching(/not registered for GST/)]);
  });
});

function renderInvoice(path = '/invoices/invoice-1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
        <Route path="/invoices/new" element={<InvoiceDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function seedInvoice(org: { abn: string | null; gst_registered?: boolean }) {
  db.tables = {
    customers: [{ id: 'cust-1', name: 'Acme Homes', email: 'accounts@example.com', abn: null }],
    jobs: [],
    invoices: [
      {
        id: 'invoice-1',
        invoice_number: 'INV-0042',
        customer_id: 'cust-1',
        job_id: null,
        issue_date: '2026-10-03',
        due_date: '2026-10-17',
        terms_days: 14,
        subtotal_ex_gst_cents: 62000,
        gst_cents: 5000,
        total_inc_gst_cents: 67000,
        amount_paid_cents: 0,
        balance_due_cents: 67000,
        status: 'draft',
        notes: 'Thanks for your business',
        internal_notes: null,
        sent_at: null,
        paid_at: null,
        xero_status: null,
        xero_invoice_id: null,
        xero_synced_at: null,
        metadata: {},
        deleted_at: null,
        customer: { id: 'cust-1', name: 'Acme Homes', email: 'accounts@example.com', abn: null },
        job: null,
      },
    ],
    invoice_line_items: [
      {
        id: 'line-1',
        line_number: 1,
        description: 'Colorbond fence install',
        quantity: 2,
        unit_price_cents: 25000,
        gst_treatment: 'ex',
        line_total_ex_gst_cents: 50000,
        line_gst_cents: 5000,
        line_total_inc_gst_cents: 55000,
      },
      {
        id: 'line-2',
        line_number: 2,
        description: 'Council permit fee',
        quantity: 1,
        unit_price_cents: 12000,
        gst_treatment: 'free',
        line_total_ex_gst_cents: 12000,
        line_gst_cents: 0,
        line_total_inc_gst_cents: 12000,
      },
    ],
    invoice_payments: [],
    organizations: [
      {
        name: 'Corner Fencing',
        abn: org.abn,
        settings: org.gst_registered === undefined ? {} : { gst_registered: org.gst_registered },
      },
    ],
    business_profile: [{ is_gst_registered: true }],
  };
}

describe('issuing from the invoice page (INV-01)', () => {
  let created: File | null = null;

  beforeEach(() => {
    db.writes = [];
    created = null;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      created = blob as File;
      return 'blob:tax-invoice';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('downloads the tax invoice PDF with the seller ABN and GST, and offers to email it', async () => {
    seedInvoice({ abn: SELLER_ABN });
    renderInvoice();

    const download = await screen.findByRole('button', { name: /download tax invoice \(pdf\)/i });
    expect(download).toBeEnabled();
    fireEvent.click(download);

    expect(created).not.toBeNull();
    const file = created as unknown as File;
    expect(file.name).toBe('Tax-invoice-INV-0042.pdf');
    expect(file.type).toBe('application/pdf');
    const text = await pdfText(new Uint8Array(await file.arrayBuffer()));
    expect(text).toMatch(/^Tax invoice/);
    expect(text).toContain('ABN 12 345 678 901');
    expect(text).toContain('Total GST');
    expect(text).toContain('$50.00');
    expect(text).toContain('Acme Homes');

    expect(await screen.findByRole('status')).toHaveTextContent(/then click mark sent/i);
    const email = screen.getByRole('link', { name: /email customer/i });
    expect(email.getAttribute('href')).toMatch(
      /^mailto:accounts%40example\.com\?subject=Tax%20invoice%20INV-0042/,
    );
    // Looplet does not claim to have sent anything.
    expect(screen.getByText(/Looplet doesn’t email invoices for you/)).toBeInTheDocument();
    expect(db.writes.filter((w) => w.table === 'invoices')).toEqual([]);
  });

  it('blocks the tax invoice and says why when the business has no ABN', async () => {
    seedInvoice({ abn: null });
    renderInvoice();

    const download = await screen.findByRole('button', { name: /download tax invoice \(pdf\)/i });
    expect(download).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/must show the seller’s ABN/);
    expect(screen.queryByRole('link', { name: /email customer/i })).not.toBeInTheDocument();
  });

  it('a business not registered for GST is told it cannot charge GST on a plain invoice', async () => {
    seedInvoice({ abn: null, gst_registered: false });
    renderInvoice();

    const download = await screen.findByRole('button', { name: /download invoice \(pdf\)/i });
    expect(download).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/can’t charge GST/);
    expect(screen.queryByText(/download tax invoice/i)).not.toBeInTheDocument();
  });

  it('stores GST-inclusive lines with the right ex-GST amount', async () => {
    db.tables = {
      customers: [{ id: 'cust-1', name: 'Acme Homes', email: null }],
      jobs: [],
      // The created row; after saving, the page reloads it, so it needs the fields the page reads.
      invoices: [
        { id: 'invoice-9', issue_date: '2026-10-03', terms_days: 14, status: 'draft', notes: null },
      ],
    };
    renderInvoice('/invoices/new');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /customer/i })).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByRole('combobox', { name: /customer/i }), {
      target: { value: 'cust-1' },
    });
    fireEvent.change(screen.getByPlaceholderText(/fence install/i), {
      target: { value: 'Gate hinge kit' },
    });
    fireEvent.change(screen.getByDisplayValue('0.00'), { target: { value: '110.00' } });
    fireEvent.change(screen.getByRole('combobox', { name: /gst/i }), { target: { value: 'inc' } });
    fireEvent.click(screen.getByRole('button', { name: /create invoice/i }));

    await waitFor(() =>
      expect(
        db.writes.find((w) => w.table === 'invoice_line_items' && w.method === 'insert'),
      ).toBeTruthy(),
    );
    const insert = db.writes.find((w) => w.table === 'invoice_line_items' && w.method === 'insert');
    expect(insert?.payload).toEqual([
      expect.objectContaining({
        gst_treatment: 'inc',
        line_total_inc_gst_cents: 11000,
        line_gst_cents: 1000,
        line_total_ex_gst_cents: 10000, // was stored as 11000, so subtotal + GST overstated the total
      }),
    ]);
  });
});
