/**
 * LODGE-01: super-batch-send only prepares a clearing-house file, so it must record the batch as
 * `file_prepared`, never `sent`. Nothing goes to a fund or clearing house and nothing is paid.
 * The admin-or-owner check from 5ba716b (authorizeOrgMember with 'admin') must still hold.
 *
 * Runs the real handler against a fake Supabase HTTP API and records what it writes.
 *
 * Run: deno test --allow-env --allow-read --allow-net supabase/functions/super-batch-send/status.test.ts
 */
import { assert, assertEquals, assertMatch } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const SUPABASE_URL = 'http://supabase.test';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const BATCH_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

interface Scenario {
  role?: string;
  acceptedAt?: string | null;
  batchStatus?: string;
  approved?: boolean;
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const PAYLOAD = {
  schema_version: 'build_superstream_payload:v1',
  summary: { ready_for_external_upload: true, validation_error_count: 0 },
  evidence: { input_hash: 'hash-abc' },
  lines: [{ employee_name: 'Emp A', super_cents: 12000 }],
};

function fakeSupabase(scenario: Scenario, calls: Call[]): typeof fetch {
  return (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return (async () => {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      const text = method === 'GET' || method === 'HEAD' ? '' : await request.text();
      calls.push({ method, path: url.pathname, body: text ? JSON.parse(text) : null });
      const wantsObject = (request.headers.get('accept') ?? '').includes('vnd.pgrst.object');
      const rows = (data: Record<string, unknown>[]) =>
        wantsObject ? Response.json(data[0] ?? null) : Response.json(data);

      if (url.pathname === '/auth/v1/user') {
        return Response.json({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'a@b.test' });
      }
      if (url.pathname === '/rest/v1/organization_memberships') {
        return rows([
          {
            role_enum: scenario.role ?? 'admin',
            accepted_at: scenario.acceptedAt === undefined ? '2026-01-01T00:00:00Z' : scenario.acceptedAt,
          },
        ]);
      }
      if (url.pathname === '/rest/v1/super_batches' && method === 'GET') {
        return rows([
          {
            id: BATCH_ID,
            organization_id: ORG_ID,
            status: scenario.batchStatus ?? 'approved',
            total_super_cents: 12000,
            line_count: 1,
            fy_start_year: 2026,
            quarter: 1,
            transport_payload_hash: scenario.batchStatus === 'file_prepared' ? 'hash-abc' : null,
          },
        ]);
      }
      if (url.pathname === '/rest/v1/super_batches' && method === 'PATCH') {
        const body = JSON.parse(text) as { status: string };
        return rows([{ id: BATCH_ID, status: body.status }]);
      }
      if (url.pathname === '/rest/v1/rpc/is_action_approved') return Response.json(scenario.approved ?? true);
      if (url.pathname === '/rest/v1/rpc/request_approval') return Response.json('approval-1');
      if (url.pathname === '/rest/v1/rpc/build_superstream_payload') return Response.json(PAYLOAD);
      return new Response(JSON.stringify({ message: `unexpected ${method} ${url.pathname}` }), { status: 500 });
    })();
  };
}

async function send(scenario: Scenario = {}) {
  Deno.env.set('SUPABASE_URL', SUPABASE_URL);
  Deno.env.set('SUPABASE_ANON_KEY', 'anon-key');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeSupabase(scenario, calls);
  try {
    const { handleSuperBatchSendRequest } = await import('./index.ts');
    const response = await handleSuperBatchSendRequest(
      new Request('http://localhost/super-batch-send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer user-session-jwt' },
        body: JSON.stringify({ organization_id: ORG_ID, super_batch_id: BATCH_ID }),
      }),
    );
    const patches = calls.filter((c) => c.method === 'PATCH' && c.path === '/rest/v1/super_batches');
    return { status: response.status, json: await response.json(), patches };
  } finally {
    globalThis.fetch = realFetch;
  }
}

Deno.test('an approved batch is recorded as file_prepared, never sent', async () => {
  const { status, json, patches } = await send();
  assertEquals(status, 200, JSON.stringify(json));
  assertEquals(patches.length, 1);
  const update = patches[0]?.body as Record<string, unknown>;
  assertEquals(update.status, 'file_prepared');
  assertEquals(update.transport_mode, 'clearing_house_file');
  assertEquals(update.transport_payload_hash, 'hash-abc');
  assertEquals((update.transport_response as Record<string, unknown>).live_dispatch_enabled, false);
  assertEquals((update.transport_response as Record<string, unknown>).manual_upload_required, true);

  assertEquals(json.status, 'file_prepared');
  assertEquals(json.file_prepared, true);
  assertEquals(json.manual_upload_required, true);
  assertEquals(json.sent, undefined);
  assertEquals(json.payload.schema_version, 'build_superstream_payload:v1');
});

Deno.test('a prepared batch hands the same file back without changing its status', async () => {
  const { status, json, patches } = await send({ batchStatus: 'file_prepared' });
  assertEquals(status, 200, JSON.stringify(json));
  assertEquals(patches.length, 0);
  assertEquals(json.already_prepared, true);
  assertEquals(json.status, 'file_prepared');
  assertEquals(json.payload_hash, 'hash-abc');
  assertEquals(json.payload.schema_version, 'build_superstream_payload:v1');
});

Deno.test('a batch already recorded as sent is left alone', async () => {
  const { status, json, patches } = await send({ batchStatus: 'sent' });
  assertEquals(status, 200);
  assertEquals(patches.length, 0);
  assertEquals(json.already_sent, true);
});

Deno.test('without approval nothing is prepared and an approval is requested', async () => {
  const { status, json, patches } = await send({ approved: false });
  assertEquals(status, 403);
  assertEquals(patches.length, 0);
  assertEquals(json.approval_id, 'approval-1');
  assertMatch(json.error, /approval required/i);
});

Deno.test('the admin-or-owner check still holds: viewers, accountants and pending invites are refused', async () => {
  for (const scenario of [
    { role: 'viewer' },
    { role: 'employee' },
    { role: 'accountant' },
    { role: 'admin', acceptedAt: null },
  ]) {
    const { status, patches } = await send(scenario);
    assertEquals(status, 403, JSON.stringify(scenario));
    assertEquals(patches.length, 0);
  }
  const owner = await send({ role: 'owner' });
  assertEquals(owner.status, 200);
});

Deno.test('the source keeps the 5ba716b role check and never writes status "sent"', async () => {
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  assertMatch(
    source,
    /authorizeOrgMember\(user\.id, organization_id, supabaseOrgAccessDeps\(admin, serviceKey\), "admin"\);/,
  );
  assert(!/status:\s*"sent"/.test(source), 'super-batch-send still writes status "sent"');
});
