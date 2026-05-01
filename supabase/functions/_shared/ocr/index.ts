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
  // PDF → image conversion: deferred to v1.1.
  // Loopletnumero used poppler-utils via shell-out, not available in Deno edge fns.
  // Two paths under consideration: (a) pdfjs-dist + offscreen canvas in fn,
  // (b) browser-side conversion before upload. Track in roadmap Phase 3.1.
  if (mimeType === 'application/pdf') {
    throw new Error(
      'PDF conversion not yet supported in edge functions. Convert to PNG/JPG before upload, or wait for Phase 3.1.',
    );
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
