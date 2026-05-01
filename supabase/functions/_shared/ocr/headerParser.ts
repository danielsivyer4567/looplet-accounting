/**
 * Header-field parser. Runs over plain text from a born-digital PDF and
 * pulls out the load-bearing fields (supplier, total, date, invoice #,
 * GST, subtotal, ABN, job reference) using regex + AU-conventions.
 *
 * NOT a layout-aware parser — line items in tables stay messy here. If
 * the header parse hits high confidence we skip vision; if not, vision
 * OCR runs and gets the full extraction including line items.
 */

import type { ExtractedBill } from './prompt.ts';

export interface HeaderParseResult {
  data: Partial<ExtractedBill>;
  confidence: number; // 0-1
  found: string[];
  missing: string[];
  mathConsistent: boolean;
}

// Match $1,234.56 / 1234 / 1,234.5 etc. Captures the numeric portion.
const MONEY = /\$?\s*([0-9]{1,3}(?:[,\s][0-9]{3})*(?:\.\d{1,2})?)\b/;

// Build label-then-money regex
function moneyAfter(label: string): RegExp {
  return new RegExp(`(?:${label})[:\\s]*` + MONEY.source, 'i');
}

const TOTAL_RE = moneyAfter('total\\s+(?:inc(?:l(?:usive)?)?\\s+(?:gst|of\\s+gst)|inc\\.?\\s+gst)|total\\s+amount(?:\\s+due)?|amount\\s+due|grand\\s+total|balance\\s+due|total');
const SUBTOTAL_RE = moneyAfter('sub[-\\s]?total|net\\s+(?:amount|total)|total\\s+ex(?:cl(?:uding|\\.?))?\\s+gst');
const GST_RE = moneyAfter('gst(?:\\s+amount)?|tax\\s+amount|tax\\s+\\(gst\\)|10%\\s+gst');
const ABN_RE = /\b(?:ABN[:\s]*)?(\d{2}\s?\d{3}\s?\d{3}\s?\d{3})\b/i;
const INVOICE_NO_RE =
  /\b(?:tax\s+invoice|invoice|inv)\s*(?:no\.?|number|#)?[:\s]*([A-Z0-9][A-Z0-9-]{2,19})\b/i;
const DATE_RE_GLOBAL =
  /\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{2,4})\b/gi;
const JOB_REF_RE =
  /\b(?:job\s*(?:no\.?|number|#|ref)?[:\s]*|jb[-\s]?|quote\s*(?:no\.?|#)?[:\s]*|qu[-\s]?)([A-Z0-9-]{2,12})\b/i;

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

function toCents(money: string | undefined): number | null {
  if (!money) return null;
  const cleaned = money.replace(/[,\s$]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normaliseDate(raw: string): string | null {
  // ISO YYYY-MM-DD
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return raw;

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY (AU convention)
  const dmy = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (dmy) {
    const d = (dmy[1] ?? '').padStart(2, '0');
    const m = (dmy[2] ?? '').padStart(2, '0');
    let y = dmy[3] ?? '';
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
    return `${y}-${m}-${d}`;
  }

  // 1 Jan 2026 / 1st January 2026
  const named = raw.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{2,4})$/);
  if (named) {
    const d = (named[1] ?? '').padStart(2, '0');
    const monthKey = (named[2] ?? '').slice(0, 3).toLowerCase();
    const m = MONTHS[monthKey];
    let y = named[3] ?? '';
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
    if (m) return `${y}-${m}-${d}`;
  }

  return null;
}

export function parseBillHeaders(fullText: string): HeaderParseResult {
  const data: Partial<ExtractedBill> = {
    line_items: [],
    currency: 'AUD',
    confidence: 'medium',
    notes: '',
  };
  const found: string[] = [];
  const missing: string[] = [];

  // Total
  const totalMatch = fullText.match(TOTAL_RE);
  const total = toCents(totalMatch?.[1]);
  if (total != null) {
    data.total_inc_gst = total;
    found.push('total');
  } else {
    missing.push('total');
  }

  // Subtotal
  const subMatch = fullText.match(SUBTOTAL_RE);
  const sub = toCents(subMatch?.[1]);
  if (sub != null) {
    data.subtotal_ex_gst = sub;
    found.push('subtotal');
  }

  // GST
  const gstMatch = fullText.match(GST_RE);
  const gst = toCents(gstMatch?.[1]);
  if (gst != null) {
    data.gst_amount = gst;
    found.push('gst');
  }

  // Invoice number
  const invMatch = fullText.match(INVOICE_NO_RE);
  if (invMatch?.[1]) {
    data.invoice_number = invMatch[1];
    found.push('invoice_number');
  } else {
    missing.push('invoice_number');
  }

  // ABN
  const abnMatch = fullText.match(ABN_RE);
  if (abnMatch?.[1]) {
    data.supplier_abn = abnMatch[1].replace(/\s/g, '');
    found.push('abn');
  }

  // Date — collect all, pick the earliest (usually invoice date; due dates are later)
  const dateMatches = Array.from(fullText.matchAll(DATE_RE_GLOBAL));
  const parsedDates = dateMatches
    .map((m) => normaliseDate(m[1] ?? ''))
    .filter((d): d is string => d !== null);
  if (parsedDates.length > 0) {
    parsedDates.sort();
    data.invoice_date = parsedDates[0] ?? null;
    if (parsedDates.length > 1) {
      // last date is usually the due date if it's after invoice date
      const last = parsedDates[parsedDates.length - 1];
      if (last && last !== parsedDates[0]) data.due_date = last;
    }
    found.push('date');
  } else {
    missing.push('date');
  }

  // Job reference
  const jobMatch = fullText.match(JOB_REF_RE);
  if (jobMatch?.[1]) {
    data.job_reference = jobMatch[1].replace(/\s/g, '-').toUpperCase();
    found.push('job_reference');
  }

  // Supplier name — heuristic: first text line of meaningful length that
  // isn't a banner word like "TAX INVOICE" / "INVOICE"
  const lines = fullText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const supplier = lines
    .slice(0, 20)
    .find(
      (l) =>
        l.length >= 4 &&
        l.length <= 80 &&
        !/^(tax\s+invoice|invoice|bill|receipt|date|due|abn|to:|bill\s+to|ship\s+to|page)/i.test(
          l,
        ) &&
        /[a-z]/i.test(l) &&
        !/^[\d\s.,$/-]+$/.test(l),
    );
  if (supplier) {
    data.supplier_name = supplier;
    found.push('supplier');
  } else {
    missing.push('supplier');
  }

  // Math consistency: subtotal + gst ≈ total (within 5 cents)
  let mathConsistent = true;
  if (data.subtotal_ex_gst != null && data.gst_amount != null && data.total_inc_gst != null) {
    const sum = data.subtotal_ex_gst + data.gst_amount;
    if (Math.abs(sum - data.total_inc_gst) > 0.05) {
      mathConsistent = false;
      data.notes =
        (data.notes ?? '') +
        ` (math mismatch in text extract: ${data.subtotal_ex_gst}+${data.gst_amount}≠${data.total_inc_gst})`;
    }
  }

  // Confidence:
  //   Required floor: supplier + total + date → 0.6
  //   Bonus: invoice_number 0.1, gst 0.1, subtotal 0.1, abn 0.05, math-consistent 0.05
  let confidence = 0;
  if (data.supplier_name && data.total_inc_gst != null && data.invoice_date) {
    confidence = 0.6;
    if (data.invoice_number) confidence += 0.1;
    if (data.gst_amount != null) confidence += 0.1;
    if (data.subtotal_ex_gst != null) confidence += 0.1;
    if (data.supplier_abn) confidence += 0.05;
    if (mathConsistent && data.subtotal_ex_gst != null && data.gst_amount != null) {
      confidence += 0.05;
    }
  }

  data.confidence = confidence >= 0.8 ? 'high' : confidence >= 0.5 ? 'medium' : 'low';

  return { data, confidence, found, missing, mathConsistent };
}
