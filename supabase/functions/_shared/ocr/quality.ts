/**
 * Extraction-quality scoring and the verification gate.
 *
 * WHY THIS EXISTS
 * ---------------
 * The production audit found 7/247 bills had a captured amount, every GST was
 * null, and the mean confidence was ~0.41 — yet bills-extract marked EVERY bill
 * `verified` regardless of the OCR result (it flipped status to 'verified'
 * before OCR even ran). "Verified" is the books-quality signal the rest of the
 * app trusts, so a null-amount, low-confidence extraction must NOT earn it.
 *
 * This module is the single, pure (no I/O) source of truth for:
 *   1. PROVIDER_CONTRACT — the explicit contract every OCR adapter must satisfy.
 *   2. scoreExtraction()  — turn an ExtractedBill into a 0–1 quality score plus
 *                           the booleans the gate and the UI exception need.
 *   3. gateExtraction()   — decide pass | needs_review | rejected, the status a
 *                           bill earns from an extraction.
 *
 * Keeping it pure means it is unit-testable (the fixture accuracy gate imports
 * it directly) and it can be reused by bills-extract, the batch drainer, and
 * the BillDetail exception UI without dragging in Deno/Supabase.
 */

import type { ExtractedBill, DocumentKind } from './prompt.ts';
import { NON_FINANCIAL_KINDS } from './prompt.ts';

/**
 * THE PROVIDER CONTRACT.
 *
 * Every adapter under `_shared/ocr/<provider>.ts` is a function
 *   (fileBytes: Uint8Array, mimeType: string) => Promise<{ data: ExtractedBill; raw: string }>
 * and MUST honour all of the following. This is documented (not just implied)
 * so a new provider can be added without re-reverse-engineering the others, and
 * so the gate below can rely on these invariants.
 */
export interface OcrProviderContract {
  /** The provider's stable id, also written to bills.ocr_provider. */
  readonly id: string;
  /** True if the adapter can read application/pdf bytes directly (no rasterize). */
  readonly pdfCapable: boolean;
  /** Env var holding the API key; absence means the provider is unconfigured. */
  readonly apiKeyEnv: string;
}

/**
 * Declared capabilities of every shipped adapter. The router (index.ts) uses
 * `pdfCapable` to decide whether to rasterize a PDF first; the default-provider
 * precedence uses `apiKeyEnv` to pick the first configured provider.
 *
 * Robust default precedence (first with a key wins): MiniMax → Anthropic →
 * OpenAI → Groq. Anthropic is the most robust for the messy real-world inputs
 * (native PDF, structured-output schema) and is the recommended explicit
 * OCR_PROVIDER for this workload; MiniMax leads only because it is the cheapest
 * configured default. Set OCR_PROVIDER to override.
 */
export const PROVIDER_CONTRACTS: Readonly<Record<string, OcrProviderContract>> = {
  minimax: { id: 'minimax', pdfCapable: false, apiKeyEnv: 'MINIMAX_API_KEY' },
  anthropic: { id: 'anthropic', pdfCapable: true, apiKeyEnv: 'ANTHROPIC_API_KEY' },
  openai: { id: 'openai', pdfCapable: false, apiKeyEnv: 'OPENAI_API_KEY' },
  groq: { id: 'groq', pdfCapable: false, apiKeyEnv: 'GROQ_API_KEY' },
  kimi: { id: 'kimi', pdfCapable: false, apiKeyEnv: 'KIMI_API_KEY' },
};

/** Numeric confidence floor. Below this an extraction can never auto-verify. */
export const DEFAULT_CONFIDENCE_FLOOR = 0.6;

/** Map the model's coarse label to a numeric confidence. */
export function confidenceToScore(label: ExtractedBill['confidence']): number {
  switch (label) {
    case 'high':
      return 0.9;
    case 'medium':
      return 0.7;
    case 'low':
    default:
      return 0.4;
  }
}

export interface ExtractionQuality {
  /** 0–1 overall quality of the extraction. */
  score: number;
  /** Coarse confidence label carried through from the model. */
  confidence: ExtractedBill['confidence'];
  /** True when a usable GST-inclusive total was captured. */
  hasTotal: boolean;
  /** True when a supplier name was captured. */
  hasSupplier: boolean;
  /** True when subtotal+gst≈total (only checked when all three present). */
  mathConsistent: boolean;
  /** True when the document is a real financial doc (not logo/photo/etc). */
  isFinancial: boolean;
  /** Human-readable reasons the score was reduced — surfaced in the exception UI. */
  reasons: string[];
}

const FINANCIAL_KINDS: ReadonlySet<string> = new Set([
  'invoice',
  'quote',
  'receipt',
  'statement',
  'order',
]);

/**
 * Score a finished extraction. Pure: no env, no I/O.
 *
 * Scoring (additive, capped at the model's own confidence as a ceiling so a
 * "low"-confidence read can never present as high-quality just because the few
 * fields it returned happen to be present):
 *   total present      → +0.45   (load-bearing for the books / BAS)
 *   supplier present   → +0.20
 *   invoice_number     → +0.10
 *   invoice_date       → +0.10
 *   gst present        → +0.10
 *   math consistent    → +0.05
 */
export function scoreExtraction(extracted: ExtractedBill): ExtractionQuality {
  const reasons: string[] = [];

  const documentKind = (extracted.document_kind ?? 'invoice') as DocumentKind;
  const isFinancial =
    FINANCIAL_KINDS.has(documentKind) && !NON_FINANCIAL_KINDS.has(documentKind);

  const hasTotal = extracted.total_inc_gst != null && extracted.total_inc_gst > 0;
  const hasSupplier = !!extracted.supplier_name && extracted.supplier_name.trim().length > 0;
  const hasInvoiceNo = !!extracted.invoice_number && extracted.invoice_number.trim().length > 0;
  const hasDate = !!extracted.invoice_date;
  const hasGst = extracted.gst_amount != null;

  let mathConsistent = true;
  if (
    extracted.subtotal_ex_gst != null &&
    extracted.gst_amount != null &&
    extracted.total_inc_gst != null
  ) {
    const sum = extracted.subtotal_ex_gst + extracted.gst_amount;
    mathConsistent = Math.abs(sum - extracted.total_inc_gst) <= 0.05;
    if (!mathConsistent) {
      reasons.push(
        `Amounts do not add up (${extracted.subtotal_ex_gst} + ${extracted.gst_amount} ≠ ${extracted.total_inc_gst}).`,
      );
    }
  }

  let raw = 0;
  if (hasTotal) raw += 0.45;
  else reasons.push('No total amount was read from the document.');
  if (hasSupplier) raw += 0.2;
  else reasons.push('No supplier name was read from the document.');
  if (hasInvoiceNo) raw += 0.1;
  if (hasDate) raw += 0.1;
  if (hasGst) raw += 0.1;
  if (mathConsistent && extracted.gst_amount != null && extracted.subtotal_ex_gst != null) {
    raw += 0.05;
  }

  // The model's own confidence is the ceiling — a "low" read can't score high.
  const ceiling = confidenceToScore(extracted.confidence);
  const score = Math.min(raw, ceiling);

  if (!isFinancial) {
    reasons.push(`Document classified as "${documentKind}", not a financial document.`);
  }

  return {
    score,
    confidence: extracted.confidence,
    hasTotal,
    hasSupplier,
    mathConsistent,
    isFinancial,
    reasons,
  };
}

/**
 * The verification status an extraction earns. This is the heart of the fix:
 *
 *   - 'verified'      The books can trust it: a real financial document, a
 *                     usable total, confidence at/above the floor, math
 *                     consistent. ONLY this status may auto-advance the bill.
 *   - 'needs_review'  A probable-but-incomplete bill — a real invoice we could
 *                     not read fully (skewed photo, missing total/supplier,
 *                     below the confidence floor). Stays an EXCEPTION for a
 *                     human; must NOT be marked verified.
 *   - 'rejected'      Not a financial document at all (logo/photo/screenshot).
 *                     Kept off the active surface (is_probable_bill=false).
 */
export type ExtractionOutcome = 'verified' | 'needs_review' | 'rejected';

export interface GateResult {
  outcome: ExtractionOutcome;
  quality: ExtractionQuality;
  /** Convenience: outcome === 'verified'. The ONLY case that may set status='verified'. */
  verified: boolean;
}

/**
 * Decide the outcome from a finished extraction. `confidenceFloor` is wired to
 * OCR_CONFIDENCE_FLOOR by the caller so the gate can be tuned without a deploy.
 */
export function gateExtraction(
  extracted: ExtractedBill,
  confidenceFloor: number = DEFAULT_CONFIDENCE_FLOOR,
): GateResult {
  const quality = scoreExtraction(extracted);

  let outcome: ExtractionOutcome;
  if (!quality.isFinancial) {
    outcome = 'rejected';
  } else if (
    quality.hasTotal &&
    quality.mathConsistent &&
    quality.score >= confidenceFloor &&
    extracted.confidence !== 'low'
  ) {
    outcome = 'verified';
  } else {
    // Real-but-unreadable invoice → exception for manual review. Never verified.
    outcome = 'needs_review';
  }

  return { outcome, quality, verified: outcome === 'verified' };
}

/** Resolve the numeric confidence floor from env (falls back to the default). */
export function resolveConfidenceFloor(getEnv: (k: string) => string | undefined): number {
  const raw = getEnv('OCR_CONFIDENCE_FLOOR');
  if (!raw) return DEFAULT_CONFIDENCE_FLOOR;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_CONFIDENCE_FLOOR;
}
