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

  // Bytes/mime actually sent to the vision model. Image-only providers
  // (MiniMax/groq/openai) can't read PDFs, so we rasterize the PDF's first
  // page to a PNG and OCR that — works for born-digital AND scanned PDFs.
  // Anthropic reads PDFs natively, so it gets the original bytes.
  let ocrBytes = imageBytes;
  let ocrMime = mimeType;

  if (mimeType === 'application/pdf' && !PDF_CAPABLE.has(provider)) {
    try {
      const { rasterizePdfToPng } = await import('./pdfRasterize.ts');
      // Render up to 5 pages: supplier is usually on page 1, totals/GST on the
      // last page of a multi-page invoice.
      const pages = await rasterizePdfToPng(imageBytes, { maxPages: 5, dpi: 200 });
      if (pages.length === 0 || !pages[0]) throw new Error('no pages rendered');
      // MiniMax takes all pages in one request; single-image providers get the
      // last page (most likely to carry the totals).
      if (provider === 'minimax') {
        const result = await extractBillDataMiniMax(pages, 'image/png');
        return { ...result, provider };
      }
      ocrBytes = pages[pages.length - 1]!;
      ocrMime = 'image/png';
    } catch (err) {
      // Corrupt/encrypted PDF or rasterizer failure → graceful manual-entry stub.
      const msg = err instanceof Error ? err.message : String(err);
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
          document_kind: 'invoice',
          confidence: 'low',
          notes: `Could not rasterize PDF for OCR (${msg}). Please enter fields manually from the file preview.`,
        },
        raw: '{}',
        provider,
      };
    }
  }

  let result: { data: ExtractedBill; raw: string };

  switch (provider) {
    case 'minimax':
      result = await extractBillDataMiniMax(ocrBytes, ocrMime);
      break;
    case 'anthropic':
      result = await extractBillDataAnthropic(ocrBytes, ocrMime);
      break;
    case 'groq':
      result = await extractBillDataGroq(ocrBytes, ocrMime);
      break;
    case 'openai':
      result = await extractBillDataOpenAI(ocrBytes, ocrMime);
      break;
    case 'kimi':
      throw new Error(`Provider 'kimi' adapter not yet ported. Use 'anthropic', 'openai', or 'groq'.`);
  }

  return { ...result, provider };
}

export type { ExtractedBill } from './prompt.ts';
