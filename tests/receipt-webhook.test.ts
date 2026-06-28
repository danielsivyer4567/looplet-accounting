import { describe, it, expect } from 'vitest';
import {
  ReceiptValidationError,
  buildReceiptIdempotencyKey,
  normalizeReceiptTaxBreakdown,
  parseReceiptSource,
  parseReceiptEventType,
} from '../supabase/functions/receipt-webhook/posReliability';

/**
 * Pure-logic unit tests for the receipt-webhook ingest pipeline (SC-11).
 *
 * Covers the branches the ledger calls out — GST estimation (AU 1/11 when not
 * supplied), supplied-GST reconciliation, dedupe key derivation (explicit vs
 * merchant+receipt#), and source/event parsing — by importing the function
 * module directly (it has no Deno/remote imports, so vitest resolves it). The
 * DB-touching ingest path is exercised separately by the live SC-13 ride; the
 * generic_api sync adapter has its own deno test (genericApi.test.ts).
 */

describe('normalizeReceiptTaxBreakdown — GST estimation', () => {
  it('estimates GST as 1/11 of the inclusive total when neither GST nor subtotal supplied', () => {
    const r = normalizeReceiptTaxBreakdown(11000, undefined, undefined);
    expect(r.gstCents).toBe(1000); // round(11000/11)
    expect(r.subtotalCents).toBe(10000);
    expect(r.gstEstimated).toBe(true);
  });

  it('uses supplied GST verbatim and is not flagged estimated', () => {
    const r = normalizeReceiptTaxBreakdown(11000, 1000, 10000);
    expect(r.gstCents).toBe(1000);
    expect(r.subtotalCents).toBe(10000);
    expect(r.gstEstimated).toBe(false);
  });

  it('derives GST from a supplied subtotal (GST-free supply → 0)', () => {
    const r = normalizeReceiptTaxBreakdown(10000, undefined, 10000);
    expect(r.gstCents).toBe(0);
    expect(r.gstEstimated).toBe(false);
  });

  it('rejects a subtotal+GST that does not reconcile to the total', () => {
    expect(() => normalizeReceiptTaxBreakdown(11000, 1000, 9000)).toThrow(ReceiptValidationError);
  });

  it('rejects GST greater than the total', () => {
    expect(() => normalizeReceiptTaxBreakdown(1000, 2000, undefined)).toThrow(ReceiptValidationError);
  });

  it('POS ingestion requires both GST and subtotal supplied', () => {
    expect(() =>
      normalizeReceiptTaxBreakdown(11000, undefined, undefined, { requireBothSupplied: true }),
    ).toThrow(ReceiptValidationError);
    // both supplied → fine
    expect(
      normalizeReceiptTaxBreakdown(11000, 1000, 10000, { requireBothSupplied: true }).gstEstimated,
    ).toBe(false);
  });
});

describe('buildReceiptIdempotencyKey — dedupe', () => {
  const payload = { receipt: {} };

  it('prefers an explicit header key', () => {
    const key = buildReceiptIdempotencyKey({
      headerValue: 'abc',
      bodyValue: null,
      payload,
      merchantName: 'Bunnings',
      receiptNumber: 'R-1',
      eventType: 'sale',
    });
    expect(key).toBe('explicit:abc');
  });

  it('derives a stable key from merchant + receipt number when no explicit key', () => {
    const args = {
      headerValue: null,
      bodyValue: null,
      payload,
      merchantName: 'Bunnings Trade',
      receiptNumber: 'RH-42',
      eventType: 'sale' as const,
    };
    const a = buildReceiptIdempotencyKey(args);
    const b = buildReceiptIdempotencyKey(args);
    expect(a).toBe(b); // deterministic → dedupe works
    expect(a).toContain('receipt:');
  });

  it('namespaces refund/void keys so they do not collide with the sale', () => {
    const base = {
      headerValue: null,
      bodyValue: null,
      payload,
      merchantName: 'Bunnings',
      receiptNumber: 'R-9',
    };
    const sale = buildReceiptIdempotencyKey({ ...base, eventType: 'sale' });
    const refund = buildReceiptIdempotencyKey({ ...base, eventType: 'refund' });
    expect(sale).not.toBe(refund);
    expect(refund).toContain('refund:');
  });

  it('returns null when there is nothing to key on', () => {
    expect(
      buildReceiptIdempotencyKey({
        headerValue: null,
        bodyValue: null,
        payload,
        merchantName: 'X',
        receiptNumber: null,
        eventType: 'sale',
      }),
    ).toBeNull();
  });
});

describe('source / event parsing', () => {
  it('accepts the receipt-hub channels including epost and photo', () => {
    expect(parseReceiptSource('epost')).toBe('epost');
    expect(parseReceiptSource('photo')).toBe('photo');
    expect(parseReceiptSource('pos')).toBe('pos');
  });

  it('defaults a missing source to pos but rejects an unknown channel', () => {
    expect(parseReceiptSource(undefined)).toBe('pos');
    expect(parseReceiptSource(null)).toBe('pos');
    expect(() => parseReceiptSource('not-a-channel')).toThrow(ReceiptValidationError);
  });

  it('parses event types and rejects junk', () => {
    expect(parseReceiptEventType('refund')).toBe('refund');
    expect(() => parseReceiptEventType('explode')).toThrow();
  });
});
