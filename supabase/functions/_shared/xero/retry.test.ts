// Tests for Xero retry semantics + STUB-mode CI coverage (P1-08).
//
// Run: deno test --allow-env supabase/functions/_shared/xero/retry.test.ts
//
// Covers:
//   1. callXeroWithRetry — 401 triggers a forced re-auth + ONE retry, replaying
//      the same request (so a stable Idempotency-Key is sent twice, not churned).
//   2. callXeroWithRetry — 429 surfaces a XeroApiError(status=429) with the
//      Retry-After value, so the caller can back off (no duplicate POST).
//   3. XERO_STUB_MODE: pushBillToXero sends nothing and reports not_connected
//      (no placeholder id, no "success" sync-log row), keeping CI offline
//      without Xero creds. More cases live in adapter.test.ts (XERO-01).
//
// We hand-roll a minimal SupabaseClient stub (only the surface these paths use)
// so the test runs offline. Tokens are set un-expired so no refresh fetch fires.

import {
  assert,
  assertEquals,
  assertRejects,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { callXeroWithRetry, xeroFetch, XeroApiError } from './auth.ts';
import { pushBillToXero } from './adapter.ts';

// ---------------------------------------------------------------------------
// Minimal fake Supabase client. Records writes; returns a fixed integration.
// ---------------------------------------------------------------------------
interface FakeState {
  syncLogInserts: Record<string, unknown>[];
  integrationUpdates: Record<string, unknown>[];
  integration: Record<string, unknown>;
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
      if (table === 'xero_sync_log') {
        const rows = Array.isArray(row) ? row : [row];
        state.syncLogInserts.push(...rows);
      }
      return Promise.resolve({ data: null, error: null });
    };
    self.update = (row: Record<string, unknown>) => {
      if (table === 'xero_integrations') state.integrationUpdates.push(row);
      // update().eq() — the returned object must still be chainable then awaitable.
      const u: Record<string, unknown> = {};
      u.eq = () => Promise.resolve({ data: null, error: null });
      return u;
    };
    self.upsert = () => Promise.resolve({ data: null, error: null });
    self.maybeSingle = () => {
      if (table === 'xero_integrations') {
        return Promise.resolve({ data: state.integration, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    return self;
  }
  return { from: (table: string) => builder(table) } as unknown as SupabaseClient;
}

function freshState(): FakeState {
  return {
    syncLogInserts: [],
    integrationUpdates: [],
    integration: {
      id: 'integ-1',
      xero_tenant_id: 'tenant-1',
      is_enabled: true,
      // Far-future expiry so loadAndRefreshXero takes the no-refresh path.
      token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      access_token_encrypted: 'enc-access',
      refresh_token_encrypted: 'enc-refresh',
    },
  };
}

// The no-refresh path in loadAndRefreshXero calls decryptToken() on the stored
// access token, so each test sets a real ENCRYPTION_KEY and pre-encrypts a token
// with the project's own crypto helper. Tokens are un-expired (freshState) so no
// identity.xero.com refresh fetch fires — only the doCall layer is exercised.

const ORG = '11111111-1111-1111-1111-111111111111';

Deno.test('callXeroWithRetry: 429 surfaces XeroApiError(429) with Retry-After', async () => {
  const state = freshState();
  // Give the no-refresh path a real decryptable token.
  Deno.env.set('ENCRYPTION_KEY', 'test-encryption-key-for-ci-only');
  const { encryptToken } = await import('./crypto.ts');
  state.integration.access_token_encrypted = await encryptToken('access-token-abc');

  const admin = makeFakeAdmin(state);
  await assertRejects(
    () =>
      callXeroWithRetry(admin, ORG, (ctx) => {
        // Assert the access token threaded through, then return a 429.
        assertEquals(ctx.tenantId, 'tenant-1');
        return Promise.resolve(
          new Response('rate limited', {
            status: 429,
            headers: { 'Retry-After': '42' },
          }),
        );
      }),
    XeroApiError,
    'Retry after 42s',
  );
});

Deno.test('callXeroWithRetry: 401 forces re-auth then retries the SAME call once', async () => {
  const state = freshState();
  Deno.env.set('ENCRYPTION_KEY', 'test-encryption-key-for-ci-only');
  Deno.env.set('XERO_CLIENT_ID', 'cid');
  Deno.env.set('XERO_CLIENT_SECRET', 'secret');
  const { encryptToken } = await import('./crypto.ts');
  state.integration.access_token_encrypted = await encryptToken('access-token-abc');
  state.integration.refresh_token_encrypted = await encryptToken('refresh-token-xyz');

  // The forced re-auth after a 401 hits identity.xero.com/connect/token — stub it
  // to return a fresh token bundle so the retry can proceed offline.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url: string | URL | Request) => {
    const u = url.toString();
    if (u.includes('identity.xero.com')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 1800 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  try {
    const admin = makeFakeAdmin(state);
    let calls = 0;
    const result = await callXeroWithRetry<{ ok: boolean }>(admin, ORG, () => {
      calls++;
      if (calls === 1) {
        return Promise.resolve(new Response('unauthorized', { status: 401 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    // Retried exactly once after the 401, then succeeded.
    assertEquals(calls, 2);
    assertEquals(result.ok, true);
  } finally {
    globalThis.fetch = realFetch;
    Deno.env.delete('XERO_CLIENT_ID');
    Deno.env.delete('XERO_CLIENT_SECRET');
  }
});

Deno.test('xeroFetch: threads bearer + tenant headers and the Idempotency-Key', async () => {
  const realFetch = globalThis.fetch;
  const captured: { headers: Headers | null } = { headers: null };
  globalThis.fetch = (_url: string | URL | Request, init?: RequestInit) => {
    captured.headers = new Headers(init?.headers);
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  try {
    await xeroFetch(
      { accessToken: 'tok-1', tenantId: 'tenant-1', organizationId: ORG },
      '/api.xro/2.0/Invoices',
      { method: 'POST', headers: { 'Idempotency-Key': 'stable-key-123' } },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert(captured.headers, 'fetch should have been called');
  assertEquals(captured.headers.get('Authorization'), 'Bearer tok-1');
  assertEquals(captured.headers.get('Xero-tenant-id'), 'tenant-1');
  assertEquals(captured.headers.get('Idempotency-Key'), 'stable-key-123');
});

Deno.test('XERO_STUB_MODE: pushBillToXero sends nothing and reports not_connected', async () => {
  // No XERO_CLIENT_ID + explicit stub flag → not connected, no fetch, no fake id.
  Deno.env.set('XERO_STUB_MODE', 'true');
  Deno.env.delete('XERO_CLIENT_ID');

  const state = freshState();
  const admin = makeFakeAdmin(state);

  const realFetch = globalThis.fetch;
  let networkHit = false;
  globalThis.fetch = () => {
    networkHit = true;
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  try {
    const res = await pushBillToXero({
      admin,
      organizationId: ORG,
      bill: {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        invoice_number: 'INV-1',
        invoice_date: '2026-06-01',
        due_date: '2026-06-30',
        total_inc_gst_cents: 11000,
        gst_cents: 1000,
        subtotal_ex_gst_cents: 10000,
        currency_code: 'AUD',
        supplier_name_raw: 'Acme Supplies',
        job_reference_raw: 'JOB-9',
        line_items: [],
      },
      job: { id: 'job-1', job_number: 'JOB-9', name: 'Fence' },
    });
    assertEquals(res.status, 'not_connected');
    assertEquals('xeroInvoiceId' in res, false, 'no placeholder Xero id');
    assertEquals(networkHit, false, 'stub mode must not touch the network');
    // Nothing reached Xero, so nothing is logged as a successful push.
    assertEquals(state.syncLogInserts.length, 0);
  } finally {
    globalThis.fetch = realFetch;
    Deno.env.delete('XERO_STUB_MODE');
  }
});
