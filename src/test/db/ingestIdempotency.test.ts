/**
 * SC-09 — Connector endpoint completion
 *
 * Tests:
 *  1. document type: missing idempotency key → 400
 *  2. document type: first push → 202 + deduped:false + bill_id
 *  3. document type: replay with same Idempotency-Key → 200 + deduped:true + same job_id
 *  4. payment type: missing idempotency key → 400
 *  5. payment type: missing required fields → 400
 *  6. payment type: bill_id-only AP payment is rejected (must use bank/payment-run evidence)
 *  7. payment type: invoice payment first push → 202 + deduped:false
 *  8. payment type: replay with same Idempotency-Key → 200 + deduped:true + same job_id
 *  9. unsupported type → 400 unsupported_type
 */

import { describe, it, expect, afterAll } from 'vitest';

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const INGEST_URL = `${SUPABASE_URL}/functions/v1/ingest`;
const TEST_API_KEY = process.env['TEST_CONNECTOR_API_KEY'] ?? '';
const TEST_CONNECTOR_ORG_ID =
  process.env['TEST_CONNECTOR_ORG_ID'] ?? process.env['TEST_ORG_A_ID'] ?? '';
const TEST_INGEST_INVOICE_ID = process.env['TEST_INGEST_INVOICE_ID'] ?? '';
// Key must have write:documents AND write:payments scopes for live tests.

const HAS_LIVE = Boolean(SUPABASE_URL && TEST_API_KEY);
const itLive = it.skipIf(!HAS_LIVE);
const itLiveDocument = it.skipIf(!HAS_LIVE || !TEST_CONNECTOR_ORG_ID);
const itLiveInvoicePayment = it.skipIf(!HAS_LIVE || !TEST_INGEST_INVOICE_ID);

const createdJobIds: string[] = [];

function headers(idempotencyKey?: string): HeadersInit {
  const h: HeadersInit = {
    Authorization: `Bearer ${TEST_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) (h as Record<string, string>)['Idempotency-Key'] = idempotencyKey;
  return h;
}

afterAll(async () => {
  // Job cleanup is handled by DB retention; no manual teardown needed.
});

// ---------------------------------------------------------------------------
// document type
// ---------------------------------------------------------------------------

describe('ingest — document type', () => {
  itLive('rejects if no idempotency key', async () => {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: headers(), // no Idempotency-Key header
      body: JSON.stringify({
        type: 'document',
        payload: { storage_key: 'test/doc.pdf' },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBeFalsy();
  });

  let firstJobId: string;
  const docIdemKey = `sc09-test-doc-${process.env['VITEST_WORKER_ID'] ?? '0'}-${Date.now()}`;

  itLiveDocument('first push returns 202 with deduped:false', async () => {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: headers(docIdemKey),
      body: JSON.stringify({
        type: 'document',
        payload: {
          storage_key: `org-${TEST_CONNECTOR_ORG_ID}/test/sc09-doc.pdf`,
          original_filename: 'sc09-doc.pdf',
          mime_type: 'application/pdf',
        },
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deduped).toBe(false);
    expect(typeof body.job_id).toBe('string');
    expect(typeof body.bill_id).toBe('string');
    firstJobId = body.job_id;
    createdJobIds.push(firstJobId);
  });

  itLiveDocument('replay with same key returns 200 with deduped:true + same job_id', async () => {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: headers(docIdemKey),
      body: JSON.stringify({
        type: 'document',
        payload: {
          storage_key: `org-${TEST_CONNECTOR_ORG_ID}/test/sc09-doc.pdf`,
          original_filename: 'sc09-doc.pdf',
          mime_type: 'application/pdf',
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deduped).toBe(true);
    expect(body.job_id).toBe(firstJobId);
  });
});

// ---------------------------------------------------------------------------
// payment type
// ---------------------------------------------------------------------------

describe('ingest — payment type', () => {
  itLive('rejects if no idempotency key', async () => {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        type: 'payment',
        payload: {
          bill_id: '00000000-0000-0000-0000-000000000001',
          amount_cents: 100,
          payment_date: '2026-06-01',
        },
      }),
    });
    expect(res.status).toBe(400);
  });

  itLive('rejects if no bill_id or invoice_id', async () => {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: headers('sc09-payment-no-ref'),
      body: JSON.stringify({
        type: 'payment',
        payload: { amount_cents: 100, payment_date: '2026-06-01' },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBeFalsy();
  });

  const payIdemKey = `sc09-test-pay-${process.env['VITEST_WORKER_ID'] ?? '0'}-${Date.now()}`;
  const fakeBillId = '00000000-0000-0000-0000-000000000099';

  itLive('rejects bill_id-only AP payments', async () => {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: headers(payIdemKey),
      body: JSON.stringify({
        type: 'payment',
        payload: {
          bill_id: fakeBillId,
          amount_cents: 14300,
          payment_date: '2026-06-01',
          payment_method: 'bank_transfer',
          reference: 'SC09-TEST',
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toMatch(/bank reconciliation|payment runs/i);
  });

  let paymentJobId: string;

  itLiveInvoicePayment('invoice payment first push returns 202 with deduped:false', async () => {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: headers(payIdemKey),
      body: JSON.stringify({
        type: 'payment',
        payload: {
          invoice_id: TEST_INGEST_INVOICE_ID,
          amount_cents: Number(process.env['TEST_INGEST_PAYMENT_AMOUNT_CENTS'] ?? '1'),
          payment_date: '2026-06-01',
          payment_method: 'bank_transfer',
          reference: `SC09-TEST-${payIdemKey}`,
        },
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deduped).toBe(false);
    expect(typeof body.job_id).toBe('string');
    paymentJobId = body.job_id;
    createdJobIds.push(paymentJobId);
  });

  itLiveInvoicePayment(
    'invoice payment replay with same key returns 200 with deduped:true + same job_id',
    async () => {
      const res = await fetch(INGEST_URL, {
        method: 'POST',
        headers: headers(payIdemKey),
        body: JSON.stringify({
          type: 'payment',
          payload: {
            invoice_id: TEST_INGEST_INVOICE_ID,
            amount_cents: Number(process.env['TEST_INGEST_PAYMENT_AMOUNT_CENTS'] ?? '1'),
            payment_date: '2026-06-01',
            payment_method: 'bank_transfer',
            reference: `SC09-TEST-${payIdemKey}`,
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.deduped).toBe(true);
      expect(body.job_id).toBe(paymentJobId);
    },
  );
});

// ---------------------------------------------------------------------------
// Negative: unknown type still 400
// ---------------------------------------------------------------------------

describe('ingest — unsupported type', () => {
  itLive('rejects unknown type with 400 unsupported_type', async () => {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: headers('sc09-unsupported-type'),
      body: JSON.stringify({ type: 'widget', payload: { foo: 'bar' } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('unsupported_type');
  });
});
