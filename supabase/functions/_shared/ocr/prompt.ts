/**
 * Bill extraction prompt — provider-agnostic. Used by all OCR adapters.
 * Ported from Loopletnumero's `backend/src/services/ocr/prompt.ts`.
 */

export const EXTRACT_PROMPT = `You are extracting structured data from a supplier invoice or receipt for an Australian trades business. Return ONLY a valid JSON object with this exact shape:

{
  "supplier_name": "string or null",
  "supplier_abn": "11-digit string or null",
  "invoice_number": "string or null",
  "invoice_date": "YYYY-MM-DD or null",
  "due_date": "YYYY-MM-DD or null",
  "subtotal_ex_gst": number or null,
  "gst_amount": number or null,
  "total_inc_gst": number or null,
  "currency": "AUD" or other,
  "line_items": [
    {"description": "string", "quantity": number, "unit_price": number, "total": number}
  ],
  "job_reference": "string or null - look for JB-XXX, Job #, Quote #, PO #",
  "confidence": "high" | "medium" | "low",
  "notes": "string - anything unusual or unclear"
}

Return ONLY the JSON. No prose, no markdown fences.`;

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
  line_items: Array<{
    description: string;
    quantity: number;
    unit_price: number;
    total: number;
  }>;
  job_reference: string | null;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
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
