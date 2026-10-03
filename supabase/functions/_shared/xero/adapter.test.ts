// XERO-01: a bill is never reported as synced to Xero unless Xero accepted it.
//
// Run: deno test --allow-env --allow-read --allow-net supabase/functions/_shared/xero/adapter.test.ts
//
// Covers pushBillToXero when Xero is not set up, turned off or not connected for
// the organisation (nothing sent, nothing logged, no placeholder id), the real
// push (synced only with the InvoiceID Xero returned), a push Xero does not
// confirm, billXeroSyncUpdate, and that the three callers use it. A minimal fake
// Supabase client and a fake fetch keep it offline.

import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { billXeroSyncUpdate, pushBillToXero } from './adapter.ts';
import { XeroApiError } from './auth.ts';
import { encryptToken } from './crypto.ts';

const ORG = '22222222-2222-2222-2222-222222222222';

interface FakeState {
  integration: Record<string, unknown> | null;
  syncLogInserts: Record<string, unknown>[];
}

function makeFakeAdmin(state: FakeState): SupabaseClient {
  function builder(table: string) {
    const self: Record<string, unknown> = {};
    const chain = () => self;
    self.select = chain;
    self.eq = chain;
    self.order = chain;
    self.limit = chain;
    self.insert = (row: Record<string, unknown> | Record<string, unknown>[]) => {
      if (table === 'xero_sync_log') state.syncLogInserts.push(...(Array.isArray(row) ? row : [row]));
      return Promise.resolve({ data: null, error: null });
    };
    self.update = () => ({ eq: () => Promise.resolve({ data: null, error: null }) });
    self.maybeSingle = () =>
      Promise.resolve({ data: table === 'xero_integrations' ? state.integration : null, error: null });
    return self;
  }
  return { from: (table: string) => builder(table) } as unknown as SupabaseClient;
}

async function connectedIntegration(): Promise<Record<string, unknown>> {
  return {
    id: 'integ-1',
    xero_tenant_id: 'tenant-1',
    is_enabled: true,
    token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    access_token_encrypted: await encryptToken('access-token-xyz'),
    refresh_token_encrypted: await encryptToken('refresh-token-xyz'),
  };
}

function bill(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    invoice_number: 'INV-7',
    invoice_date: '2026-09-01',
    due_date: '2026-09-30',
    total_inc_gst_cents: 11000,
    gst_cents: 1000,
    subtotal_ex_gst_cents: 10000,
    currency_code: 'AUD',
    supplier_name_raw: 'Timber Co',
    job_reference_raw: 'JOB-1',
    line_items: [],
    ...overrides,
  };
}

const JOB = { id: 'job-1', job_number: 'JOB-1', name: 'Fence' };

/** Runs fn with the given env vars set (undefined = unset) and fetch replaced; restores both. */
async function withEnv<T>(
  env: Record<string, string | undefined>,
  fakeFetch: typeof fetch,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  const realFetch = globalThis.fetch;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  globalThis.fetch = fakeFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

function noNetwork(hits: string[]): typeof fetch {
  return ((input: RequestInfo | URL) => {
    hits.push(String(input));
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as typeof fetch;
}

Deno.env.set('ENCRYPTION_KEY', 'test-encryption-key-for-ci-only');

Deno.test('not set up on this server: nothing sent, nothing logged, no placeholder id', async () => {
  const state: FakeState = { integration: await connectedIntegration(), syncLogInserts: [] };
  const hits: string[] = [];
  const res = await withEnv({ XERO_CLIENT_ID: undefined, XERO_STUB_MODE: undefined }, noNetwork(hits), () =>
    pushBillToXero({ admin: makeFakeAdmin(state), organizationId: ORG, bill: bill(), job: JOB })
  );
  assertEquals(res.status, 'not_connected');
  assert(res.status === 'not_connected' && /not set up/.test(res.reason));
  assertEquals('xeroInvoiceId' in res, false);
  assertEquals(JSON.stringify(res).includes('STUB'), false);
  assertEquals(hits, []);
  assertEquals(state.syncLogInserts, []);
});

Deno.test('organisation has no active Xero connection: not_connected', async () => {
  const state: FakeState = { integration: null, syncLogInserts: [] };
  const hits: string[] = [];
  const res = await withEnv({ XERO_CLIENT_ID: 'cid', XERO_STUB_MODE: undefined }, noNetwork(hits), () =>
    pushBillToXero({ admin: makeFakeAdmin(state), organizationId: ORG, bill: bill(), job: JOB })
  );
  assertEquals(res.status, 'not_connected');
  assert(res.status === 'not_connected' && /not connected for this organisation/.test(res.reason));
  assertEquals(hits, []);
  assertEquals(state.syncLogInserts, []);
});

Deno.test('XERO_STUB_MODE turns sync off even when connected: not_connected', async () => {
  const state: FakeState = { integration: await connectedIntegration(), syncLogInserts: [] };
  const hits: string[] = [];
  const res = await withEnv({ XERO_CLIENT_ID: 'cid', XERO_STUB_MODE: 'true' }, noNetwork(hits), () =>
    pushBillToXero({ admin: makeFakeAdmin(state), organizationId: ORG, bill: bill(), job: JOB })
  );
  assertEquals(res.status, 'not_connected');
  assertEquals(hits, []);
  assertEquals(state.syncLogInserts, []);
});

Deno.test('not connected does not fail the caller on Xero-only validation', async () => {
  const state: FakeState = { integration: null, syncLogInserts: [] };
  const res = await withEnv({ XERO_CLIENT_ID: undefined }, noNetwork([]), () =>
    pushBillToXero({
      admin: makeFakeAdmin(state),
      organizationId: ORG,
      bill: bill({ supplier_name_raw: null }),
      job: JOB,
    })
  );
  assertEquals(res.status, 'not_connected');
});

Deno.test('connected: synced only with the InvoiceID Xero returned', async () => {
  const state: FakeState = { integration: await connectedIntegration(), syncLogInserts: [] };
  const calls: { url: string; method: string }[] = [];
  const fakeXero = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (url.includes('/Contacts')) {
      return Promise.resolve(Response.json({ Contacts: [{ ContactID: 'contact-1' }] }));
    }
    if (url.includes('/Invoices') && method === 'POST') {
      return Promise.resolve(Response.json({ Invoices: [{ InvoiceID: 'xero-invoice-123' }] }));
    }
    return Promise.resolve(new Response('unexpected', { status: 500 }));
  }) as typeof fetch;

  const res = await withEnv({ XERO_CLIENT_ID: 'cid', XERO_STUB_MODE: undefined }, fakeXero, () =>
    pushBillToXero({ admin: makeFakeAdmin(state), organizationId: ORG, bill: bill(), job: JOB })
  );
  assertEquals(res, { status: 'synced', xeroInvoiceId: 'xero-invoice-123' });
  assert(calls.some((c) => c.url.includes('/Invoices') && c.method === 'POST'), 'bill was POSTed to Xero');
  assertEquals(state.syncLogInserts.length, 1);
  assertEquals(state.syncLogInserts[0].xero_id, 'xero-invoice-123');
  assertEquals(state.syncLogInserts[0].status, 'success');
});

Deno.test('connected but Xero returns no InvoiceID: throws, never synced', async () => {
  const state: FakeState = { integration: await connectedIntegration(), syncLogInserts: [] };
  const fakeXero = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/Contacts')) {
      return Promise.resolve(Response.json({ Contacts: [{ ContactID: 'contact-1' }] }));
    }
    return Promise.resolve(Response.json({ Invoices: [{}] }));
  }) as typeof fetch;

  await withEnv({ XERO_CLIENT_ID: 'cid', XERO_STUB_MODE: undefined }, fakeXero, () =>
    assertRejects(
      () => pushBillToXero({ admin: makeFakeAdmin(state), organizationId: ORG, bill: bill(), job: JOB }),
      XeroApiError,
      'did not return an InvoiceID',
    )
  );
  assertEquals(state.syncLogInserts, []);
});

Deno.test('billXeroSyncUpdate: synced writes the Xero id; not connected stays pending', () => {
  assertEquals(billXeroSyncUpdate({ status: 'synced', xeroInvoiceId: 'xero-1' }, '2026-10-03T00:00:00Z'), {
    xero_status: 'synced',
    xero_invoice_id: 'xero-1',
    xero_synced_at: '2026-10-03T00:00:00Z',
  });
  assertEquals(billXeroSyncUpdate({ status: 'not_connected', reason: 'x' }, '2026-10-03T00:00:00Z'), {
    xero_status: 'pending',
  });
});

Deno.test('callers mark bills from the push result, never a hard-coded synced', async () => {
  const root = new URL('../../', import.meta.url);
  for (const path of ['bills-attach/index.ts', '_shared/bills/router.ts', 'receipt-sync-dispatch/index.ts']) {
    const src = await Deno.readTextFile(new URL(path, root));
    assert(src.includes('billXeroSyncUpdate('), `${path} uses billXeroSyncUpdate`);
    // The old code wrote `xero_status: 'synced',` in each caller's bills update.
    assertEquals(/xero_status:\s*'synced'\s*,/.test(src), false, `${path} must not hard-code xero_status 'synced'`);
    assertEquals(src.includes('isStub'), false, `${path} must not reference isStub`);
  }
  const adapter = await Deno.readTextFile(new URL('_shared/xero/adapter.ts', root));
  assertEquals(adapter.includes('STUB-'), false, 'adapter must not build placeholder STUB ids');
});
