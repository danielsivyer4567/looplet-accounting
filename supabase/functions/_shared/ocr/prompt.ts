/**
 * Bill extraction prompt — provider-agnostic. Used by all OCR adapters.
 * Ported from Loopletnumero's `backend/src/services/ocr/prompt.ts`.
 */

export const EXTRACT_PROMPT = `You are extracting structured data from a financial document for an Australian trades business. The document may be:
- A clean PDF invoice (best case)
- A photograph of a paper invoice (phone camera angle, may be skewed)
- A screenshot of an emailed invoice or quote
- A screenshot of a quote in Xero / MYOB / ServiceM8 / Tradify / similar
- An order confirmation, statement, or receipt
- A handwritten or printed delivery docket

DO NOT treat the document as "not an invoice" just because it's low quality, partially cropped, or visually unusual — quotes, statements, order confirmations, and screenshots are ALL valid here. Try harder before returning nulls.

EXTRACTION RULES:
1. SUPPLIER NAME: Look at logos, letterheads, "from" lines, footer info. If you see a brand mark only (logo) and no text supplier line, return that brand name.
2. ABN: Australian Business Number — 11 digits, often formatted "ABN 12 345 678 901" or in fine print at the top/bottom.
3. INVOICE NUMBER: Look for "Invoice #", "Inv No.", "Tax Invoice", "INV-", "Order #", "Quote #", "QT-", "Receipt #". Quotes (QT) and orders (SO/PO) are valid invoice_number values for our purposes.
4. DATES: AU format is DD/MM/YYYY. Convert to YYYY-MM-DD.
5. AMOUNTS: AUD by default. "Subtotal" or "Total ex GST" → subtotal_ex_gst. "GST" → gst_amount. "Total", "Total Due", "Total Inc GST", "Amount Due" → total_inc_gst. If only one total is shown and GST is not separated, set total_inc_gst to that value, leave gst_amount null.
6. LINE ITEMS: Each row of the items table. quantity defaults to 1 if not shown. Skip blank/header rows.
7. JOB REFERENCE: Look for the customer's job/site address in the subject area, "Site:", "Re:", "Job:", "Project:", or in the address block ("Ship to" / "Deliver to"). Capture the full address line if present.
8. CONFIDENCE:
   - "high" — clean printed invoice, all key fields readable
   - "medium" — image is OK but some fields hard to read
   - "low" — image is unclear OR document doesn't look like an invoice/quote/statement at all
9. DOCUMENT_KIND: Classify what this document actually is. One of:
   - "invoice"  — a tax invoice / bill from a supplier (the common case)
   - "quote"    — a quote / estimate (not yet a payable bill)
   - "receipt"  — a receipt for a payment already made
   - "statement"— a supplier statement of account (list of prior invoices)
   - "order"    — a purchase order / sales order / order confirmation
   - "logo"     — a brand logo / letterhead image only, no financial content
   - "photo"    — a photograph that is NOT a financial document (e.g. a photo of a
                  completed fence, a job site, a product, a person)
   - "ui_screenshot" — a screenshot of an app/email UI that is NOT itself an invoice
                  (e.g. a "Pay Now" button, an app icon, a navigation bar, an inbox)
   - "other"    — anything else that isn't a financial document
   Only "invoice", "quote", "receipt", "statement" and "order" are real financial
   documents. If the image is purely a logo, a photo, or a UI chrome screenshot,
   set document_kind accordingly and return confidence "low" with null amounts.

WHAT TO RETURN AS LOW CONFIDENCE WITH NULLS:
- Pure logos with no text below (e.g. "oxworks-logo.png")
- Email signature footer images
- Banner ads
- Random photos that aren't financial documents

WHAT TO TRY HARD ON (do NOT return all nulls just because it's a screenshot):
- A screenshot of a Xero/MYOB invoice → extract everything visible
- A photo of a paper invoice → extract everything visible
- A quote PDF → quote # → invoice_number, total → total_inc_gst
- A delivery docket → docket # → invoice_number, items → line_items, totals if present

Return ONLY a valid JSON object with this exact shape — no prose, no markdown fences:

{
  "supplier_name": "string or null",
  "supplier_abn": "11-digit string or null",
  "invoice_number": "string or null",
  "invoice_date": "YYYY-MM-DD or null",
  "due_date": "YYYY-MM-DD or null",
  "subtotal_ex_gst": number or null,
  "gst_amount": number or null,
  "total_inc_gst": number or null,
  "currency": "AUD",
  "line_items": [
    {"description": "string", "quantity": number, "unit_price": number, "total": number}
  ],
  "job_reference": "string or null — full address or job code if shown",
  "document_kind": "invoice" | "quote" | "receipt" | "statement" | "order" | "logo" | "photo" | "ui_screenshot" | "other",
  "confidence": "high" | "medium" | "low",
  "notes": "string — anything unusual or unclear; e.g. 'photo skewed', 'partial crop', 'screenshot of quote in Xero', 'document type: delivery docket'"
}`;

/**
 * What kind of document the model thinks this is. Only the first five
 * (invoice/quote/receipt/statement/order) are real financial documents that
 * belong on the bills/BAS surface. logo/photo/ui_screenshot/other are the
 * mis-filed noise (supplier logos, "Pay Now" buttons, photos of finished
 * fences, email-signature images) that pollute the bills list.
 */
export type DocumentKind =
  | 'invoice'
  | 'quote'
  | 'receipt'
  | 'statement'
  | 'order'
  | 'logo'
  | 'photo'
  | 'ui_screenshot'
  | 'other';

/** The kinds that are NOT a payable/recordable financial document. */
export const NON_FINANCIAL_KINDS: ReadonlySet<DocumentKind> = new Set<DocumentKind>([
  'logo',
  'photo',
  'ui_screenshot',
  'other',
]);

const VALID_DOCUMENT_KINDS: ReadonlySet<string> = new Set<DocumentKind>([
  'invoice',
  'quote',
  'receipt',
  'statement',
  'order',
  'logo',
  'photo',
  'ui_screenshot',
  'other',
]);

export interface ExtractedBill {
  supplier_name: string | null;
  supplier_abn: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  subtotal_ex_gst: number | null;
  gst_amount: number | null;
  total_inc_gst: number | null;
  currency: string;
  line_items: {
    description: string;
    quantity: number;
    unit_price: number;
    total: number;
  }[];
  job_reference: string | null;
  document_kind: DocumentKind;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
  // Internal: which path produced this. Set by bills-extract; not from the model.
  _extraction_method?: 'text' | 'vision' | 'hybrid';
  _extraction_meta?: {
    found?: string[];
    missing?: string[];
    confidence_score?: number;
    math_consistent?: boolean;
    page_count?: number;
  };
}

/**
 * Strip markdown fences and parse the JSON output from the model.
 * Different providers format slightly differently — this normalises.
 */
export function parseExtractedJson(raw: string): ExtractedBill {
  let text = raw.trim();
  // Strip ```json ... ``` fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // Some models wrap with explanatory prose; find the first { and last }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }
  // Models sometimes emit raw control characters (literal newlines/tabs) inside
  // string values — invalid JSON. Replace control chars with spaces before
  // parsing; structural whitespace between tokens is unaffected.
  let _clean = '';
  for (let _k = 0; _k < text.length; _k++) {
    const _c = text.charCodeAt(_k);
    _clean += _c < 32 ? ' ' : text[_k];
  }
  text = _clean;
  const parsed = JSON.parse(text) as ExtractedBill;
  // Defensive defaults
  parsed.line_items ??= [];
  parsed.currency ??= 'AUD';
  parsed.confidence ??= 'medium';
  parsed.notes ??= '';
  // document_kind: normalise to a known value. Missing/unknown → 'invoice', the
  // legacy assumption (everything was treated as a bill). The is_probable_bill
  // gate in persistExtraction still catches low-confidence empty extractions, so
  // a defaulted 'invoice' won't smuggle pure noise onto the active surface.
  parsed.document_kind = VALID_DOCUMENT_KINDS.has(parsed.document_kind as string)
    ? parsed.document_kind
    : 'invoice';
  return parsed;
}

export function imageMediaType(mime: string): string {
  if (mime.startsWith('image/')) return mime;
  return 'image/png';
}

/**
 * Per-provider request deadline for OCR fetches. A hung provider must not stall the
 * whole edge invocation until the wall-clock kill — instead the fetch aborts and the
 * caller's fallback loop moves to the next provider. Override with OCR_TIMEOUT_MS.
 */
export function ocrTimeoutSignal(): AbortSignal {
  // Read the override without a bare `Deno` reference so this module stays importable
  // from the Node/vitest typecheck (bills/router.ts pulls it in); the global is present
  // at runtime on the Deno edge runtime.
  const denoEnv = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } })
    .Deno?.env;
  const ms = Number(denoEnv?.get('OCR_TIMEOUT_MS'));
  return AbortSignal.timeout(Number.isFinite(ms) && ms > 0 ? ms : 45_000);
}
