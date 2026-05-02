/**
 * Provider-agnostic OCR layer. Port of Loopletnumero `services/ocr/index.ts`.
 * Selects adapter via `OCR_PROVIDER` env (groq | openai | kimi | anthropic).
 */

import { extractBillDataGroq } from './groq.ts';
import { extractBillDataOpenAI } from './openai.ts';
import type { ExtractedBill } from './prompt.ts';

export type OCRProvider = 'groq' | 'openai' | 'kimi' | 'anthropic';

export function getActiveProvider(): OCRProvider {
  const raw = (Deno.env.get('OCR_PROVIDER') ?? '').toLowerCase().trim();
  if (raw === 'groq' || raw === 'openai' || raw === 'kimi' || raw === 'anthropic') {
    return raw;
  }
  if (Deno.env.get('GROQ_API_KEY')) return 'groq';
  if (Deno.env.get('OPENAI_API_KEY')) return 'openai';
  return 'groq';
}

export async function extractBillData(
  imageBytes: Uint8Array,
  mimeType: string,
): Promise<{ data: ExtractedBill; raw: string; provider: OCRProvider }> {
  // Image-based PDFs (scanned, photo-of-paper) need rasterization for vision OCR.
  // Deno-edge can't easily run poppler/pdfjs+canvas. Until that lands we
  // return a graceful "needs manual entry" result so the caller can mark
  // the bill verified-with-low-confidence rather than hard-failing.
  if (mimeType === 'application/pdf') {
    return {
      data: {
        supplier_name: null,
        supplier_abn: null,
        invoice_number: null,
        invoice_date: null,
        due_date: null,
        subtotal_ex_gst: null,
        gst_amount: null,
        total_inc_gst: null,
        currency: 'AUD',
        line_items: [],
        job_reference: null,
        confidence: 'low',
        notes: 'Image-based PDF — text extraction failed and vision OCR for PDFs is pending. Please enter fields manually from the file preview.',
      },
      raw: '{}',
      provider: 'groq',
    };
  }

  const provider = getActiveProvider();
  let result: { data: ExtractedBill; raw: string };

  switch (provider) {
    case 'groq':
      result = await extractBillDataGroq(imageBytes, mimeType);
      break;
    case 'openai':
      result = await extractBillDataOpenAI(imageBytes, mimeType);
      break;
    case 'kimi':
    case 'anthropic':
      throw new Error(
        `Provider '${provider}' adapter not yet ported. Use 'groq' or 'openai' for v1.`,
      );
  }

  return { ...result, provider };
}

export type { ExtractedBill } from './prompt.ts';
