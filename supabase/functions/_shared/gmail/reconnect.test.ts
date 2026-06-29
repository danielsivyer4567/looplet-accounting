/**
 * Tests for the P1-09 Gmail reconnect / disconnect-notification logic in
 * `_shared/gmail/auth.ts`:
 *
 *   - isFatalGmailAuthError() classifies revoked-grant errors as fatal and
 *     transient errors (5xx / network) as non-fatal.
 *   - flagGmailConnectionError() disables the integration AND emits an in-app
 *     notification via the notify() RPC on a fatal disconnect; on a non-fatal
 *     error it records last_error only and does NOT disable or notify.
 *   - loadAndRefreshGmail() routes a Google `invalid_grant` (HTTP 400) through
 *     flagGmailConnectionError(disable=true) — the end-to-end "invalid_grant ->
 *     integration disabled + notify() called" requirement — and throws a typed
 *     GmailInvalidGrantError so callers stop processing.
 */

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  flagGmailConnectionError,
  GmailInvalidGrantError,
  isFatalGmailAuthError,
  loadAndRefreshGmail,
} from './auth.ts';
import { encryptToken } from '../xero/crypto.ts';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

interface UpdateCall {
  table: string;
  values: Record<string, unknown>;
  eqColumn?: string;
  eqValue?: unknown;
}

/**
 * Minimal Supabase-shaped fake that records:
 *   - .from(t).select(cols).eq(c,v).single()  → returns `selectResult`
 *   - .from(t).update(vals).eq(c,v)            → records an UpdateCall
 *   - .rpc(fn, args)                           → records an RpcCall
 */
class FakeAdmin {
  readonly updates: UpdateCall[] = [];
  readonly rpcs: RpcCall[] = [];

  constructor(
    private readonly selectResult: { data: unknown; error: { message?: string } | null } = {
      data: null,
      error: null,
    },
    private readonly rpcError: { message?: string } | null = null,
  ) {}

  from(table: string) {
    return {
      select: () => {
        return {
          eq: () => {
            return {
              single: () => Promise.resolve(this.selectResult),
            };
          },
        };
      },
      update: (values: Record<string, unknown>) => {
        const call: UpdateCall = { table, values };
        this.updates.push(call);
        return {
          eq(column: string, value: unknown) {
            call.eqColumn = column;
            call.eqValue = value;
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };
  }

  rpc(fn: string, args: Record<string, unknown>) {
    this.rpcs.push({ fn, args });
    return Promise.resolve({ error: this.rpcError });
  }
}

const ORIGINAL_FETCH = globalThis.fetch;

function stubFetch(status: number, body: string) {
  globalThis.fetch = (() => Promise.resolve(new Response(body, { status }))) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = ORIGINAL_FETCH;
}

// ---------------------------------------------------------------------------
// isFatalGmailAuthError
// ---------------------------------------------------------------------------

Deno.test('isFatalGmailAuthError flags revoked grants + 400/401 as fatal', () => {
  assertEquals(isFatalGmailAuthError('token refresh: ... "error": "invalid_grant"'), true);
  assertEquals(isFatalGmailAuthError('Gmail token refresh failed (400): bad'), true);
  assertEquals(isFatalGmailAuthError('Gmail watch() failed (401): nope'), true);
  assertEquals(isFatalGmailAuthError('unauthorized_client'), true);
  assertEquals(isFatalGmailAuthError('history.list 403: forbidden'), true);
});

Deno.test('isFatalGmailAuthError treats 5xx / network blips as transient', () => {
  assertEquals(isFatalGmailAuthError('Gmail token refresh failed (503): try later'), false);
  assertEquals(isFatalGmailAuthError('history.list 500: server error'), false);
  assertEquals(isFatalGmailAuthError('error sending request to https://...'), false);
  assertEquals(isFatalGmailAuthError('history.list 404: stale history id'), false);
});

// ---------------------------------------------------------------------------
// flagGmailConnectionError
// ---------------------------------------------------------------------------

Deno.test('flagGmailConnectionError disables + notifies on a fatal disconnect', async () => {
  const admin = new FakeAdmin();

  await flagGmailConnectionError(
    admin,
    { id: 'integ-1', organization_id: 'org-1', gmail_address: 'ap@acme.test' },
    'token refresh: invalid_grant',
    true,
  );

  // 1. Integration row disabled + last_error recorded, scoped to its id.
  assertEquals(admin.updates.length, 1);
  const upd = admin.updates[0];
  assertEquals(upd.table, 'gmail_integrations');
  assertEquals(upd.values.is_active, false);
  assertStringIncludes(String(upd.values.last_error), 'invalid_grant');
  assertEquals(upd.eqColumn, 'id');
  assertEquals(upd.eqValue, 'integ-1');

  // 2. Exactly one in-app notification emitted via notify(), targeting the org.
  assertEquals(admin.rpcs.length, 1);
  const rpc = admin.rpcs[0];
  assertEquals(rpc.fn, 'notify');
  assertEquals(rpc.args.p_org, 'org-1');
  assertEquals(rpc.args.p_severity, 'warning');
  assertEquals(rpc.args.p_resource_type, 'gmail_integration');
  assertEquals(rpc.args.p_resource_id, 'integ-1');
  assertEquals(rpc.args.p_link, '/settings');
  assertStringIncludes(String(rpc.args.p_title), 'ap@acme.test');
});

Deno.test('flagGmailConnectionError records last_error but does NOT disable/notify on a transient error', async () => {
  const admin = new FakeAdmin();

  await flagGmailConnectionError(
    admin,
    { id: 'integ-2', organization_id: 'org-2', gmail_address: 'bills@acme.test' },
    'token refresh: Gmail token refresh failed (503)',
    false,
  );

  assertEquals(admin.updates.length, 1);
  assertEquals('is_active' in admin.updates[0].values, false); // not disabled
  assertEquals(admin.rpcs.length, 0); // no bell spam on a blip
});

Deno.test('flagGmailConnectionError swallows notify() failures so the auth error still surfaces', async () => {
  const admin = new FakeAdmin({ data: null, error: null }, { message: 'pgrst boom' });

  // Should not throw even though notify() returns an error.
  await flagGmailConnectionError(
    admin,
    { id: 'integ-3', organization_id: 'org-3', gmail_address: 'x@acme.test' },
    'token refresh: invalid_grant',
    true,
  );

  assertEquals(admin.rpcs.length, 1);
});

// ---------------------------------------------------------------------------
// loadAndRefreshGmail — end-to-end fatal path
// ---------------------------------------------------------------------------

Deno.test('loadAndRefreshGmail disables + notifies + throws on invalid_grant (400)', async () => {
  Deno.env.set('ENCRYPTION_KEY', 'test-key-for-reconnect-spec');
  Deno.env.set('GMAIL_CLIENT_ID', 'cid');
  Deno.env.set('GMAIL_CLIENT_SECRET', 'secret');

  // Row with a (decryptable) refresh token but an EXPIRED cached access token,
  // forcing the refresh path.
  const encRefresh = await encryptToken('refresh-token-value');
  const admin = new FakeAdmin({
    data: {
      id: 'integ-9',
      organization_id: 'org-9',
      gmail_address: 'dead@acme.test',
      encrypted_refresh_token: encRefresh,
      encrypted_access_token: null,
      access_token_expires_at: null,
    },
    error: null,
  });

  stubFetch(400, JSON.stringify({ error: 'invalid_grant', error_description: 'Token revoked' }));
  try {
    const err = await assertRejects(
      () => loadAndRefreshGmail(admin, 'integ-9'),
      GmailInvalidGrantError,
    );
    assertEquals(err.status, 400);
  } finally {
    restoreFetch();
  }

  // Integration disabled.
  const disable = admin.updates.find((u) => u.values.is_active === false);
  assertEquals(disable?.eqValue, 'integ-9');

  // notify() fired for the dead mailbox's org.
  assertEquals(admin.rpcs.length, 1);
  assertEquals(admin.rpcs[0].fn, 'notify');
  assertEquals(admin.rpcs[0].args.p_org, 'org-9');
  assertStringIncludes(String(admin.rpcs[0].args.p_title), 'dead@acme.test');
});

Deno.test('loadAndRefreshGmail leaves integration active + does not notify on a 503 blip', async () => {
  Deno.env.set('ENCRYPTION_KEY', 'test-key-for-reconnect-spec');
  Deno.env.set('GMAIL_CLIENT_ID', 'cid');
  Deno.env.set('GMAIL_CLIENT_SECRET', 'secret');

  const encRefresh = await encryptToken('refresh-token-value');
  const admin = new FakeAdmin({
    data: {
      id: 'integ-10',
      organization_id: 'org-10',
      gmail_address: 'flaky@acme.test',
      encrypted_refresh_token: encRefresh,
      encrypted_access_token: null,
      access_token_expires_at: null,
    },
    error: null,
  });

  stubFetch(503, 'Service Unavailable');
  try {
    // Non-fatal: a plain Error, NOT GmailInvalidGrantError.
    const err = await assertRejects(() => loadAndRefreshGmail(admin, 'integ-10'), Error);
    assertEquals(err instanceof GmailInvalidGrantError, false);
  } finally {
    restoreFetch();
  }

  // last_error recorded, but integration left active + no notification.
  assertEquals(
    admin.updates.some((u) => u.values.is_active === false),
    false,
  );
  assertEquals(admin.rpcs.length, 0);
});
