export const allowedEventTypes = new Set(['sale', 'refund', 'void']);
export const allowedSources = new Set(['phone-pass', 'tag', 'pos', 'epost', 'email', 'photo', 'manual']);

const maxIdempotencyKeyLength = 160;
const maxSafeCents = Number.MAX_SAFE_INTEGER;
const maxLineQuantity = 999_999_999.999;

const finalTenderStatusesByEvent = {
  sale: new Set(['completed', 'paid', 'succeeded', 'approved']),
  refund: new Set(['completed', 'refunded', 'succeeded', 'approved']),
  void: new Set(['completed', 'voided', 'cancelled', 'canceled']),
};

export function buildWebhookBody(receipt, config) {
  const payload = clonePayload(receipt.payload ?? receipt);
  const eventType = receiptEventType(receipt, payload);
  const sourceChannel = receiptSource(receipt.source_channel ?? 'pos');
  const idempotencyKey = stableIdempotencyKey(receipt, payload, eventType);
  const errors = validateReceiptContract(receipt);
  if (errors.length > 0) {
    throw new Error(`receipt contract invalid: ${errors.join('; ')}`);
  }

  payload.receipt = { ...payload.receipt, event_type: eventType };
  payload.receipt.purchase_at = normalizePurchaseAt(payload.receipt.purchase_at);
  const paymentLast4 = normalizePaymentLast4(payload.receipt.payment_last4);
  if (paymentLast4 == null) {
    delete payload.receipt.payment_last4;
  } else {
    payload.receipt.payment_last4 = paymentLast4;
  }
  const identityToken = resolveReceiptIdentityToken(receipt, payload, config);
  delete payload.receipt.identity_token;
  if (payload.customer && typeof payload.customer === 'object' && !Array.isArray(payload.customer)) {
    delete payload.customer.looplet_identity_token;
  }

  return {
    identity_token: identityToken,
    idempotency_key: idempotencyKey,
    event_type: eventType,
    source_channel: sourceChannel,
    payload,
    sync_targets: config.syncTargets,
  };
}

export function validateReceiptContract(receipt) {
  const errors = [];
  const payload = receipt?.payload ?? receipt;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['receipt payload must be an object'];
  }

  let eventType = 'sale';
  try {
    eventType = receiptEventType(receipt, payload);
  } catch (error) {
    errors.push(error.message);
  }

  try {
    receiptSource(receipt.source_channel ?? 'pos');
  } catch (error) {
    errors.push(error.message);
  }

  try {
    stableIdempotencyKey(receipt, payload, eventType);
  } catch (error) {
    errors.push(error.message);
  }

  const merchantName = asText(payload.merchant?.name);
  if (!merchantName || merchantName.length < 2) errors.push('payload.merchant.name is required');

  const receiptBody = payload.receipt;
  if (!receiptBody || typeof receiptBody !== 'object' || Array.isArray(receiptBody)) {
    errors.push('payload.receipt is required');
    return errors;
  }

  const totalCents = asCents(receiptBody.total_inc_gst_cents);
  if (totalCents == null || totalCents < 0 || (eventType !== 'void' && totalCents === 0)) {
    errors.push(eventType === 'void'
      ? 'payload.receipt.total_inc_gst_cents must be zero or greater'
      : 'payload.receipt.total_inc_gst_cents must be greater than zero');
  }

  const tenderStatus = asText(receiptBody.tender_status);
  if (!tenderStatus) {
    errors.push('payload.receipt.tender_status is required for POS bridge sends');
  } else if (!finalTenderStatusesByEvent[eventType]?.has(tenderStatus.toLowerCase())) {
    errors.push('payload.receipt.tender_status must be final for event_type');
  }

  if (!asText(receiptBody.payment_reference)) {
    errors.push('payload.receipt.payment_reference is required for POS bridge sends');
  }

  for (const value of [
    receipt.identity_token,
    receiptBody.identity_token,
    payload.customer?.looplet_identity_token,
  ]) {
    if (asText(value) && !isReceiptIdentityToken(value)) {
      errors.push('receipt identity_token must look like rhp_<prefix>.<secret>');
    }
  }

  try {
    normalizePurchaseAt(receiptBody.purchase_at);
  } catch (error) {
    errors.push(error.message);
  }

  try {
    normalizePaymentLast4(receiptBody.payment_last4);
  } catch (error) {
    errors.push(error.message);
  }

  if (eventType !== 'sale' && !asText(receiptBody.original_receipt_number) && !asText(receiptBody.original_external_event_id)) {
    errors.push('refund/void events need original_receipt_number or original_external_event_id');
  }

  const suppliedGst = asCents(receiptBody.gst_cents);
  const suppliedSubtotal = asCents(receiptBody.subtotal_ex_gst_cents);
  if (suppliedGst == null || suppliedSubtotal == null) {
    errors.push('payload.receipt.gst_cents and subtotal_ex_gst_cents are required');
  }
  if (totalCents != null && suppliedGst != null && suppliedSubtotal != null && Math.abs(suppliedGst + suppliedSubtotal - totalCents) > 1) {
    errors.push('payload receipt subtotal + GST must match total');
  }

  const lines = payload.line_items;
  if (!Array.isArray(lines) || lines.length === 0) {
    errors.push('payload.line_items must contain at least one itemised POS line');
  } else if (lines.length > 100) {
    errors.push('payload.line_items must contain 100 rows or fewer');
  } else if (totalCents != null) {
    let sum = 0;
    let gstSum = 0;
    for (const [index, line] of lines.entries()) {
      const quantity = asQuantity(line.quantity);
      if (hasValue(line.quantity) && quantity == null) {
        errors.push(`payload.line_items[${index}].quantity must be between 0 and ${maxLineQuantity} with no more than 3 decimal places`);
      }

      const unitPrice = asCents(line.unit_price_cents);
      if (hasValue(line.unit_price_cents) && unitPrice == null) {
        errors.push(`payload.line_items[${index}].unit_price_cents must be whole safe cents`);
      } else if (unitPrice != null && unitPrice < 0) {
        errors.push(`payload.line_items[${index}].unit_price_cents must be zero or greater`);
      }

      const explicitLineTotal = asCents(line.total_inc_gst_cents);
      if (hasValue(line.total_inc_gst_cents) && explicitLineTotal == null) {
        errors.push(`payload.line_items[${index}].total_inc_gst_cents must be whole safe cents`);
      }
      const derivedLineTotal = quantity != null && unitPrice != null ? Math.round(quantity * unitPrice) : null;
      const lineTotal = explicitLineTotal ?? derivedLineTotal;
      if (lineTotal == null) {
        errors.push(`payload.line_items[${index}].total_inc_gst_cents is required`);
        continue;
      }
      if (!Number.isSafeInteger(lineTotal) || lineTotal < 0) {
        errors.push(`payload.line_items[${index}].total_inc_gst_cents must be safe cents zero or greater`);
        continue;
      }
      sum += lineTotal;
      if (!Number.isSafeInteger(sum)) {
        errors.push('payload.line_items total exceeds safe integer cents');
      }

      const lineGst = asCents(line.gst_cents);
      if (hasValue(line.gst_cents) && lineGst == null) {
        errors.push(`payload.line_items[${index}].gst_cents must be whole safe cents`);
      } else if (lineGst == null) {
        errors.push(`payload.line_items[${index}].gst_cents is required`);
      } else if (lineGst < 0 || lineGst > lineTotal) {
        errors.push(`payload.line_items[${index}].gst_cents must be between zero and line total`);
      } else {
        gstSum += lineGst;
      }
    }
    if (Math.abs(sum - totalCents) > 1) {
      errors.push('payload.line_items totals must match receipt total');
    }
    if (suppliedGst != null && Math.abs(gstSum - suppliedGst) > 1) {
      errors.push('payload.line_items GST totals must match receipt GST');
    }
  }

  return errors;
}

export function stableIdempotencyKey(receipt, payload, eventType) {
  const explicit =
    asText(receipt.idempotency_key) ??
    asText(receipt.external_event_id) ??
    asText(payload.receipt?.external_event_id) ??
    asText(payload.receipt?.external_id);
  if (explicit) {
    if (explicit.length > maxIdempotencyKeyLength) {
      throw new Error(`idempotency_key must be ${maxIdempotencyKeyLength} characters or fewer`);
    }
    return explicit;
  }

  const merchant = asText(payload.merchant?.name);
  const number = asText(payload.receipt?.number);
  if (merchant && number) {
    const prefix = eventType === 'sale' ? '' : `${eventType}:`;
    return `${prefix}${merchant}:${number}`.toLowerCase();
  }
  throw new Error('receipt needs idempotency_key, external_event_id, or merchant + receipt number');
}

export function receiptEventType(receipt, payload) {
  const eventType = (asText(receipt.event_type) ?? asText(payload.receipt?.event_type) ?? 'sale').toLowerCase();
  if (allowedEventTypes.has(eventType)) return eventType;
  throw new Error(`unsupported receipt event_type ${eventType}`);
}

export function receiptSource(value) {
  const source = (asText(value) ?? 'pos').toLowerCase();
  if (allowedSources.has(source)) return source;
  throw new Error(`unsupported receipt source_channel ${source}`);
}

function clonePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  return {
    ...payload,
    merchant: payload.merchant && typeof payload.merchant === 'object' ? { ...payload.merchant } : payload.merchant,
    receipt: payload.receipt && typeof payload.receipt === 'object' ? { ...payload.receipt } : payload.receipt,
    classification: payload.classification && typeof payload.classification === 'object'
      ? { ...payload.classification }
      : payload.classification,
    line_items: Array.isArray(payload.line_items) ? payload.line_items.map((line) => ({ ...line })) : payload.line_items,
  };
}

function asText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizePaymentLast4(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error('payload.receipt.payment_last4 must be text containing only the final four card digits');
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (/^\d{4}$/.test(trimmed)) return trimmed;
  if (/^[*xX.\-\s]+[0-9]{4}$/.test(trimmed) && digits.length === 4) return digits;
  if (digits.length > 4) throw new Error('payload.receipt.payment_last4 must not contain a full card number');
  throw new Error('payload.receipt.payment_last4 must contain exactly the final four card digits');
}

function resolveReceiptIdentityToken(receipt, payload, config = {}) {
  const token =
    asText(receipt.identity_token) ??
    asText(payload.receipt?.identity_token) ??
    asText(payload.customer?.looplet_identity_token) ??
    asText(config.identityToken);
  if (!token) {
    throw new Error(
      'receipt identity_token is required; include the scanned Looplet identity per receipt or configure LOOPLET_RECEIPT_IDENTITY_TOKEN as a fallback',
    );
  }
  if (!isReceiptIdentityToken(token)) {
    throw new Error('receipt identity_token must look like rhp_<prefix>.<secret>');
  }
  return token;
}

function isReceiptIdentityToken(value) {
  return typeof value === 'string' && /^rhp_[^.]+\..+/.test(value.trim());
}

function normalizePurchaseAt(value) {
  const text = asText(value);
  if (!text) throw new Error('payload.receipt.purchase_at is required for POS bridge sends');
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error('payload.receipt.purchase_at must be a valid date-time');
  }
  return date.toISOString();
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asCents(value) {
  const n = asNumber(value);
  return n != null && Number.isSafeInteger(n) ? n : null;
}

function asQuantity(value) {
  if (!hasValue(value)) return null;
  const n = asNumber(value);
  if (n == null || n < 0 || n > maxLineQuantity) return null;
  const scaled = n * 1000;
  return Math.abs(scaled - Math.round(scaled)) < 1e-9 ? n : null;
}

function hasValue(value) {
  return value != null && !(typeof value === 'string' && value.trim() === '');
}
