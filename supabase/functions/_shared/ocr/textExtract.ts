/**
 * Text extraction from born-digital PDFs.
 *
 * Uses `unpdf` (Deno-friendly pdfjs-dist wrapper, no worker/canvas
 * polyfills needed in edge functions). For PDFs with a real text layer
 * this is ~100ms and free. For scanned/image PDFs the text layer is
 * empty/garbage — the caller falls back to vision OCR.
 */

// @ts-expect-error -- npm: imports lack TS resolution in Deno editor tooling
import { extractText } from 'npm:unpdf@0.12.1';

export interface TextExtraction {
  fullText: string;
  byteLength: number;
  pageCount: number;
  empty: boolean;
}

const MIN_USEFUL_CHARS = 80; // below this, treat as scanned PDF / no text layer

export async function extractTextFromPdf(bytes: Uint8Array): Promise<TextExtraction> {
  try {
    const { text, totalPages } = (await extractText(bytes, { mergePages: true })) as {
      text: string;
      totalPages: number;
    };
    const trimmed = (text ?? '').trim();
    return {
      fullText: trimmed,
      byteLength: bytes.length,
      pageCount: totalPages ?? 1,
      empty: trimmed.length < MIN_USEFUL_CHARS,
    };
  } catch (err) {
    // unpdf throws on corrupt or password-protected PDFs — treat as empty
    // so caller falls back to vision.
    return {
      fullText: '',
      byteLength: bytes.length,
      pageCount: 0,
      empty: true,
    };
  }
}
