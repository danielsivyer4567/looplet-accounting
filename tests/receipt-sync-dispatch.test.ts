import { describe, it, expect } from 'vitest';
import {
  buildGenericApiBody,
  hmacSha256Hex,
  type GenericApiArgs,
} from '../supabase/functions/_shared/receipt-sync/genericApi';

/**
 * Unit tests for the generic_api receipt sync adapter's pure logic (SC-11).
 *
 * The supabase-js import in the adapter is type-only (erased at runtime), so
 * vitest can import the module and exercise the body builder + HMAC signer
 * without a live client. The DB-backed dispatch routing (xero real push,
 * missing-job skip, unconfigured-provider skip, MYOB/QB coming-soon) is proven
 * by `deno check` + the SC-13 live ride; here we lock the wire format and the
 * signature contract a receiver depends on.
 */

function args(): GenericApiArgs {
  return {
    admin: null as unknown as GenericApiArgs['admin'],
    organizationId: 'org-1',
    receiptEventId: 'evt-1',
    nowSeconds: 1_700_000_000,
    job: { id: 'job-1', job_number: 'JOB-1024', name: 'Fence rebuild' },
    bill: {
      id: 'bill-1',
      invoice_number: 'INV-9',
      invoice_date: '2026-06-01',
      due_date: '2026-06-30',
      total_inc_gst_cents: 11000,
      gst_cents: 1000,
      subtotal_ex_gst_cents: 10000,
      currency_code: 'AUD',
      supplier_name_raw: 'Bunnings',
      job_id: 'job-1',
      job_reference_raw: 'JOB-1024',
      line_items: [
        { description: 'Pine', quantity: 1, unit_price_cents: 11000, total_cents: 11000, gst_cents: 1000 },
      ],
    },
  };
}

describe('buildGenericApiBody', () => {
  it('emits the receipt.bill.synced envelope with bill + job', () => {
    const body = JSON.parse(buildGenericApiBody(args()));
    expect(body.type).toBe('receipt.bill.synced');
    expect(body.organization_id).toBe('org-1');
    expect(body.receipt_event_id).toBe('evt-1');
    expect(body.bill.total_inc_gst_cents).toBe(11000);
    expect(body.bill.job.number).toBe('JOB-1024');
    expect(body.bill.line_items).toHaveLength(1);
  });
});

describe('hmacSha256Hex signing', () => {
  it('is deterministic, keyed, and 64 hex chars', async () => {
    const a = await hmacSha256Hex('secret', 'payload');
    const b = await hmacSha256Hex('secret', 'payload');
    const c = await hmacSha256Hex('other', 'payload');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('covers the timestamp so signatures are replay-distinct', async () => {
    const body = buildGenericApiBody(args());
    const s1 = await hmacSha256Hex('s', `1700000000.${body}`);
    const s2 = await hmacSha256Hex('s', `1700000001.${body}`);
    expect(s1).not.toBe(s2);
  });
});
