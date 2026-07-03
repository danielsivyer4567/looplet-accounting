import {
  assert,
  assertEquals,
  assertFalse,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  classifyWebhookAction,
  constantTimeEqual,
  dedupeTransactions,
  deriveWebhookEventId,
  extractConnectionId,
  isDuplicateKeyError,
  parseWebhookEventType,
  stableStringify,
  summariseSyncRun,
  verifyWebhookSignature,
} from './durability.ts';

// ---------------------------------------------------------------------------
// deriveWebhookEventId — stable id so replays dedupe
// ---------------------------------------------------------------------------
Deno.test('deriveWebhookEventId prefers an explicit provider id', () => {
  assertEquals(deriveWebhookEventId({ id: 'evt_123', type: 'transactions.updated' }), 'evt_123');
  assertEquals(
    deriveWebhookEventId({ eventId: 'evt_456', data: { id: 'should_not_win' } }),
    'evt_456',
  );
  assertEquals(deriveWebhookEventId({ data: { id: 'evt_data', type: 'x' } }), 'evt_data');
});

Deno.test('deriveWebhookEventId derives a STABLE id when no provider id exists', () => {
  // Same logical payload, different key order → same derived id (replay-safe).
  const a = deriveWebhookEventId({ type: 'transactions.updated', data: { connectionId: 'c1' } });
  const b = deriveWebhookEventId({ data: { connectionId: 'c1' }, type: 'transactions.updated' });
  assertEquals(a, b);
  assert(a.startsWith('derived:'), 'derived id should be namespaced');

  // A genuinely different event must NOT collide.
  const c = deriveWebhookEventId({ type: 'transactions.updated', data: { connectionId: 'c2' } });
  assert(a !== c, 'different connection should yield a different derived id');
});

Deno.test('parseWebhookEventType + extractConnectionId tolerate Basiq shape variance', () => {
  assertEquals(parseWebhookEventType({ type: 'connection.invalid' }), 'connection.invalid');
  assertEquals(parseWebhookEventType({ data: { type: 'connection.updated' } }), 'connection.updated');
  assertEquals(parseWebhookEventType({}), 'unknown');

  assertEquals(extractConnectionId({ data: { connectionId: 'conn-1' } }), 'conn-1');
  assertEquals(extractConnectionId({ data: { connection: { id: 'conn-2' } } }), 'conn-2');
  assertEquals(extractConnectionId({ data: { id: 'conn-3' } }), 'conn-3');
  assertEquals(extractConnectionId({ type: 'x' }), null);
});

// ---------------------------------------------------------------------------
// classifyWebhookAction — routing decisions
// ---------------------------------------------------------------------------
Deno.test('classifyWebhookAction maps Basiq events to actions', () => {
  assertEquals(classifyWebhookAction('connection.invalid'), 'mark_revoked');
  assertEquals(classifyWebhookAction('connection.expired'), 'mark_expired');
  assertEquals(classifyWebhookAction('transactions.updated'), 'sync');
  assertEquals(classifyWebhookAction('connection.updated'), 'sync');
  assertEquals(classifyWebhookAction('connection.error'), 'mark_expired');
  assertEquals(classifyWebhookAction('unknown'), 'ignore');
  assertEquals(classifyWebhookAction(''), 'ignore');
  assertEquals(classifyWebhookAction('account.something'), 'touch');
});

// ---------------------------------------------------------------------------
// dedupeTransactions — in-batch idempotency
// ---------------------------------------------------------------------------
Deno.test('dedupeTransactions collapses duplicate external ids, keeping first', () => {
  const { unique, duplicates } = dedupeTransactions([
    { id: 't1', amount: '1' },
    { id: 't2', amount: '2' },
    { id: 't1', amount: '1-dupe' }, // duplicate of t1
    { id: 't3', amount: '3' },
    { id: 't2', amount: '2-dupe' }, // duplicate of t2
  ]);
  assertEquals(duplicates, 2);
  assertEquals(unique.map((t) => t.id), ['t1', 't2', 't3']);
  // First occurrence is kept (not the later dupe).
  assertEquals(unique[0].amount, '1');
});

Deno.test('dedupeTransactions passes through rows without an external id', () => {
  const { unique, duplicates } = dedupeTransactions([
    { id: null, amount: 'a' },
    { id: undefined, amount: 'b' },
    { id: 't1', amount: 'c' },
  ]);
  assertEquals(duplicates, 0);
  assertEquals(unique.length, 3);
});

Deno.test('dedupeTransactions is itself idempotent (re-running yields no new duplicates)', () => {
  const batch = [{ id: 't1' }, { id: 't1' }, { id: 't2' }];
  const first = dedupeTransactions(batch);
  const second = dedupeTransactions(first.unique);
  assertEquals(first.duplicates, 1);
  assertEquals(second.duplicates, 0); // already deduped → stable
  assertEquals(second.unique.map((t) => t.id), ['t1', 't2']);
});

// ---------------------------------------------------------------------------
// isDuplicateKeyError — 23505 recognition (dedupe, not failure)
// ---------------------------------------------------------------------------
Deno.test('isDuplicateKeyError recognises Postgres unique violations', () => {
  assert(isDuplicateKeyError({ code: '23505' }));
  assert(isDuplicateKeyError({ message: 'duplicate key value violates unique constraint' }));
  assertFalse(isDuplicateKeyError({ code: '23503' })); // FK violation
  assertFalse(isDuplicateKeyError(null));
  assertFalse(isDuplicateKeyError(undefined));
});

// ---------------------------------------------------------------------------
// summariseSyncRun — run status derivation
// ---------------------------------------------------------------------------
Deno.test('summariseSyncRun derives success/partial/error and totals', () => {
  assertEquals(
    summariseSyncRun([
      { inserted: 3, deduped: 1, skipped: 0 },
      { inserted: 2, deduped: 0, skipped: 1 },
    ]),
    { status: 'success', inserted: 5, deduped: 1, skipped: 1, errors: 0 },
  );

  assertEquals(
    summariseSyncRun([
      { inserted: 3, deduped: 0, skipped: 0 },
      { inserted: 0, deduped: 0, skipped: 0, error: 'boom' },
    ]).status,
    'partial',
  );

  assertEquals(
    summariseSyncRun([
      { inserted: 0, deduped: 0, skipped: 0, error: 'a' },
      { inserted: 0, deduped: 0, skipped: 0, error: 'b' },
    ]).status,
    'error',
  );

  // No connections synced → vacuously success (nothing failed).
  assertEquals(summariseSyncRun([]).status, 'success');
});

// ---------------------------------------------------------------------------
// stableStringify / constantTimeEqual
// ---------------------------------------------------------------------------
Deno.test('stableStringify sorts keys deterministically', () => {
  assertEquals(
    stableStringify({ b: 1, a: { d: 4, c: 3 } }),
    stableStringify({ a: { c: 3, d: 4 }, b: 1 }),
  );
  assertEquals(stableStringify([3, 1, 2]), '[3,1,2]'); // arrays keep order
});

Deno.test('constantTimeEqual is value-correct', () => {
  assert(constantTimeEqual('abc', 'abc'));
  assertFalse(constantTimeEqual('abc', 'abd'));
  assertFalse(constantTimeEqual('abc', 'abcd')); // length mismatch
  assertFalse(constantTimeEqual('', 'x'));
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature — HMAC + documented URL-token fallback
// ---------------------------------------------------------------------------
Deno.test('verifyWebhookSignature FAILS CLOSED when no auth is configured', async () => {
  const r = await verifyWebhookSignature({
    rawBody: '{}',
    signatureHeader: null,
    hmacSecret: null,
    urlToken: 'whatever',
    expectedUrlToken: null, // not configured
  });
  assertFalse(r.ok);
  assertEquals(r.reason, 'verify_token_not_configured');
});

Deno.test('verifyWebhookSignature accepts a matching URL token', async () => {
  const ok = await verifyWebhookSignature({
    rawBody: '{}',
    signatureHeader: null,
    hmacSecret: null,
    urlToken: 'shared-secret',
    expectedUrlToken: 'shared-secret',
  });
  assert(ok.ok);
  assertEquals(ok.method, 'url_token');

  const bad = await verifyWebhookSignature({
    rawBody: '{}',
    signatureHeader: null,
    hmacSecret: null,
    urlToken: 'wrong',
    expectedUrlToken: 'shared-secret',
  });
  assertFalse(bad.ok);
  assertEquals(bad.reason, 'url_token_mismatch');
});

Deno.test('verifyWebhookSignature verifies HMAC-SHA256 when provider signs', async () => {
  const secret = 'hmac-key';
  const body = '{"type":"transactions.updated"}';
  // Compute the expected signature the same way the verifier does.
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const hex = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');

  const ok = await verifyWebhookSignature({
    rawBody: body,
    signatureHeader: `sha256=${hex}`, // prefixed form
    hmacSecret: secret,
    urlToken: null,
    expectedUrlToken: null,
  });
  assert(ok.ok);
  assertEquals(ok.method, 'hmac');

  const tampered = await verifyWebhookSignature({
    rawBody: body + 'tamper',
    signatureHeader: `sha256=${hex}`,
    hmacSecret: secret,
    urlToken: null,
    expectedUrlToken: null,
  });
  assertFalse(tampered.ok);
  assertEquals(tampered.reason, 'hmac_mismatch');
});
