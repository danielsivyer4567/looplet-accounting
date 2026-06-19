/**
 * Provider-agnostic OCR layer. Port of Loopletnumero `services/ocr/index.ts`.
 * Selects adapter via `OCR_PROVIDER` env (groq | openai | kimi | anthropic).
 */

import { extractBillDataGroq } from './groq.ts';
import { extractBillDataOpenAI } from './openai.ts';
import { extractBillDataAnthropic } from './anthropic.ts';
import { extractBillDataMiniMax } from './minimax.ts';
import type { ExtractedBill } from './prompt.ts';

export type OCRProvider = 'minimax' | 'groq' | 'openai' | 'kimi' | 'anthropic';

// Providers that can read PDFs natively (vs image-only vision providers, which
// rely on the upstream born-digital text path for PDFs).
const PDF_CAPABLE: ReadonlySet<OCRProvider> = new Set(['anthropic']);

export function getActiveProvider(): OCRProvider {
  const raw = (Deno.env.get('OCR_PROVIDER') ?? '').toLowerCase().trim();
  if (
    raw === 'minimax' || raw === 'groq' || raw === 'openai' ||
    raw === 'kimi' || raw === 'anthropic'
  ) {
    return raw;
  }
  // Default precedence: MiniMax → Anthropic → OpenAI → Groq.
  if (Deno.env.get('MINIMAX_API_KEY')) return 'minimax';
  if (Deno.env.get('ANTHROPIC_API_KEY')) return 'anthropic';
  if (Deno.env.get('OPENAI_API_KEY')) return 'openai';
  if (Deno.env.get('GROQ_API_KEY')) return 'groq';
  return 'minimax';
}

export async function extractBillData(
  imageBytes: Uint8Array,
  mimeType: string,
): Promise<{ data: ExtractedBill; raw: string; provider: OCRProvider }> {
  const provider = getActiveProvider();

  // Claude reads PDFs natively (born-digital and scanned). MiniMax/groq/openai
  // vision are image-only, and Deno-edge can't easily rasterize
  // (poppler/pdfjs+canvas). For those providers, fall back to a graceful
  // "needs manual entry" result for image-based PDFs the text path gave up on.
  if (mimeType === 'application/pdf' && !PDF_CAPABLE.has(provider)) {
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
        notes: `Image-based PDF — text extraction failed and ${provider} vision can't read PDFs. Set ANTHROPIC_API_KEY / OCR_PROVIDER=anthropic to OCR PDFs, or enter fields manually.`,
      },
      raw: '{}',
      provider,
    };
  }

  let result: { data: ExtractedBill; raw: string };

  switch (provider) {
    case 'minimax':
      result = await extractBillDataMiniMax(imageBytes, mimeType);
      break;
    case 'anthropic':
      result = await extractBillDataAnthropic(imageBytes, mimeType);
      break;
    case 'groq':
      result = await extractBillDataGroq(imageBytes, mimeType);
      break;
    case 'openai':
      result = await extractBillDataOpenAI(imageBytes, mimeType);
      break;
    case 'kimi':
      throw new Error(`Provider 'kimi' adapter not yet ported. Use 'anthropic', 'openai', or 'groq'.`);
  }

  return { ...result, provider };
}

export type { ExtractedBill } from './prompt.ts';
