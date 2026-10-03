/**
 * Tax invoices: what an Australian tax invoice must show, and a small PDF writer for it.
 * Money is integer cents. No dependencies: the PDF uses the standard Helvetica fonts.
 *
 * ATO, Tax invoices (https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/tax-invoices):
 * a tax invoice for a sale under $1,000 must let the buyer work out 7 details: that it is intended
 * to be a tax invoice; the seller's identity; the seller's ABN; the date it was issued; a brief
 * description of the items sold, with quantity (if applicable) and price; the GST amount (if any);
 * and the extent to which each sale is taxable. For sales of $1,000 or more it must also show the
 * buyer's identity or ABN. An invoice that mixes taxable and non-taxable items must show which items
 * are taxable, the GST payable and the total payable. GST on one sale is rounded to the nearest cent.
 * We always show the buyer, so every invoice meets the $1,000-or-more rules.
 *
 * ATO, Setting up your business invoices: a business that is not registered for GST must not use the
 * words "tax invoice" and issues a standard invoice.
 * https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/record-keeping-for-business/setting-up-and-managing-records/setting-up-your-business-invoices
 */

export type InvoiceGstTreatment = 'inc' | 'ex' | 'free' | 'zero';

export interface InvoiceDocumentLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  gstTreatment: InvoiceGstTreatment;
  totalIncGstCents: number;
  gstCents: number;
}

export interface InvoiceDocumentInput {
  invoiceNumber: string;
  issueDate: string;
  dueDate: string | null;
  seller: { name: string; abn: string | null; gstRegistered: boolean };
  buyer: { name: string | null; abn: string | null; email: string | null };
  lines: InvoiceDocumentLine[];
  notes: string | null;
  amountPaidCents: number;
}

/** A tax invoice for a sale at or above this GST-inclusive total must identify the buyer. */
export const BUYER_IDENTITY_THRESHOLD_CENTS = 100_000;

const TREATMENT_LABEL: Record<InvoiceGstTreatment, string> = {
  inc: 'Taxable - unit price includes GST',
  ex: 'Taxable - unit price excludes GST',
  free: 'GST-free',
  zero: 'GST-free (zero-rated)',
};

export function abnDigits(abn: string | null | undefined): string | null {
  const digits = (abn ?? '').replace(/\s+/g, '');
  return /^\d{11}$/.test(digits) ? digits : null;
}

export function formatAbn(abn: string): string {
  const d = abnDigits(abn) ?? abn;
  return d.length === 11 ? `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : d;
}

export function invoiceTotals(lines: InvoiceDocumentLine[]) {
  const total = lines.reduce((sum, line) => sum + line.totalIncGstCents, 0);
  const gst = lines.reduce((sum, line) => sum + line.gstCents, 0);
  return { totalIncGstCents: total, gstCents: gst, totalExGstCents: total - gst };
}

/**
 * What stops this invoice being issued. For a GST-registered seller it must be a valid tax invoice;
 * for a seller that is not registered it must be a plain invoice that charges no GST.
 */
export function invoiceIssueProblems(input: InvoiceDocumentInput): string[] {
  const problems: string[] = [];
  const lines = input.lines.filter((line) => (line.description ?? '').trim());
  if (!(input.seller.name ?? '').trim())
    problems.push('Add your business name (Settings → Account).');
  if (!(input.invoiceNumber ?? '').trim())
    problems.push('Save the invoice so it gets an invoice number.');
  if (!input.issueDate) problems.push('Set the issue date.');
  if (lines.length === 0) problems.push('Add at least one line item with a description.');
  if (input.seller.gstRegistered) {
    if (!abnDigits(input.seller.abn)) {
      problems.push(
        'Add your 11-digit ABN (Settings → Account): a tax invoice must show the seller’s ABN.',
      );
    }
    const { totalIncGstCents } = invoiceTotals(lines);
    if (
      totalIncGstCents >= BUYER_IDENTITY_THRESHOLD_CENTS &&
      !input.buyer.name?.trim() &&
      !abnDigits(input.buyer.abn)
    ) {
      problems.push('A tax invoice of $1,000 or more must show the customer’s name or ABN.');
    }
  } else if (lines.some((line) => line.gstCents !== 0)) {
    problems.push(
      'Your business is set as not registered for GST, so it can’t charge GST. Set those lines to GST-free, or update your GST registration in Settings.',
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;

// Unicode characters the standard fonts' WinAnsi encoding has, at their WinAnsi byte.
const WIN_ANSI: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  '„': 0x84,
  '…': 0x85,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '™': 0x99,
};

/** Text as WinAnsi bytes (one char per byte), escaped for a PDF string. Unmappable chars become '?'. */
function pdfText(text: string): string {
  let out = '';
  for (const ch of text.replace(/\s+/g, ' ')) {
    const code = ch.codePointAt(0) ?? 63;
    let byte: number;
    if (WIN_ANSI[ch] != null) byte = WIN_ANSI[ch] as number;
    else if (code >= 0x20 && code <= 0x7e) byte = code;
    else if (code >= 0xa0 && code <= 0xff) byte = code;
    else byte = 63;
    const c = String.fromCharCode(byte);
    out += c === '(' || c === ')' || c === '\\' ? `\\${c}` : c;
  }
  return out;
}

/** Approximate Helvetica advance width, used for right-aligning figures and wrapping text. */
function textWidth(text: string, size: number): number {
  let units = 0;
  for (const ch of text) {
    if (/[0-9$]/.test(ch)) units += 556;
    else if (ch === ',' || ch === '.' || ch === ' ') units += 278;
    else if (ch === '-') units += 333;
    else if (/[ilIjtf']/.test(ch)) units += 250;
    else if (/[mwMW]/.test(ch)) units += 860;
    else units += 560;
  }
  return (units / 1000) * size;
}

function wrap(text: string, size: number, width: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && textWidth(candidate, size) > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

export function formatAud(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-AU');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

function formatQuantity(quantity: number): string {
  return Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(3).replace(/0+$/, '');
}

function formatDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : iso;
}

class PageWriter {
  pages: string[] = [];
  private ops: string[] = [];
  y = PAGE_HEIGHT - MARGIN;

  text(x: number, text: string, size = 10, bold = false) {
    this.ops.push(
      `BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${this.y.toFixed(2)} Tm (${pdfText(text)}) Tj ET`,
    );
  }

  right(xRight: number, text: string, size = 10, bold = false) {
    this.text(xRight - textWidth(text, size), text, size, bold);
  }

  rule(gray = 0.75) {
    this.ops.push(
      `${gray} g ${MARGIN} ${(this.y - 4).toFixed(2)} ${(PAGE_WIDTH - 2 * MARGIN).toFixed(2)} 0.6 re f 0 g`,
    );
  }

  down(amount: number) {
    this.y -= amount;
    if (this.y < MARGIN + 40) this.newPage();
  }

  newPage() {
    this.pages.push(this.ops.join('\n'));
    this.ops = [];
    this.y = PAGE_HEIGHT - MARGIN;
  }

  finish(): string[] {
    this.pages.push(this.ops.join('\n'));
    this.ops = [];
    return this.pages;
  }
}

/** The PDF's title: "Tax invoice" for a GST-registered seller, otherwise "Invoice". */
export function invoiceDocumentTitle(input: InvoiceDocumentInput): string {
  return input.seller.gstRegistered ? 'Tax invoice' : 'Invoice';
}

export function renderInvoicePdf(input: InvoiceDocumentInput): Uint8Array<ArrayBuffer> {
  const problems = invoiceIssueProblems(input);
  if (problems.length > 0) throw new Error(problems.join(' '));

  const lines = input.lines.filter((line) => (line.description ?? '').trim());
  const taxInvoice = input.seller.gstRegistered;
  const totals = invoiceTotals(lines);
  const w = new PageWriter();
  const right = PAGE_WIDTH - MARGIN;

  w.text(MARGIN, invoiceDocumentTitle(input), 22, true);
  w.right(right, `Invoice ${input.invoiceNumber}`, 11, true);
  w.down(30);

  w.text(MARGIN, input.seller.name, 12, true);
  w.right(right, `Date issued: ${formatDate(input.issueDate)}`, 10);
  w.down(15);
  const sellerAbn = abnDigits(input.seller.abn);
  if (sellerAbn) {
    w.text(MARGIN, `ABN ${formatAbn(sellerAbn)}`, 10);
  } else if (!taxInvoice) {
    w.text(MARGIN, 'Not registered for GST', 10);
  }
  if (input.dueDate) w.right(right, `Due: ${formatDate(input.dueDate)}`, 10);
  w.down(26);

  w.text(MARGIN, 'Bill to', 9, true);
  w.down(13);
  w.text(MARGIN, input.buyer.name?.trim() || 'Customer', 11, true);
  w.down(13);
  const buyerAbn = abnDigits(input.buyer.abn);
  if (buyerAbn) {
    w.text(MARGIN, `ABN ${formatAbn(buyerAbn)}`, 10);
    w.down(13);
  }
  if (input.buyer.email) {
    w.text(MARGIN, input.buyer.email, 10);
    w.down(13);
  }
  w.down(14);

  const col = { qty: 330, price: 400, gst: 455, amount: right };
  w.text(MARGIN, 'Description', 9, true);
  w.right(col.qty, 'Qty', 9, true);
  w.right(col.price, 'Unit price', 9, true);
  w.right(col.gst, 'GST', 9, true);
  w.right(col.amount, taxInvoice ? 'Amount inc GST' : 'Amount', 9, true);
  w.rule();
  w.down(16);

  for (const line of lines) {
    const wrapped = wrap(line.description, 10, col.qty - MARGIN - 40);
    w.text(MARGIN, wrapped[0] ?? '', 10);
    w.right(col.qty, formatQuantity(line.quantity), 10);
    w.right(col.price, formatAud(line.unitPriceCents), 10);
    w.right(col.gst, formatAud(line.gstCents), 10);
    w.right(col.amount, formatAud(line.totalIncGstCents), 10);
    for (const extra of wrapped.slice(1)) {
      w.down(12);
      w.text(MARGIN, extra, 10);
    }
    if (taxInvoice) {
      w.down(11);
      w.text(MARGIN, TREATMENT_LABEL[line.gstTreatment], 8);
    }
    w.down(16);
  }
  w.rule();
  w.down(18);

  const totalRow = (label: string, cents: number, bold = false) => {
    w.right(col.gst, label, 10, bold);
    w.right(col.amount, formatAud(cents), 10, bold);
    w.down(15);
  };
  if (taxInvoice) {
    totalRow('Total excluding GST', totals.totalExGstCents);
    totalRow('Total GST', totals.gstCents);
    totalRow('Total including GST', totals.totalIncGstCents, true);
  } else {
    totalRow('Total', totals.totalIncGstCents, true);
  }
  if (input.amountPaidCents > 0) {
    totalRow('Paid', input.amountPaidCents);
    totalRow('Balance due', Math.max(totals.totalIncGstCents - input.amountPaidCents, 0), true);
  }
  w.down(10);

  if (
    taxInvoice &&
    lines.some((line) => line.gstTreatment === 'free' || line.gstTreatment === 'zero')
  ) {
    w.text(
      MARGIN,
      'Items marked GST-free have no GST. GST is charged only on items marked Taxable.',
      9,
    );
    w.down(14);
  }
  if (!taxInvoice) {
    w.text(MARGIN, 'No GST has been charged.', 9);
    w.down(14);
  }
  if (input.notes?.trim()) {
    w.down(6);
    for (const noteLine of wrap(input.notes, 10, PAGE_WIDTH - 2 * MARGIN)) {
      w.text(MARGIN, noteLine, 10);
      w.down(13);
    }
  }

  return assemblePdf(w.finish(), `${invoiceDocumentTitle(input)} ${input.invoiceNumber}`);
}

function assemblePdf(pageStreams: string[], title: string): Uint8Array<ArrayBuffer> {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const regular = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  const bold = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );
  const pageIds: number[] = [];
  for (const stream of pageStreams) {
    const contents = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${contents} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const info = add(`<< /Title (${pdfText(title)}) /Producer (Looplet Accounting) >>`);

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i += 1) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
