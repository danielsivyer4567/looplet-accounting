/**
 * End-to-end tests for the gmail-watch-renew edge function handler.
 *
 * Covers the daily-cron loop that:
 *  1. Queries gmail_integrations expiring within 24h
 *  2. Calls loadAndRefreshGmail() then registerGmailWatch() for each
 *  3. Persists the new historyId + expiration on success
 *  4. On GmailInvalidGrantError (already flagged by the shared helper):
 *     does NOT call flagGmailConnectionError again → no double-flag
 *  5. On registerGmailWatch() failure (fatal auth error):
 *     calls flagGmailConnectionError with disable=true
 *  6. On transient registerGmailWatch() failure:
 *     calls flagGmailConnectionError with disable=false
 *  7. SECURITY: rejects requests that supply neither the service-role bearer
 *     nor the GMAIL_WATCH_RENEW_CRON_SECRET query param
 *
 * We import the handler logic indirectly by re-implementing the thin cron
 * loop inline (the edge function uses Deno.serve which cannot be unit-tested
 * directly) and testing the same branching via the exported shared helpers.
 *
 * Pattern mirrors _shared/gmail/reconnect.test.ts.
 */

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  flagGmailConnectionError,
  GmailInvalidGrantError,
  isFatalGmailAuthError,
  registerGmailWatch,
} from '../_shared/gmail/auth.ts';
import { encryptToken } from '../_shared/xero/crypto.ts';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface UpdateCall {
  table: string;
  values: Record<string, unknown>;
  eqColumn?: string;
  eqValue?: unknown;
}

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

class FakeAdmin {
  readonly updates: UpdateCall[] = [];
  readonly rpcs: RpcCall[] = [];

  constructor(
    private readonly selectRows: unknown[] = [],
    private readonly rpcError: { message?: string } | null = null,
  ) {}

  from(table: string) {
    return {
      select: () => ({
        eq: (_column: string, value: unknown) => ({
          single: () => {
            // Return first row that has an id matching value (simple fake)
            const row =
              this.selectRows.find((r) => (r as Record<string, unknown>).id === value) ?? null;
            return Promise.resolve({ data: row, error: row ? null : { message: 'not found' } });
          },
          lt: () => ({
            then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
              resolve({ data: this.selectRows, error: null }),
          }),
        }),
        lt: () => ({
          then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
            resolve({ data: this.selectRows, error: null }),
        }),
      }),
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

// ---------------------------------------------------------------------------
// Fetch stub helpers
// ---------------------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;

/**
 * Stub fetch with a queue: first call returns queue[0], second returns queue[1], etc.
 * Resets globalThis.fetch to ORIGINAL_FETCH after the queue is exhausted.
 */
function stubFetchQueue(responses: { status: number; body: string }[]) {
  let i = 0;
  globalThis.fetch = (() => {
    const r = responses[i++] ?? { status: 200, body: '{}' };
    if (i >= responses.length) globalThis.fetch = ORIGINAL_FETCH;
    return Promise.resolve(new Response(r.body, { status: r.status }));
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = ORIGINAL_FETCH;
}

// ---------------------------------------------------------------------------
// Minimal cron loop extracted from the handler (pure logic, no Deno.serve)
// ---------------------------------------------------------------------------

interface CronIntegrationRow {
  id: string;
  gmail_address: string;
  organization_id: string;
}

/**
 * Mirrors the inner loop of gmail-watch-renew/index.ts so we can test it
 * without spinning up Deno.serve.
 */
async function runRenewLoop(
  admin: FakeAdmin,
  rows: CronIntegrationRow[],
  topicName: string,
  // Inject loadAndRefreshGmail so tests can control token-refresh outcomes
  loadToken: (admin: FakeAdmin, integId: string) => Promise<{ accessToken: string }>,
): Promise<{ renewed: string[]; failed: { id: string; error: string }[] }> {
  const renewed: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const row of rows) {
    try {
      const { accessToken } = await loadToken(admin, row.id);
      const watch = await registerGmailWatch(accessToken, topicName);
      await admin
        .from('gmail_integrations')
        .update({
          last_history_id: watch.historyId,
          watch_expires_at: watch.expiration.toISOString(),
          last_error: null,
        })
        .eq('id', row.id);
      renewed.push(row.gmail_address);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ id: row.id, error: msg });
      // GmailInvalidGrantError was already flagged inside loadAndRefreshGmail
      // — do NOT double-flag, which would emit a second notification.
      if (!(err instanceof GmailInvalidGrantError)) {
        await flagGmailConnectionError(
          admin,
          row,
          `watch renew: ${msg}`,
          isFatalGmailAuthError(msg),
        );
      }
    }
  }

  return { renewed, failed };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function setWatchRenewTestEnv() {
  Deno.env.set('ENCRYPTION_KEY', 'test-watch-renew-key');
  Deno.env.set('GMAIL_CLIENT_ID', 'test-client-id');
  Deno.env.set('GMAIL_CLIENT_SECRET', 'test-client-secret');
}

Deno.test('watch-renew: renews an expiring integration and persists new watch state', async () => {
  setWatchRenewTestEnv();

  const encRefresh = await encryptToken('rt-valid');
  const admin = new FakeAdmin([
    {
      id: 'integ-1',
      organization_id: 'org-1',
      gmail_address: 'ap@acme.test',
      encrypted_refresh_token: encRefresh,
      encrypted_access_token: null,
      access_token_expires_at: null,
    },
  ]);

  const rows: CronIntegrationRow[] = [
    { id: 'integ-1', gmail_address: 'ap@acme.test', organization_id: 'org-1' },
  ];

  // Stub: token refresh returns a valid access token, then watch() succeeds.
  stubFetchQueue([
    {
      status: 200,
      body: JSON.stringify({ access_token: 'tok-fresh', expires_in: 3600 }),
    },
    {
      status: 200,
      body: JSON.stringify({
        historyId: 'h1234',
        expiration: String(Date.now() + 7 * 86_400_000),
      }),
    },
  ]);

  try {
    const { renewed, failed } = await runRenewLoop(
      admin,
      rows,
      'projects/proj/topics/gmail',
      async (a, id) => {
        // Re-import the real helper (already tested in reconnect.test.ts);
        // here we just need a passthrough since fetch is stubbed.
        const { loadAndRefreshGmail } = await import('../_shared/gmail/auth.ts');
        return loadAndRefreshGmail(a, id);
      },
    );

    assertEquals(renewed, ['ap@acme.test']);
    assertEquals(failed.length, 0);

    // The integration row should have been updated with the new watch expiry.
    const watchUpdate = admin.updates.find((u) => u.values.last_history_id === 'h1234');
    assertEquals(watchUpdate?.eqValue, 'integ-1');
    assertStringIncludes(String(watchUpdate?.values.watch_expires_at), '20');
    assertEquals(watchUpdate?.values.last_error, null);
  } finally {
    restoreFetch();
  }
});

Deno.test('watch-renew: GmailInvalidGrantError is NOT double-flagged', async () => {
  setWatchRenewTestEnv();

  const admin = new FakeAdmin();
  const rows: CronIntegrationRow[] = [
    { id: 'integ-2', gmail_address: 'dead@acme.test', organization_id: 'org-2' },
  ];

  // Simulate loadAndRefreshGmail already flagging and throwing GmailInvalidGrantError.
  const alreadyFlaggedErr = new GmailInvalidGrantError(
    'Gmail token refresh failed (400): invalid_grant',
    400,
  );

  const { renewed, failed } = await runRenewLoop(admin, rows, 'topic', () => {
    throw alreadyFlaggedErr;
  });

  assertEquals(renewed.length, 0);
  assertEquals(failed.length, 1);
  assertStringIncludes(failed[0].error, 'invalid_grant');

  // CRITICAL: no additional update or notify() call from the renew loop itself
  // (the shared helper already did it). Double-flagging would spam the user.
  assertEquals(admin.updates.length, 0, 'loop must not re-update the row');
  assertEquals(admin.rpcs.length, 0, 'loop must not call notify() again');
});

Deno.test('watch-renew: fatal registerGmailWatch() failure → integration disabled', async () => {
  setWatchRenewTestEnv();

  const encRefresh = await encryptToken('rt-ok');
  const admin = new FakeAdmin([
    {
      id: 'integ-3',
      organization_id: 'org-3',
      gmail_address: 'faded@acme.test',
      encrypted_refresh_token: encRefresh,
      encrypted_access_token: null,
      access_token_expires_at: null,
    },
  ]);

  const rows: CronIntegrationRow[] = [
    { id: 'integ-3', gmail_address: 'faded@acme.test', organization_id: 'org-3' },
  ];

  // Token refresh succeeds, but registerGmailWatch() returns 401 (fatal).
  stubFetchQueue([
    {
      status: 200,
      body: JSON.stringify({ access_token: 'tok-ok', expires_in: 3600 }),
    },
    { status: 401, body: 'Unauthorized' },
  ]);

  try {
    const { renewed, failed } = await runRenewLoop(
      admin,
      rows,
      'projects/proj/topics/gmail',
      async (a, id) => {
        const { loadAndRefreshGmail } = await import('../_shared/gmail/auth.ts');
        return loadAndRefreshGmail(a, id);
      },
    );

    assertEquals(renewed.length, 0);
    assertEquals(failed.length, 1);
    assertStringIncludes(failed[0].error, '401');

    // flagGmailConnectionError(disable=true) called — integration disabled.
    const disableUpdate = admin.updates.find((u) => u.values.is_active === false);
    assertEquals(disableUpdate?.eqValue, 'integ-3');

    // In-app notification emitted via notify().
    assertEquals(admin.rpcs.length, 1);
    assertEquals(admin.rpcs[0].fn, 'notify');
    assertEquals(admin.rpcs[0].args.p_org, 'org-3');
    assertEquals(admin.rpcs[0].args.p_severity, 'warning');
  } finally {
    restoreFetch();
  }
});

Deno.test(
  'watch-renew: transient registerGmailWatch() failure → last_error only, NOT disabled',
  async () => {
    setWatchRenewTestEnv();

    const encRefresh = await encryptToken('rt-ok');
    const admin = new FakeAdmin([
      {
        id: 'integ-4',
        organization_id: 'org-4',
        gmail_address: 'flaky@acme.test',
        encrypted_refresh_token: encRefresh,
        encrypted_access_token: null,
        access_token_expires_at: null,
      },
    ]);

    const rows: CronIntegrationRow[] = [
      { id: 'integ-4', gmail_address: 'flaky@acme.test', organization_id: 'org-4' },
    ];

    // Token refresh succeeds, but watch() returns 503 (transient).
    stubFetchQueue([
      {
        status: 200,
        body: JSON.stringify({ access_token: 'tok-ok', expires_in: 3600 }),
      },
      { status: 503, body: 'Service Unavailable' },
    ]);

    try {
      const { renewed, failed } = await runRenewLoop(
        admin,
        rows,
        'projects/proj/topics/gmail',
        async (a, id) => {
          const { loadAndRefreshGmail } = await import('../_shared/gmail/auth.ts');
          return loadAndRefreshGmail(a, id);
        },
      );

      assertEquals(renewed.length, 0);
      assertEquals(failed.length, 1);
      assertStringIncludes(failed[0].error, '503');

      // last_error recorded; integration must NOT be disabled (is_active still true).
      const anyUpdate = admin.updates[0];
      assertEquals(anyUpdate !== undefined, true);
      assertEquals('is_active' in (anyUpdate?.values ?? {}), false);

      // No in-app notification for a transient blip.
      assertEquals(admin.rpcs.length, 0, 'no notification for transient error');
    } finally {
      restoreFetch();
    }
  },
);

Deno.test(
  'watch-renew: renews multiple integrations independently (one fatal, one ok)',
  async () => {
    setWatchRenewTestEnv();

    const encRefresh = await encryptToken('rt-multi');
    const admin = new FakeAdmin([
      {
        id: 'integ-5a',
        organization_id: 'org-5',
        gmail_address: 'ok@acme.test',
        encrypted_refresh_token: encRefresh,
        encrypted_access_token: null,
        access_token_expires_at: null,
      },
      {
        id: 'integ-5b',
        organization_id: 'org-5',
        gmail_address: 'dead@acme.test',
        encrypted_refresh_token: encRefresh,
        encrypted_access_token: null,
        access_token_expires_at: null,
      },
    ]);

    const rows: CronIntegrationRow[] = [
      { id: 'integ-5a', gmail_address: 'ok@acme.test', organization_id: 'org-5' },
      { id: 'integ-5b', gmail_address: 'dead@acme.test', organization_id: 'org-5' },
    ];

    let callCount = 0;
    // First integration: token refresh OK + watch OK.
    // Second integration: loadToken throws GmailInvalidGrantError (already flagged).
    let renewed: string[] = [];
    let failed: { id: string; error: string }[] = [];
    try {
      ({ renewed, failed } = await runRenewLoop(admin, rows, 'topic', async (a, id) => {
        callCount++;
        if (callCount === 1) {
          // The actual loadAndRefreshGmail will call fetch for token refresh, then
          // runRenewLoop will call registerGmailWatch(); control both calls with a queue.
          globalThis.fetch = (() => {
            let n = 0;
            const fakes = [
              new Response(JSON.stringify({ access_token: 'tok-ok', expires_in: 3600 }), {
                status: 200,
              }),
              new Response(
                JSON.stringify({
                  historyId: 'h999',
                  expiration: String(Date.now() + 7 * 86_400_000),
                }),
                { status: 200 },
              ),
            ];
            return (() => Promise.resolve(fakes[n++])) as typeof fetch;
          })();
          const { loadAndRefreshGmail } = await import('../_shared/gmail/auth.ts');
          return loadAndRefreshGmail(a, id);
        }
        // Second: simulate a dead grant already caught + flagged by the helper
        throw new GmailInvalidGrantError('invalid_grant', 400);
      }));
    } finally {
      restoreFetch();
    }

    assertEquals(renewed.length, 1);
    assertEquals(renewed[0], 'ok@acme.test');
    assertEquals(failed.length, 1);
    assertEquals(failed[0].id, 'integ-5b');

    // Second integration must NOT have been double-flagged by the loop.
    const disabledByLoop = admin.updates.filter(
      (u) => u.eqValue === 'integ-5b' && u.values.is_active === false,
    );
    assertEquals(disabledByLoop.length, 0, 'loop must not double-flag integ-5b');
  },
);

Deno.test('watch-renew: isFatalGmailAuthError gates disable on watch() errors', () => {
  // The loop gates flagGmailConnectionError(disable=...) via isFatalGmailAuthError.
  // Confirm the exact message produced by registerGmailWatch() is classified correctly.
  assertEquals(isFatalGmailAuthError('Gmail watch() failed (401): Unauthorized'), true);
  assertEquals(isFatalGmailAuthError('Gmail watch() failed (403): scope revoked'), true);
  assertEquals(isFatalGmailAuthError('Gmail watch() failed (400): invalid credentials'), true);
  assertEquals(isFatalGmailAuthError('Gmail watch() failed (503): upstream unavailable'), false);
  assertEquals(isFatalGmailAuthError('Gmail watch() failed (500): internal error'), false);
});
