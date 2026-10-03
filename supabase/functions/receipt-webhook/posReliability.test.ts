import {
  assert,
  assertEquals,
  assertThrows,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  assertReceiptIsRetrySafe,
  assertReceiptIdempotencySourcesConsistent,
  assertReceiptLinesReliable,
  assertReceiptOriginalReferencePresent,
  assertReceiptOriginalReferenceResolved,
  assertReceiptPaymentReferencePresent,
  assertReceiptPayloadSize,
  assertReceiptTenderIsFinal,
  buildReceiptIdempotencyKey,
  isLoopletApiKeyAuthorization,
  isUniqueViolation,
  normalizeReceiptTaxBreakdown,
  normalizeReceiptPaymentLast4,
  normalizeReceiptPurchaseAt,
  parseReceiptEventType,
  parseReceiptSource,
  ReceiptValidationError,
} from './posReliability.ts';

Deno.test('POS idempotency prefers explicit keys and canonicalises receipt fallback', () => {
  assertEquals(
    buildReceiptIdempotencyKey({
      headerValue: 'pos-terminal-123',
      payload: { receipt: { number: 'RH-001' } },
      merchantName: 'Bunnings Trade',
      receiptNumber: 'RH-001',
    }),
    'explicit:pos-terminal-123',
  );

  assertEquals(
    buildReceiptIdempotencyKey({
      headerValue: null,
      bodyValue: '',
      payload: { receipt: { number: 'RH-001' } },
      merchantName: ' Bunnings   Trade ',
      receiptNumber: ' RH-001 ',
    }),
    'receipt:bunnings trade:rh-001',
  );

  assertEquals(
    buildReceiptIdempotencyKey({
      headerValue: null,
      payload: { receipt: { number: 'RH-001' } },
      merchantName: 'Bunnings Trade',
      receiptNumber: 'RH-001',
      eventType: 'refund',
    }),
    'receipt:refund:bunnings trade:rh-001',
  );
});

Deno.test('POS idempotency rejects receipts without any retry key', () => {
  const key = buildReceiptIdempotencyKey({
    headerValue: null,
    payload: { receipt: {} },
    merchantName: 'Bunnings Trade',
    receiptNumber: null,
  });

  assertEquals(key, null);
  assertThrows(() => assertReceiptIsRetrySafe(key), ReceiptValidationError);
});

Deno.test('POS idempotency rejects conflicting explicit retry sources', () => {
  assertReceiptIdempotencySourcesConsistent(
    'pos-terminal-123',
    'pos-terminal-123',
    { receipt: { idempotency_key: 'pos-terminal-123' } },
  );
  assertReceiptIdempotencySourcesConsistent(null, 'pos-terminal-123', { receipt: {} });
  assertReceiptIdempotencySourcesConsistent(
    'pos-terminal-123',
    'pos-terminal-123',
    { receipt: { external_event_id: 'different-vendor-event-id' } },
  );

  assertThrows(
    () => assertReceiptIdempotencySourcesConsistent(
      'pos-terminal-123',
      'pos-terminal-456',
      { receipt: {} },
    ),
    ReceiptValidationError,
  );
  assertThrows(
    () => assertReceiptIdempotencySourcesConsistent(
      null,
      'pos-terminal-123',
      { receipt: { idempotency_key: 'pos-terminal-456' } },
    ),
    ReceiptValidationError,
  );
});

Deno.test('POS source channel is validated before reaching database constraints', () => {
  assertEquals(parseReceiptSource(undefined), 'pos');
  assertEquals(parseReceiptSource('phone-pass'), 'phone-pass');
  assertThrows(() => parseReceiptSource('bad-pos'), ReceiptValidationError);
});

Deno.test('POS event type and tender status must be final', () => {
  assertEquals(parseReceiptEventType(undefined), 'sale');
  assertEquals(parseReceiptEventType('refund'), 'refund');
  assertEquals(parseReceiptEventType('void'), 'void');
  assertThrows(() => parseReceiptEventType('authorisation'), ReceiptValidationError);

  assertReceiptTenderIsFinal('sale', 'completed');
  assertReceiptTenderIsFinal('refund', 'refunded');
  assertReceiptTenderIsFinal('void', 'voided');
  assertReceiptTenderIsFinal('sale', undefined);
  assertThrows(() => assertReceiptTenderIsFinal('sale', 'pending'), ReceiptValidationError);
  assertThrows(() => assertReceiptTenderIsFinal('refund', 'authorised'), ReceiptValidationError);
  assertThrows(
    () => assertReceiptTenderIsFinal('sale', undefined, { required: true }),
    ReceiptValidationError,
  );
});

Deno.test('POS payment reference is required when POS ingestion demands payment traceability', () => {
  assertReceiptPaymentReferencePresent('eftpos-auth-777331', { required: true });
  assertReceiptPaymentReferencePresent(undefined);

  assertThrows(
    () => assertReceiptPaymentReferencePresent(undefined, { required: true }),
    ReceiptValidationError,
  );
  assertThrows(
    () => assertReceiptPaymentReferencePresent(' ', { required: true }),
    ReceiptValidationError,
  );
});

Deno.test('POS payment last4 rejects full card numbers and normalizes masked values', () => {
  assertEquals(normalizeReceiptPaymentLast4(undefined), null);
  assertEquals(normalizeReceiptPaymentLast4('1234'), '1234');
  assertEquals(normalizeReceiptPaymentLast4('**** **** **** 1234'), '1234');
  assertEquals(normalizeReceiptPaymentLast4('XXXX-1234'), '1234');

  assertThrows(
    () => normalizeReceiptPaymentLast4('4111111111111234'),
    ReceiptValidationError,
  );
  assertThrows(
    () => normalizeReceiptPaymentLast4('123'),
    ReceiptValidationError,
  );
  assertThrows(
    () => normalizeReceiptPaymentLast4(1234),
    ReceiptValidationError,
  );
});

Deno.test('POS purchase_at is required and normalized when POS ingestion demands sale timing', () => {
  assertEquals(
    normalizeReceiptPurchaseAt('2026-06-28T13:15:00+10:00', { required: true }),
    '2026-06-28T03:15:00.000Z',
  );
  assertEquals(normalizeReceiptPurchaseAt(undefined), null);

  assertThrows(
    () => normalizeReceiptPurchaseAt(undefined, { required: true }),
    ReceiptValidationError,
  );
  assertThrows(
    () => normalizeReceiptPurchaseAt('not-a-date', { required: true }),
    ReceiptValidationError,
  );
  assertThrows(
    () => normalizeReceiptPurchaseAt(1_782_619_200_000, { required: true }),
    ReceiptValidationError,
  );
});

Deno.test('POS refund and void receipts must carry an original sale reference when required', () => {
  assertReceiptOriginalReferencePresent('sale', undefined, undefined, { required: true });
  assertReceiptOriginalReferencePresent('refund', 'POS-2026-0001', undefined, { required: true });
  assertReceiptOriginalReferencePresent('void', undefined, 'payment-evt-100042', { required: true });
  assertReceiptOriginalReferencePresent('refund', undefined, undefined);

  assertThrows(
    () => assertReceiptOriginalReferencePresent('refund', undefined, undefined, { required: true }),
    ReceiptValidationError,
  );
  assertThrows(
    () => assertReceiptOriginalReferencePresent('void', ' ', '', { required: true }),
    ReceiptValidationError,
  );
});

Deno.test('POS refund and void receipts must resolve the original sale reference when required', () => {
  assertReceiptOriginalReferenceResolved('sale', false, { required: true });
  assertReceiptOriginalReferenceResolved('refund', true, { required: true });
  assertReceiptOriginalReferenceResolved('void', true, { required: true });
  assertReceiptOriginalReferenceResolved('refund', false);

  assertThrows(
    () => assertReceiptOriginalReferenceResolved('refund', false, { required: true }),
    ReceiptValidationError,
  );
  assertThrows(
    () => assertReceiptOriginalReferenceResolved('void', false, { required: true }),
    ReceiptValidationError,
  );
});

Deno.test('POS payload size and line totals are bounded', () => {
  assertReceiptPayloadSize({ receipt: { number: 'RH-001' } }, null);
  assertThrows(
    () => assertReceiptPayloadSize({ blob: 'x'.repeat(130_000) }, null),
    ReceiptValidationError,
  );

  assertReceiptLinesReliable(
    [
      { quantity: 1, total_inc_gst_cents: 19800, gst_cents: 1800 },
      { quantity: 2, unit_price_cents: 8100, gst_cents: 1473 },
    ],
    36000,
    { requireLineGst: true, expectedGstCents: 3273 },
  );
  assertThrows(
    () => assertReceiptLinesReliable([{ total_inc_gst_cents: 1000 }], 2000),
    ReceiptValidationError,
  );
  assertThrows(
    () => assertReceiptLinesReliable([{ total_inc_gst_cents: 1000 }], 1000, {
      requireLineGst: true,
      expectedGstCents: 91,
    }),
    ReceiptValidationError,
  );
  assertThrows(
    () => assertReceiptLinesReliable([{ total_inc_gst_cents: 1000, gst_cents: 1200 }], 1000, {
      requireLineGst: true,
      expectedGstCents: 91,
    }),
    ReceiptValidationError,
  );
  assertThrows(
    () => assertReceiptLinesReliable([{ total_inc_gst_cents: 1000.5, gst_cents: 91 }], 1000, {
      requireLineGst: true,
      expectedGstCents: 91,
    }),
    ReceiptValidationError,
  );
  assertThrows(
    () => assertReceiptLinesReliable([{ total_inc_gst_cents: 1000, gst_cents: 91.5 }], 1000, {
      requireLineGst: true,
      expectedGstCents: 91,
    }),
    ReceiptValidationError,
  );
  assertThrows(
    () => assertReceiptLinesReliable([{ quantity: 1_000_000_000_000, total_inc_gst_cents: 1000, gst_cents: 91 }], 1000, {
      requireLineGst: true,
      expectedGstCents: 91,
    }),
    ReceiptValidationError,
  );
  assertThrows(
    () => assertReceiptLinesReliable([{ quantity: 1.1234, total_inc_gst_cents: 1000, gst_cents: 91 }], 1000, {
      requireLineGst: true,
      expectedGstCents: 91,
    }),
    ReceiptValidationError,
  );
  assertThrows(
    () => assertReceiptLinesReliable([{ unit_price_cents: -1, total_inc_gst_cents: 1000, gst_cents: 91 }], 1000, {
      requireLineGst: true,
      expectedGstCents: 91,
    }),
    ReceiptValidationError,
  );
  assertThrows(
    () => assertReceiptLinesReliable(
      [
        { total_inc_gst_cents: 1000, gst_cents: 91 },
        { total_inc_gst_cents: 2000, gst_cents: 91 },
      ],
      3000,
      { requireLineGst: true, expectedGstCents: 273 },
    ),
    ReceiptValidationError,
  );
  assertThrows(
    () => assertReceiptLinesReliable(undefined, 36000, { requireItemised: true }),
    ReceiptValidationError,
  );
  assertReceiptLinesReliable(undefined, 36000);
});

Deno.test('POS GST/subtotal breakdown requires both fields and must reconcile', () => {
  assertEquals(
    normalizeReceiptTaxBreakdown(36000, 3273, 32727, { requireBothSupplied: true }),
    { subtotalCents: 32727, gstCents: 3273, gstStatus: 'supplied' },
  );
  assertEquals(
    normalizeReceiptTaxBreakdown(36000, undefined, 32727),
    { subtotalCents: 32727, gstCents: 3273, gstStatus: 'supplied' },
  );
  // No GST and no subtotal on the receipt: GST stays unknown for review (GST-01), never 1/11.
  assertEquals(
    normalizeReceiptTaxBreakdown(36000, undefined, undefined),
    { subtotalCents: null, gstCents: null, gstStatus: 'review' },
  );

  assertThrows(
    () => normalizeReceiptTaxBreakdown(36000, undefined, undefined, { requireBothSupplied: true }),
    ReceiptValidationError,
  );
  assertThrows(
    () => normalizeReceiptTaxBreakdown(36000.5, 3273, 32727, { requireBothSupplied: true }),
    ReceiptValidationError,
  );
  assertThrows(
    () => normalizeReceiptTaxBreakdown(36000, 3273.5, 32727, { requireBothSupplied: true }),
    ReceiptValidationError,
  );
  assertThrows(
    () => normalizeReceiptTaxBreakdown(36000, undefined, 32727, { requireBothSupplied: true }),
    ReceiptValidationError,
  );
  assertThrows(
    () => normalizeReceiptTaxBreakdown(36000, 3273, undefined, { requireBothSupplied: true }),
    ReceiptValidationError,
  );
  assertThrows(
    () => normalizeReceiptTaxBreakdown(36000, 1000, 1000, { requireBothSupplied: true }),
    ReceiptValidationError,
  );
  assertThrows(
    () => normalizeReceiptTaxBreakdown(36000, 37000, 0, { requireBothSupplied: true }),
    ReceiptValidationError,
  );
});

Deno.test('POS duplicate races can be detected from Postgres unique errors', () => {
  assert(isUniqueViolation({ code: '23505', message: 'duplicate key value violates unique constraint' }));
  assert(isUniqueViolation({ message: 'duplicate key value violates unique constraint "receipt_events"' }));
  assertEquals(isUniqueViolation({ code: 'PGRST116', message: 'not found' }), false);
});

Deno.test('POS API-key-shaped authorization is distinguished from app JWTs', () => {
  assertEquals(isLoopletApiKeyAuthorization('Bearer llp_bad.secret'), true);
  assertEquals(isLoopletApiKeyAuthorization('llp_bad.secret'), true);
  assertEquals(isLoopletApiKeyAuthorization('Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'), false);
  assertEquals(isLoopletApiKeyAuthorization(null), false);
});
