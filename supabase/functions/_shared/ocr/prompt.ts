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
  "confidence": "high" | "medium" | "low",
  "notes": "string — anything unusual or unclear; e.g. 'photo skewed', 'partial crop', 'screenshot of quote in Xero', 'document type: delivery docket'"
}`;

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
  const parsed = JSON.parse(text) as ExtractedBill;
  // Defensive defaults
  parsed.line_items ??= [];
  parsed.currency ??= 'AUD';
  parsed.confidence ??= 'medium';
  parsed.notes ??= '';
  return parsed;
}

export function imageMediaType(mime: string): string {
  if (mime.startsWith('image/')) return mime;
  return 'image/png';
}
