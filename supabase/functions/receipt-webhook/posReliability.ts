export type ReceiptSource = 'phone-pass' | 'tag' | 'pos' | 'epost' | 'email' | 'photo' | 'manual';
export type ReceiptEventType = 'sale' | 'refund' | 'void';

export interface ReceiptLineForReliability {
  quantity?: unknown;
  unit_price_cents?: unknown;
  total_inc_gst_cents?: unknown;
  gst_cents?: unknown;
}

export interface ReceiptPayloadForReliability {
  merchant?: {
    name?: unknown;
  };
  receipt?: {
    number?: unknown;
    idempotency_key?: unknown;
    external_id?: unknown;
    external_event_id?: unknown;
    event_type?: unknown;
    original_receipt_number?: unknown;
    original_external_event_id?: unknown;
    purchase_at?: unknown;
    payment_last4?: unknown;
    payment_reference?: unknown;
    tender_status?: unknown;
  };
  external_event_id?: unknown;
  line_items?: ReceiptLineForReliability[];
}

export interface IdempotencyInput {
  headerValue: string | null;
  bodyValue?: unknown;
  payload: ReceiptPayloadForReliability;
  merchantName: string;
  receiptNumber: string | null;
  eventType?: ReceiptEventType;
}

/**
 * How the receipt's GST was established, stored as receipt_audit_packages.gst_status:
 * - supplied: the receipt shows GST (or a subtotal, so GST is total minus subtotal);
 * - none: the receipt shows no GST, or the merchant is not registered for GST, so there is no credit;
 * - review: the receipt does not show GST. GST stays unknown and no credit is recorded.
 */
export type ReceiptGstStatus = 'supplied' | 'none' | 'review';

export interface ReceiptTaxBreakdown {
  subtotalCents: number | null;
  gstCents: number | null;
  gstStatus: ReceiptGstStatus;
}

export class ReceiptValidationError extends Error {}

const encoder = new TextEncoder();
const MAX_RECEIPT_PAYLOAD_BYTES = 128_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 160;
const MAX_RECEIPT_LINE_ITEMS = 100;
const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;
const MAX_LINE_QUANTITY = 999_999_999.999;
const ALLOWED_SOURCES = new Set<ReceiptSource>([
  'phone-pass',
  'tag',
  'pos',
  'epost',
  'email',
  'photo',
  'manual',
]);
const ALLOWED_EVENT_TYPES = new Set<ReceiptEventType>(['sale', 'refund', 'void']);
const FINAL_TENDER_STATUSES_BY_EVENT: Record<ReceiptEventType, Set<string>> = {
  sale: new Set(['completed', 'paid', 'succeeded', 'approved']),
  refund: new Set(['completed', 'refunded', 'succeeded', 'approved']),
  void: new Set(['completed', 'voided', 'cancelled', 'canceled']),
};

export function assertReceiptPayloadSize(payload: unknown, contentLength: string | null): void {
  const declaredBytes = parsePositiveInteger(contentLength);
  if (declaredBytes != null && declaredBytes > MAX_RECEIPT_PAYLOAD_BYTES) {
    throw new ReceiptValidationError('receipt payload is too large');
  }
  const actualBytes = encoder.encode(JSON.stringify(payload)).byteLength;
  if (actualBytes > MAX_RECEIPT_PAYLOAD_BYTES) {
    throw new ReceiptValidationError('receipt payload is too large');
  }
}

export function parseReceiptSource(value: unknown): ReceiptSource {
  if (value == null) return 'pos';
  if (typeof value === 'string' && ALLOWED_SOURCES.has(value as ReceiptSource)) {
    return value as ReceiptSource;
  }
  throw new ReceiptValidationError('source_channel is unsupported');
}

export function parseReceiptEventType(value: unknown): ReceiptEventType {
  if (value == null) return 'sale';
  if (typeof value === 'string' && ALLOWED_EVENT_TYPES.has(value as ReceiptEventType)) {
    return value as ReceiptEventType;
  }
  throw new ReceiptValidationError('receipt.event_type is unsupported');
}

export function assertReceiptTenderIsFinal(
  eventType: ReceiptEventType,
  tenderStatus: unknown,
  options: { required?: boolean } = {},
): void {
  const status = asText(tenderStatus);
  if (!status) {
    if (options.required) {
      throw new ReceiptValidationError('receipt.tender_status is required for POS receipt ingestion');
    }
    return;
  }
  if (FINAL_TENDER_STATUSES_BY_EVENT[eventType].has(status.toLowerCase())) return;
  throw new ReceiptValidationError('receipt tender must be final before webhook ingestion');
}

export function assertReceiptPaymentReferencePresent(
  paymentReference: unknown,
  options: { required?: boolean } = {},
): void {
  if (!options.required || asText(paymentReference)) return;
  throw new ReceiptValidationError('receipt.payment_reference required for POS receipt ingestion');
}

export function normalizeReceiptPaymentLast4(paymentLast4: unknown): string | null {
  if (paymentLast4 == null || paymentLast4 === '') return null;
  if (typeof paymentLast4 !== 'string') {
    throw new ReceiptValidationError('receipt.payment_last4 must be text containing only the final four card digits');
  }
  const trimmed = paymentLast4.trim();
  if (!trimmed) return null;

  const digits = trimmed.replace(/\D/g, '');
  if (/^\d{4}$/.test(trimmed)) return trimmed;
  if (/^[*xX.\-\s]+[0-9]{4}$/.test(trimmed) && digits.length === 4) return digits;

  if (digits.length > 4) {
    throw new ReceiptValidationError('receipt.payment_last4 must not contain a full card number');
  }
  throw new ReceiptValidationError('receipt.payment_last4 must contain exactly the final four card digits');
}

export function normalizeReceiptPurchaseAt(
  purchaseAt: unknown,
  options: { required?: boolean } = {},
): string | null {
  const text = asText(purchaseAt);
  if (!text) {
    if (options.required) {
      throw new ReceiptValidationError('receipt.purchase_at required for POS receipt ingestion');
    }
    return null;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new ReceiptValidationError('receipt.purchase_at must be a valid date-time');
  }
  return date.toISOString();
}

export function buildReceiptIdempotencyKey(input: IdempotencyInput): string | null {
  const explicit =
    asText(input.headerValue) ??
    asText(input.bodyValue) ??
    asText(input.payload.receipt?.idempotency_key) ??
    asText(input.payload.receipt?.external_event_id) ??
    asText(input.payload.receipt?.external_id) ??
    asText(input.payload.external_event_id);

  if (explicit) {
    if (explicit.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new ReceiptValidationError('idempotency_key is too long');
    }
    return `explicit:${explicit}`;
  }

  if (!input.receiptNumber) return null;
  const eventPrefix = input.eventType && input.eventType !== 'sale' ? `${input.eventType}:` : '';
  return `receipt:${eventPrefix}${normalizeKeyPart(input.merchantName)}:${normalizeKeyPart(input.receiptNumber)}`;
}

export function assertReceiptIdempotencySourcesConsistent(
  headerValue: string | null,
  bodyValue: unknown,
  payload: ReceiptPayloadForReliability,
): void {
  const explicitSources = [
    { label: 'Idempotency-Key header', value: asText(headerValue) },
    { label: 'body idempotency_key', value: asText(bodyValue) },
    { label: 'payload.receipt.idempotency_key', value: asText(payload.receipt?.idempotency_key) },
  ].filter((source): source is { label: string; value: string } => source.value != null);

  const first = explicitSources[0];
  if (!first) return;

  const mismatch = explicitSources.find((source) => source.value !== first.value);
  if (!mismatch) return;

  throw new ReceiptValidationError(
    `${mismatch.label} must match ${first.label} when both are supplied`,
  );
}

export function assertReceiptIsRetrySafe(idempotencyKey: string | null): asserts idempotencyKey is string {
  if (!idempotencyKey) {
    throw new ReceiptValidationError('receipt.number or idempotency_key required');
  }
}

/**
 * Reads the receipt's GST without inventing any. A total on its own does not show GST: the sale may
 * be GST-free or the merchant may not be registered for GST, so GST is left unknown for review
 * rather than assumed to be 1/11. You can't claim a GST credit for purchases with no GST in the
 * price, including from a supplier that is not registered for GST:
 * https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/claiming-gst-credits/when-you-cannot-claim-a-gst-credit
 */
export function normalizeReceiptTaxBreakdown(
  totalCents: number,
  suppliedGstValue: unknown,
  suppliedSubtotalValue: unknown,
  options: { requireBothSupplied?: boolean; merchantGstRegistered?: boolean | null } = {},
): ReceiptTaxBreakdown {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new ReceiptValidationError('receipt.total_inc_gst_cents must be whole cents');
  }
  if (!Number.isSafeInteger(totalCents) || totalCents > MAX_SAFE_CENTS) {
    throw new ReceiptValidationError('receipt.total_inc_gst_cents exceeds safe integer cents');
  }
  const suppliedGst = asCents(suppliedGstValue);
  const suppliedSubtotal = asCents(suppliedSubtotalValue);

  if (options.requireBothSupplied && (suppliedGst == null || suppliedSubtotal == null)) {
    throw new ReceiptValidationError(
      'receipt.gst_cents and receipt.subtotal_ex_gst_cents required for POS receipt ingestion',
    );
  }
  if (suppliedGst != null && (suppliedGst < 0 || suppliedGst > totalCents)) {
    throw new ReceiptValidationError('receipt.gst_cents must be between zero and receipt.total_inc_gst_cents');
  }
  if (suppliedSubtotal != null && (suppliedSubtotal < 0 || suppliedSubtotal > totalCents)) {
    throw new ReceiptValidationError(
      'receipt.subtotal_ex_gst_cents must be between zero and receipt.total_inc_gst_cents',
    );
  }
  if (
    suppliedGst != null &&
    suppliedSubtotal != null &&
    Math.abs(suppliedGst + suppliedSubtotal - totalCents) > 1
  ) {
    throw new ReceiptValidationError('receipt subtotal + GST must match receipt.total_inc_gst_cents');
  }

  if (options.merchantGstRegistered === false) {
    // A merchant that is not registered for GST can't charge it, so there is no credit to claim.
    if (suppliedGst != null && suppliedGst > 0) {
      throw new ReceiptValidationError(
        'receipt.gst_cents must be 0 when merchant.gst_registered is false',
      );
    }
    return { subtotalCents: totalCents, gstCents: 0, gstStatus: 'none' };
  }

  if (suppliedGst != null) {
    return {
      subtotalCents: suppliedSubtotal ?? totalCents - suppliedGst,
      gstCents: suppliedGst,
      gstStatus: suppliedGst === 0 ? 'none' : 'supplied',
    };
  }
  if (suppliedSubtotal != null) {
    const gstCents = totalCents - suppliedSubtotal;
    return { subtotalCents: suppliedSubtotal, gstCents, gstStatus: gstCents === 0 ? 'none' : 'supplied' };
  }
  // Neither GST nor subtotal on the receipt: GST is unknown. Do not assume 1/11.
  return { subtotalCents: null, gstCents: null, gstStatus: 'review' };
}

export function assertReceiptOriginalReferencePresent(
  eventType: ReceiptEventType,
  originalReceiptNumber: unknown,
  originalExternalEventId: unknown,
  options: { required?: boolean } = {},
): void {
  if (!options.required || eventType === 'sale') return;
  if (asText(originalReceiptNumber) || asText(originalExternalEventId)) return;
  throw new ReceiptValidationError('refund/void receipts require original_receipt_number or original_external_event_id');
}

export function assertReceiptOriginalReferenceResolved(
  eventType: ReceiptEventType,
  relatedReceiptFound: boolean,
  options: { required?: boolean } = {},
): void {
  if (!options.required || eventType === 'sale') return;
  if (relatedReceiptFound) return;
  throw new ReceiptValidationError('refund/void receipts must reference an existing original sale receipt');
}

export function assertReceiptLinesReliable(
  lines: ReceiptLineForReliability[] | undefined,
  totalCents: number,
  options: { requireItemised?: boolean; requireLineGst?: boolean; expectedGstCents?: number } = {},
): void {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new ReceiptValidationError('receipt.total_inc_gst_cents must be whole cents');
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    if (options.requireItemised) {
      throw new ReceiptValidationError('line_items must contain at least one itemised POS line');
    }
    return;
  }
  if (lines.length > MAX_RECEIPT_LINE_ITEMS) {
    throw new ReceiptValidationError(`line_items must contain ${MAX_RECEIPT_LINE_ITEMS} rows or fewer`);
  }

  let sum = 0;
  let gstSum = 0;
  let allLinesHaveGst = true;
  for (const [index, line] of lines.entries()) {
    const quantity = asQuantity(line.quantity);
    if (hasValue(line.quantity) && quantity == null) {
      throw new ReceiptValidationError(
        `line_items[${index}].quantity must be between 0 and ${MAX_LINE_QUANTITY} with no more than 3 decimal places`,
      );
    }

    const unitPrice = asCents(line.unit_price_cents);
    if (hasValue(line.unit_price_cents) && unitPrice == null) {
      throw new ReceiptValidationError(`line_items[${index}].unit_price_cents must be whole safe cents`);
    }
    if (unitPrice != null && unitPrice < 0) {
      throw new ReceiptValidationError(`line_items[${index}].unit_price_cents must be zero or greater`);
    }

    const explicitLineTotal = asCents(line.total_inc_gst_cents);
    if (hasValue(line.total_inc_gst_cents) && explicitLineTotal == null) {
      throw new ReceiptValidationError(`line_items[${index}].total_inc_gst_cents must be whole safe cents`);
    }
    const derivedLineTotal = quantity != null && unitPrice != null ? Math.round(quantity * unitPrice) : null;
    const lineTotal = explicitLineTotal ?? derivedLineTotal;
    if (lineTotal == null) {
      throw new ReceiptValidationError(`line_items[${index}].total_inc_gst_cents required`);
    }
    if (!Number.isSafeInteger(lineTotal) || lineTotal < 0) {
      throw new ReceiptValidationError(`line_items[${index}].total_inc_gst_cents must be safe cents zero or greater`);
    }
    sum += lineTotal;
    if (!Number.isSafeInteger(sum)) {
      throw new ReceiptValidationError('line_items total exceeds safe integer cents');
    }

    const lineGst = asCents(line.gst_cents);
    if (hasValue(line.gst_cents) && lineGst == null) {
      throw new ReceiptValidationError(`line_items[${index}].gst_cents must be whole safe cents`);
    }
    if (lineGst == null) {
      allLinesHaveGst = false;
      if (options.requireLineGst) {
        throw new ReceiptValidationError(`line_items[${index}].gst_cents required for POS receipt ingestion`);
      }
    } else {
      if (lineGst < 0 || lineGst > lineTotal) {
        throw new ReceiptValidationError(`line_items[${index}].gst_cents must be between zero and line total`);
      }
      gstSum += lineGst;
    }
  }

  if (Math.abs(sum - totalCents) > 1) {
    throw new ReceiptValidationError('line_items total must match receipt.total_inc_gst_cents');
  }
  if (
    options.expectedGstCents != null &&
    (options.requireLineGst || allLinesHaveGst) &&
    Math.abs(gstSum - options.expectedGstCents) > 1
  ) {
    throw new ReceiptValidationError('line_items GST total must match receipt.gst_cents');
  }
}

export function isUniqueViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === '23505' || (error?.message ?? '').toLowerCase().includes('duplicate key');
}

export function isLoopletApiKeyAuthorization(authHeader: string | null): boolean {
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  return token.startsWith('llp_');
}

function parsePositiveInteger(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function normalizeKeyPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asCents(value: unknown): number | null {
  const n = asNumber(value);
  return n != null && Number.isSafeInteger(n) ? n : null;
}

function asQuantity(value: unknown): number | null {
  if (!hasValue(value)) return null;
  const n = asNumber(value);
  if (n == null || n < 0 || n > MAX_LINE_QUANTITY) return null;
  const scaled = n * 1000;
  return Math.abs(scaled - Math.round(scaled)) < 1e-9 ? n : null;
}

function hasValue(value: unknown): boolean {
  return value != null && !(typeof value === 'string' && value.trim() === '');
}
