/**
 * GST-01: no GST credit is invented when a receipt or bill does not show GST, or when the supplier
 * is not registered for GST.
 *
 * ATO: you can't claim a GST credit for purchases with no GST in the price, including purchases
 * from a supplier that is not registered for GST.
 * https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/claiming-gst-credits/when-you-cannot-claim-a-gst-credit
 *
 * The first tests cover the pure GST rules (receipt-webhook and bills-extract). The last ones run
 * the real receipt-webhook handler against a fake Supabase HTTP API and check what it writes to the
 * books: the bill's gst_cents (the BAS 1B source) and the audit package's gst_status.
 *
 * Run: deno test --allow-env --allow-read --allow-net supabase/functions/receipt-webhook/gst.test.ts
 */
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { normalizeReceiptTaxBreakdown, ReceiptValidationError } from './posReliability.ts';
import { deriveGstCents } from '../bills-extract/gst.ts';

Deno.test('a receipt total with no GST or subtotal leaves GST unknown for review, never 1/11', () => {
  assertEquals(normalizeReceiptTaxBreakdown(11000, undefined, undefined), {
    subtotalCents: null,
    gstCents: null,
    gstStatus: 'review',
  });
  assertEquals(normalizeReceiptTaxBreakdown(5500, null, ''), {
    subtotalCents: null,
    gstCents: null,
    gstStatus: 'review',
  });
});

Deno.test('GST printed on the receipt is used as is', () => {
  assertEquals(normalizeReceiptTaxBreakdown(11000, 1000, undefined), {
    subtotalCents: 10000,
    gstCents: 1000,
    gstStatus: 'supplied',
  });
  assertEquals(normalizeReceiptTaxBreakdown(11000, undefined, 10000), {
    subtotalCents: 10000,
    gstCents: 1000,
    gstStatus: 'supplied',
  });
  assertEquals(normalizeReceiptTaxBreakdown(4000, 0, undefined), {
    subtotalCents: 4000,
    gstCents: 0,
    gstStatus: 'none',
  });
});

Deno.test('a merchant that is not registered for GST gives no GST credit', () => {
  assertEquals(
    normalizeReceiptTaxBreakdown(11000, undefined, undefined, { merchantGstRegistered: false }),
    { subtotalCents: 11000, gstCents: 0, gstStatus: 'none' },
  );
  assertEquals(
    normalizeReceiptTaxBreakdown(11000, 0, 11000, { merchantGstRegistered: false }),
    { subtotalCents: 11000, gstCents: 0, gstStatus: 'none' },
  );
  // GST charged by an unregistered merchant is a contradiction: reject it rather than claim it.
  assertThrows(
    () => normalizeReceiptTaxBreakdown(11000, 1000, 10000, { merchantGstRegistered: false }),
    ReceiptValidationError,
    'merchant.gst_registered',
  );
});

Deno.test('POS receipts still have to carry both GST and subtotal', () => {
  assertThrows(
    () => normalizeReceiptTaxBreakdown(11000, undefined, undefined, { requireBothSupplied: true }),
    ReceiptValidationError,
  );
});

Deno.test('bills-extract keeps GST unknown when the document only shows a total', () => {
  assertEquals(deriveGstCents(11000, null, null), {
    gstCents: null,
    subtotalCents: null,
    estimated: false,
  });
  assertEquals(deriveGstCents(11000, 1000, null), {
    gstCents: 1000,
    subtotalCents: 10000,
    estimated: false,
  });
  assertEquals(deriveGstCents(11000, null, 10000), {
    gstCents: 1000,
    subtotalCents: 10000,
    estimated: true,
  });
  assertEquals(deriveGstCents(11000, null, 11000), {
    gstCents: 0,
    subtotalCents: 11000,
    estimated: false,
  });
  assertEquals(deriveGstCents(null, null, null), {
    gstCents: null,
    subtotalCents: null,
    estimated: false,
  });
});

// ---------------------------------------------------------------------------
// The real handler, against a fake Supabase HTTP API.
// ---------------------------------------------------------------------------

const SUPABASE_URL = 'http://supabase.test';
const ORG_ID = '11111111-1111-4111-8111-111111111111';

interface RecordedWrite {
  method: string;
  table: string;
  body: unknown;
}

function fakeSupabase(writes: RecordedWrite[]): typeof fetch {
  return (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return (async () => {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      const accept = request.headers.get('accept') ?? '';
      const wantsObject = accept.includes('vnd.pgrst.object');
      if (url.pathname.startsWith('/storage/v1/object/')) {
        return Response.json({ Key: url.pathname.replace('/storage/v1/object/', '') });
      }
      const text = method === 'GET' || method === 'HEAD' ? '' : await request.text();
      const body = text ? JSON.parse(text) : null;
      const table = url.pathname.replace('/rest/v1/', '');
      const reply = (rows: Record<string, unknown>[], status = 200) =>
        wantsObject ? Response.json(rows[0] ?? null, { status }) : Response.json(rows, { status });

      if (method === 'GET') {
        if (table === 'organizations') return reply([{ id: ORG_ID }]);
        if (table === 'receipt_identities') {
          return reply([{ id: 'rid-1', organization_id: ORG_ID, status: 'active', revoked_at: null }]);
        }
        return reply([]);
      }

      writes.push({ method, table, body });
      if (method === 'POST') {
        const ids: Record<string, Record<string, unknown>> = {
          receipt_events: { id: 'evt-1', bill_id: null },
          bills: { id: 'bill-1' },
          receipt_audit_packages: { id: 'audit-1' },
        };
        if (table === 'receipt_sync_jobs') {
          return reply([{ id: 'job-1', provider: 'xero', status: 'pending' }], 201);
        }
        const prefer = request.headers.get('prefer') ?? '';
        if (!prefer.includes('return=representation')) return new Response(null, { status: 201 });
        return reply([ids[table] ?? { id: `${table}-1` }], 201);
      }
      return new Response(null, { status: 204 });
    })();
  };
}

async function ingest(payload: Record<string, unknown>) {
  Deno.env.set('SUPABASE_URL', SUPABASE_URL);
  Deno.env.set('SUPABASE_ANON_KEY', 'anon-key');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
  const writes: RecordedWrite[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeSupabase(writes);
  try {
    const { handleReceiptWebhookRequest } = await import('./index.ts');
    const response = await handleReceiptWebhookRequest(
      new Request('http://localhost/receipt-webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer user-session-jwt' },
        body: JSON.stringify({
          organization_id: ORG_ID,
          identity_token: 'rhp_owner.secretpart',
          idempotency_key: `test:${crypto.randomUUID()}`,
          source_channel: 'epost',
          payload,
        }),
      }),
    );
    const json = await response.json();
    const written = (table: string) =>
      writes.find((w) => w.method === 'POST' && w.table === table)?.body as Record<string, unknown>;
    return { status: response.status, json, written };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const sale = (receipt: Record<string, unknown>, merchant: Record<string, unknown> = {}) => ({
  merchant: { name: 'Corner Hardware', ...merchant },
  receipt: {
    number: `R-${crypto.randomUUID().slice(0, 8)}`,
    event_type: 'sale',
    purchase_at: '2026-09-30T02:00:00Z',
    currency: 'AUD',
    tender_status: 'completed',
    ...receipt,
  },
  classification: { business_use: 'business' },
  line_items: [{ description: 'Timber', quantity: 1, total_inc_gst_cents: receipt.total_inc_gst_cents }],
});

Deno.test('receipt-webhook books a total-only receipt with no GST credit, flagged for review', async () => {
  const { status, json, written } = await ingest(sale({ total_inc_gst_cents: 5500 }));
  assertEquals(status, 200, JSON.stringify(json));
  assertEquals(json.classification.gst_status, 'review');

  const bill = written('bills');
  assertEquals(bill.total_inc_gst_cents, 5500);
  assertEquals(bill.gst_cents, null); // not 500 (1/11 of $55)
  assertEquals(bill.subtotal_ex_gst_cents, null);
  assertEquals(bill.gst_estimated, false);

  assertEquals(written('receipt_events').gst_cents, null);
  assertEquals(written('receipt_audit_packages').gst_status, 'review');
  const lines = written('bill_line_items') as unknown as Record<string, unknown>[];
  assertEquals(lines.map((line) => line.gst_cents), [0]);
});

Deno.test('receipt-webhook books no GST credit for a merchant not registered for GST', async () => {
  const { status, json, written } = await ingest(
    sale({ total_inc_gst_cents: 22000 }, { gst_registered: false }),
  );
  assertEquals(status, 200, JSON.stringify(json));
  assertEquals(json.classification.gst_status, 'none');
  const bill = written('bills');
  assertEquals(bill.gst_cents, 0);
  assertEquals(bill.subtotal_ex_gst_cents, 22000);
  assertEquals(written('receipt_audit_packages').gst_status, 'none');
});

Deno.test('receipt-webhook still records GST that the receipt shows', async () => {
  const { status, json, written } = await ingest(
    sale({ total_inc_gst_cents: 5500, gst_cents: 500, subtotal_ex_gst_cents: 5000 }),
  );
  assertEquals(status, 200, JSON.stringify(json));
  assertEquals(json.classification.gst_status, 'supplied');
  assertEquals(written('bills').gst_cents, 500);
  assertEquals(written('receipt_audit_packages').gst_status, 'supplied');
});
