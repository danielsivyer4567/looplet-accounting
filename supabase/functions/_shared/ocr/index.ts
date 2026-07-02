/**
 * Provider-agnostic OCR layer. Port of Loopletnumero `services/ocr/index.ts`.
 * Selects adapter via `OCR_PROVIDER` env (minimax | anthropic | openai | groq).
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

/** Whether a provider has its API key configured. 'kimi' is unimplemented → never a candidate. */
function providerHasKey(p: OCRProvider): boolean {
  switch (p) {
    case 'minimax':
      return !!Deno.env.get('MINIMAX_API_KEY');
    case 'anthropic':
      return !!Deno.env.get('ANTHROPIC_API_KEY');
    case 'openai':
      return !!Deno.env.get('OPENAI_API_KEY');
    case 'groq':
      return !!Deno.env.get('GROQ_API_KEY');
    case 'kimi':
      return false;
  }
}

/**
 * Ordered fallback list: the configured/active provider first, then every OTHER
 * provider whose key is set (default precedence). Keyless providers are excluded up
 * front so a transient failure on one falls through to the next configured one rather
 * than failing the whole extraction. Empty only when NO provider is configured.
 */
function buildProviderCandidates(): OCRProvider[] {
  const precedence: OCRProvider[] = ['minimax', 'anthropic', 'openai', 'groq'];
  const seen = new Set<OCRProvider>();
  const out: OCRProvider[] = [];
  for (const p of [getActiveProvider(), ...precedence]) {
    if (seen.has(p) || !providerHasKey(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function callProvider(
  provider: OCRProvider,
  bytes: Uint8Array,
  mime: string,
): Promise<{ data: ExtractedBill; raw: string }> {
  switch (provider) {
    case 'minimax':
      return extractBillDataMiniMax(bytes, mime);
    case 'anthropic':
      return extractBillDataAnthropic(bytes, mime);
    case 'groq':
      return extractBillDataGroq(bytes, mime);
    case 'openai':
      return extractBillDataOpenAI(bytes, mime);
    case 'kimi':
      throw new Error("Provider 'kimi' adapter not yet ported.");
  }
}

/** Graceful degrade: a valid low-confidence result so the bill is still created for manual entry. */
function manualEntryStub(
  provider: OCRProvider,
  notes: string,
): { data: ExtractedBill; raw: string; provider: OCRProvider } {
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
      notes,
    },
    raw: '{}',
    provider,
  };
}

export async function extractBillData(
  imageBytes: Uint8Array,
  mimeType: string,
): Promise<{ data: ExtractedBill; raw: string; provider: OCRProvider }> {
  const candidates = buildProviderCandidates();
  if (candidates.length === 0) {
    // No provider configured at all — still create the bill for manual entry.
    return manualEntryStub('minimax', 'No OCR provider configured. Please enter fields manually from the file preview.');
  }

  const isPdf = mimeType === 'application/pdf';

  // Rasterize the PDF at most once, lazily, and share the rendered pages across
  // every image-only candidate (Anthropic reads PDFs natively and skips this).
  let rasterizedPages: Uint8Array[] | null = null;
  let rasterizeError: string | null = null;
  async function getRasterizedPages(): Promise<Uint8Array[] | null> {
    if (rasterizedPages || rasterizeError) return rasterizedPages;
    try {
      const { rasterizePdfToPng } = await import('./pdfRasterize.ts');
      // Render up to 5 pages: supplier is usually on page 1, totals/GST on the last.
      const pages = await rasterizePdfToPng(imageBytes, { maxPages: 5, dpi: 200 });
      if (pages.length === 0 || !pages[0]) throw new Error('no pages rendered');
      rasterizedPages = pages;
      return pages;
    } catch (err) {
      rasterizeError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  const errors: string[] = [];
  for (const provider of candidates) {
    try {
      if (isPdf && !PDF_CAPABLE.has(provider)) {
        // Image-only provider on a PDF: needs rasterized pages.
        const pages = await getRasterizedPages();
        if (!pages) {
          errors.push(`${provider}: rasterize failed (${rasterizeError})`);
          continue;
        }
        // MiniMax takes all pages in one request; the model call sits OUTSIDE the
        // rasterize try/catch so a model failure falls through to the next provider
        // instead of being mislabelled as a rasterization failure.
        if (provider === 'minimax') {
          const result = await extractBillDataMiniMax(pages, 'image/png');
          return { ...result, provider };
        }
        // Single-image providers get the last page (most likely to carry totals).
        const lastPage = pages[pages.length - 1];
        if (!lastPage) {
          errors.push(`${provider}: no rasterized page available`);
          continue;
        }
        const result = await callProvider(provider, lastPage, 'image/png');
        return { ...result, provider };
      }
      // Non-PDF input, or a PDF-capable provider that reads the original bytes.
      const result = await callProvider(provider, imageBytes, mimeType);
      return { ...result, provider };
    } catch (err) {
      errors.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
      // fall through to the next candidate
    }
  }

  // Every candidate failed. If this was a PDF we could not rasterize (and no
  // PDF-capable provider succeeded), degrade to the manual-entry stub so the bill
  // is still recorded; otherwise surface the aggregated provider errors.
  if (isPdf && rasterizeError) {
    return manualEntryStub(
      candidates[0] ?? 'minimax',
      `Could not rasterize PDF for OCR (${rasterizeError}). Please enter fields manually from the file preview.`,
    );
  }
  throw new Error(`all OCR providers failed: ${errors.join('; ')}`);
}

export type { ExtractedBill } from './prompt.ts';
