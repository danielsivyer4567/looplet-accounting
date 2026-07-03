/**
 * Extract structural metadata from PDFs and images BEFORE running OCR.
 *
 * PDFs carry the Title/Author/Subject/Keywords/Creator/Producer fields —
 * accounting platforms (Xero, MYOB, QuickBooks) embed the supplier name and
 * sometimes the invoice number in these. Free signal we should mine.
 *
 * Images carry EXIF (JPEG/HEIC/TIFF) + tEXt chunks (PNG) + XMP. These often
 * have:
 *   - GPS coordinates → match the bill to a known job site by address
 *   - DateTimeOriginal → real invoice date for paper-photo invoices
 *   - Software / Make / Model → distinguish "screenshot" from "phone photo"
 *   - ImageDescription / UserComment → sometimes contains the supplier name
 *     when the user typed a description in their phone camera app
 *
 * Returns a structured object the OCR pipeline can use to PRE-FILL fields
 * before sending the file to Groq/Claude — saving cost and improving accuracy.
 */

import { getDocumentProxy } from 'https://esm.sh/unpdf@0.11.0';

export interface DocumentMetadata {
  source_type: 'pdf' | 'image' | 'unknown';
  // Common
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  description?: string;
  software_creator?: string;
  // Dates
  created_at?: string;
  modified_at?: string;
  taken_at?: string; // EXIF DateTimeOriginal
  // Image-specific
  camera_make?: string;
  camera_model?: string;
  gps_latitude?: number;
  gps_longitude?: number;
  // Heuristic flags
  looks_like_screenshot?: boolean;
  looks_like_phone_photo?: boolean;
  // Hints we extracted that the OCR can use
  candidate_supplier?: string;
  candidate_invoice_number?: string;
  // Raw — kept for audit
  raw?: Record<string, unknown>;
}

/** Parse an EXIF date value to ISO, returning undefined (never throwing) on a malformed value. */
function toIsoOrUndefined(value: unknown): string | undefined {
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const PDF_TITLE_INVOICE_PATTERNS = [
  /^Invoice\s+(?:#|No\.?\s*|INV[\s:#]*)?(\d{3,12})\s*[-–—]\s*(.+)$/i,  // "Invoice #1234 - ACME Pty Ltd"
  /^(Tax\s+)?Invoice\s+(\d{3,12})$/i,                                    // "Invoice 1234"
  /^([A-Z][\w\s&'.-]{2,60})\s+Invoice\s+(\d{3,12})/i,                    // "ACME Invoice 1234"
];

export async function extractDocumentMetadata(
  bytes: Uint8Array,
  mimeType: string,
): Promise<DocumentMetadata> {
  if (mimeType === 'application/pdf') {
    return await extractPdfMetadata(bytes);
  }
  if (mimeType.startsWith('image/')) {
    return await extractImageMetadata(bytes, mimeType);
  }
  return { source_type: 'unknown' };
}

async function extractPdfMetadata(bytes: Uint8Array): Promise<DocumentMetadata> {
  const out: DocumentMetadata = { source_type: 'pdf' };
  try {
    const doc = await getDocumentProxy(bytes);
    const meta = await doc.getMetadata();
    const info = (meta.info ?? {}) as Record<string, unknown>;

    if (info.Title) out.title = String(info.Title).trim();
    if (info.Author) out.author = String(info.Author).trim();
    if (info.Subject) out.subject = String(info.Subject).trim();
    if (info.Keywords) {
      out.keywords = String(info.Keywords).split(/[,;]\s*/).filter(Boolean);
    }
    if (info.Creator) out.software_creator = String(info.Creator).trim();
    if (info.Producer && !out.software_creator) out.software_creator = String(info.Producer).trim();
    if (info.CreationDate) out.created_at = parsePdfDate(String(info.CreationDate));
    if (info.ModDate) out.modified_at = parsePdfDate(String(info.ModDate));

    // Mine the title for supplier + invoice number patterns
    if (out.title) {
      for (const re of PDF_TITLE_INVOICE_PATTERNS) {
        const m = out.title.match(re);
        if (m) {
          if (m[1] && /^\d/.test(m[1])) {
            out.candidate_invoice_number = m[1];
            if (m[2]) out.candidate_supplier = m[2].trim();
          } else if (m[2]) {
            out.candidate_invoice_number = m[2];
            if (m[1]) out.candidate_supplier = m[1].trim();
          }
          break;
        }
      }
    }
    // Author often contains the supplier name verbatim
    if (!out.candidate_supplier && out.author && out.author.length > 2 && out.author.length < 80) {
      out.candidate_supplier = out.author;
    }

    out.raw = info;
  } catch (e) {
    out.raw = { error: e instanceof Error ? e.message : String(e) };
  }
  return out;
}

async function extractImageMetadata(
  bytes: Uint8Array,
  mimeType: string,
): Promise<DocumentMetadata> {
  const out: DocumentMetadata = { source_type: 'image' };
  try {
    // exifr handles JPEG/HEIC/TIFF EXIF + XMP. PNG tEXt isn't covered.
    const exifr = (await import('https://esm.sh/exifr@7.1.3')).default;
    const data = (await exifr.parse(bytes, {
      tiff: true, exif: true, gps: true, xmp: true, iptc: true,
      icc: false, jfif: false,
    })) as Record<string, unknown> | null;

    if (data) {
      if (data.ImageDescription) out.description = String(data.ImageDescription);
      if (data.UserComment) out.description = (out.description ?? '') + ' ' + String(data.UserComment);
      if (data.Software) out.software_creator = String(data.Software);
      if (data.Make) out.camera_make = String(data.Make);
      if (data.Model) out.camera_model = String(data.Model);
      // A malformed EXIF date ('0000:00:00 00:00:00' is a common camera/scanner
      // artifact) makes new Date(...).toISOString() throw, which would discard ALL
      // other already-parsed metadata via the outer catch. Guard each conversion.
      if (data.DateTimeOriginal) out.taken_at = toIsoOrUndefined(data.DateTimeOriginal) ?? out.taken_at;
      if (data.CreateDate) out.created_at = toIsoOrUndefined(data.CreateDate) ?? out.created_at;
      if (data.ModifyDate) out.modified_at = toIsoOrUndefined(data.ModifyDate) ?? out.modified_at;
      if (typeof data.latitude === 'number') out.gps_latitude = data.latitude;
      if (typeof data.longitude === 'number') out.gps_longitude = data.longitude;
      if (data.title) out.title = String(data.title);
      if (data.subject && !out.subject) out.subject = Array.isArray(data.subject) ? data.subject.join(', ') : String(data.subject);

      out.raw = data;
    }

    // Heuristic: screenshot vs phone photo
    const sw = (out.software_creator ?? '').toLowerCase();
    if (sw.includes('snipping') || sw.includes('screenshot') || sw.includes('lightshot')
        || sw.includes('greenshot') || sw.includes('windows') || sw.includes('mac os')) {
      out.looks_like_screenshot = true;
    } else if (out.camera_make || out.camera_model) {
      out.looks_like_phone_photo = true;
    }
  } catch (e) {
    out.raw = { error: e instanceof Error ? e.message : String(e), mime: mimeType };
  }
  return out;
}

/**
 * Parse PDF date format: D:YYYYMMDDHHmmSS+ZZ'00'
 *   "D:20250502143027+10'00'" → "2025-05-02T14:30:27+10:00"
 */
function parsePdfDate(s: string): string | undefined {
  const m = s.match(/^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return undefined;
  const [, y, mo, d, h = '00', mi = '00', se = '00'] = m;
  try {
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}Z`).toISOString();
  } catch { return undefined; }
}
