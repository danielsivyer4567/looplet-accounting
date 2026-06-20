/**
 * PDF → image rasterization for image-only vision providers (MiniMax, groq,
 * openai). Lets us OCR ANY PDF — born-digital or scanned — by rendering the
 * visual page to a PNG and feeding that to the vision adapter.
 *
 * Uses MuPDF.js (Artifex's official WebAssembly build). Pure WASM, so it runs
 * in the Supabase Edge (Deno) runtime — no poppler/canvas/native deps. This is
 * what the old "Deno-edge can't rasterize" comments were missing.
 *
 * Renders at 200 DPI by default (good legibility for invoice text vs. file
 * size — MiniMax caps images at 10 MB). First page only by default: supplier
 * invoices put supplier/total/GST on page 1; bump maxPages if needed.
 */

// @ts-expect-error -- npm: import lacks TS resolution in Deno editor tooling (no node_modules)
import * as mupdf from 'npm:mupdf@1.27.0';

export interface RasterizeOptions {
  maxPages?: number; // default 1
  dpi?: number; // default 200
}

export async function rasterizePdfToPng(
  bytes: Uint8Array,
  opts: RasterizeOptions = {},
): Promise<Uint8Array[]> {
  const maxPages = Math.max(1, opts.maxPages ?? 1);
  const scale = (opts.dpi ?? 200) / 72;

  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    const total = doc.countPages();
    const n = Math.min(total, maxPages);
    const pages: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      try {
        // alpha=false → opaque white background (vision reads documents better).
        const pix = page.toPixmap(
          mupdf.Matrix.scale(scale, scale),
          mupdf.ColorSpace.DeviceRGB,
          false,
        );
        try {
          pages.push(pix.asPNG());
        } finally {
          pix.destroy();
        }
      } finally {
        page.destroy();
      }
    }
    return pages;
  } finally {
    doc.destroy();
  }
}
