import { assert, assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  assertDeliverableEndpoint,
  buildGenericApiBody,
  GenericApiUnsafeEndpoint,
  hmacSha256Hex,
  type GenericApiArgs,
} from './genericApi.ts';

function sampleArgs(): GenericApiArgs {
  return {
    // admin is unused by the pure helpers under test.
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
        {
          description: 'Pine',
          quantity: 1,
          unit_price_cents: 11000,
          total_cents: 11000,
          gst_cents: 1000,
        },
      ],
    },
  };
}

Deno.test('buildGenericApiBody emits the bill + job envelope', () => {
  const body = JSON.parse(buildGenericApiBody(sampleArgs()));
  assertEquals(body.type, 'receipt.bill.synced');
  assertEquals(body.organization_id, 'org-1');
  assertEquals(body.receipt_event_id, 'evt-1');
  assertEquals(body.bill.total_inc_gst_cents, 11000);
  assertEquals(body.bill.job.number, 'JOB-1024');
  assertEquals(body.bill.line_items.length, 1);
});

Deno.test('hmacSha256Hex is deterministic and keyed', async () => {
  const a = await hmacSha256Hex('secret', 'payload');
  const b = await hmacSha256Hex('secret', 'payload');
  const c = await hmacSha256Hex('other-secret', 'payload');
  assertEquals(a, b);
  assert(a !== c);
  // 32-byte HMAC-SHA256 → 64 hex chars
  assertEquals(a.length, 64);
});

Deno.test('signature covers timestamp + body', async () => {
  const body = buildGenericApiBody(sampleArgs());
  const sig1 = await hmacSha256Hex('s', `1700000000.${body}`);
  const sig2 = await hmacSha256Hex('s', `1700000001.${body}`);
  assert(sig1 !== sig2, 'changing the timestamp must change the signature');
});

Deno.test('assertDeliverableEndpoint accepts a public https URL', () => {
  const url = assertDeliverableEndpoint('https://api.partner.example.com/webhooks/looplet');
  assertEquals(url.protocol, 'https:');
  assertEquals(url.hostname, 'api.partner.example.com');
});

Deno.test('assertDeliverableEndpoint rejects plaintext http', () => {
  assertThrows(
    () => assertDeliverableEndpoint('http://api.partner.example.com/hook'),
    GenericApiUnsafeEndpoint,
    'https',
  );
});

Deno.test('assertDeliverableEndpoint blocks loopback, link-local/metadata, and RFC1918 hosts', () => {
  for (
    const host of [
      'localhost',
      '127.0.0.1',
      'sub.localhost',
      '169.254.169.254', // cloud metadata
      '10.0.0.5',
      '192.168.1.10',
      '172.16.0.9',
      '[::1]',
    ]
  ) {
    assertThrows(
      () => assertDeliverableEndpoint(`https://${host}/hook`),
      GenericApiUnsafeEndpoint,
      undefined,
      `expected ${host} to be blocked`,
    );
  }
});

Deno.test('assertDeliverableEndpoint rejects a malformed URL', () => {
  assertThrows(() => assertDeliverableEndpoint('not a url'), GenericApiUnsafeEndpoint);
});
