// _shared/pdf/worksheet.ts — minimal label/value PDF renderer for tax worksheets.
//
// The shared PDF-generation helper (SC-3.D.01) reused across the accountant epic
// (BAS worksheet here; Phase 5 SC-5.D.01/5.F.01 statements). Pure: takes a
// structured WorksheetDoc and returns the PDF bytes — no I/O, no DB, no auth — so
// it is runtime-testable in isolation (deno test). Uses pdf-lib (pure JS, runs in
// the Deno edge runtime). Render text is kept to WinAnsi-safe ASCII (no em-dashes)
// so StandardFonts.Helvetica never hits an unencodable glyph.

import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "https://esm.sh/pdf-lib@1.17.1";

export interface WorksheetRow {
  /** The label/line item, e.g. "1A  GST on sales". */
  label: string;
  /** The pre-formatted value, e.g. "$1,234.00". */
  value: string;
}

export interface WorksheetSection {
  heading: string;
  /** Optional one-line source/drill-down note shown under the heading. */
  caption?: string;
  rows: WorksheetRow[];
}

export interface WorksheetDoc {
  title: string;
  subtitle?: string;
  sections: WorksheetSection[];
  /** Optional footer note (e.g. a draft/not-lodged disclaimer). */
  footer?: string;
}

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 50;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.4, 0.4, 0.45);

export async function renderWorksheetPdf(doc: WorksheetDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = pdf.addPage([A4_WIDTH, A4_HEIGHT]);
  let y = A4_HEIGHT - MARGIN;

  const newPageIfNeeded = (needed: number): void => {
    if (y - needed < MARGIN) {
      page = pdf.addPage([A4_WIDTH, A4_HEIGHT]);
      y = A4_HEIGHT - MARGIN;
    }
  };
  const left = (text: string, size: number, f: PDFFont, color = INK): void => {
    page.drawText(text, { x: MARGIN, y, size, font: f, color });
  };
  const rightValue = (text: string, size: number): void => {
    const w = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: A4_WIDTH - MARGIN - w, y, size, font, color: INK });
  };

  // Title block
  left(doc.title, 18, bold);
  y -= 24;
  if (doc.subtitle) {
    left(doc.subtitle, 11, font, MUTED);
    y -= 20;
  }
  y -= 8;

  for (const section of doc.sections) {
    newPageIfNeeded(40);
    left(section.heading, 13, bold);
    y -= 17;
    if (section.caption) {
      left(section.caption, 9, font, MUTED);
      y -= 14;
    }
    for (const row of section.rows) {
      newPageIfNeeded(16);
      page.drawText(row.label, { x: MARGIN + 12, y, size: 11, font, color: INK });
      rightValue(row.value, 11);
      y -= 16;
    }
    y -= 12;
  }

  if (doc.footer) {
    newPageIfNeeded(16);
    left(doc.footer, 8, font, MUTED);
  }

  return await pdf.save();
}
