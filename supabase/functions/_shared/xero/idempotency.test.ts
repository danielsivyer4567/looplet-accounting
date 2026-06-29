// Tests for the STABLE Xero Idempotency-Key derivation + retry backoff (P1-08).
//
// Run: deno test supabase/functions/_shared/xero/idempotency.test.ts
//
// Core invariant (the audit's duplicate-invoice fix): the same source entity
// must yield the SAME Xero Idempotency-Key on every retry, so Xero dedupes the
// POST server-side and a retry after a timeout/unknown-result never creates a
// duplicate ACCPAY/ACCREC. Different entities/kinds/orgs must NOT collide.

import {
  assert,
  assertEquals,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  computeNextAttemptAt,
  deriveXeroIdempotencyKey,
  pushKeySeed,
} from './idempotency.ts';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const BILL_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BILL_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

Deno.test('same source entity -> same idempotency key across retries', async () => {
  const k1 = await deriveXeroIdempotencyKey(ORG_A, 'bill', BILL_1);
  const k2 = await deriveXeroIdempotencyKey(ORG_A, 'bill', BILL_1);
  const k3 = await deriveXeroIdempotencyKey(ORG_A, 'bill', BILL_1);
  // Three "attempts" of the same push must all replay the identical Xero header.
  assertEquals(k1, k2);
  assertEquals(k2, k3);
});

Deno.test('derived key is a syntactically valid v5-shaped UUID', async () => {
  const k = await deriveXeroIdempotencyKey(ORG_A, 'invoice', BILL_1);
  assert(UUID_RE.test(k), `expected v5-shaped UUID, got: ${k}`);
});

Deno.test('different record_id -> different key', async () => {
  const k1 = await deriveXeroIdempotencyKey(ORG_A, 'bill', BILL_1);
  const k2 = await deriveXeroIdempotencyKey(ORG_A, 'bill', BILL_2);
  assertNotEquals(k1, k2);
});

Deno.test('different kind (bill vs invoice) for same id -> different key', async () => {
  // A bill and an invoice can share a UUID across tables; they must not collide.
  const kBill = await deriveXeroIdempotencyKey(ORG_A, 'bill', BILL_1);
  const kInvoice = await deriveXeroIdempotencyKey(ORG_A, 'invoice', BILL_1);
  assertNotEquals(kBill, kInvoice);
});

Deno.test('different org -> different key (no cross-tenant collision)', async () => {
  const kA = await deriveXeroIdempotencyKey(ORG_A, 'bill', BILL_1);
  const kB = await deriveXeroIdempotencyKey(ORG_B, 'bill', BILL_1);
  assertNotEquals(kA, kB);
});

Deno.test('seed format is the stable v1 contract', () => {
  // Pinned: changing this re-keys every entity and re-opens the duplicate bug.
  assertEquals(pushKeySeed(ORG_A, 'bill', BILL_1), `xero:v1:${ORG_A}:bill:${BILL_1}`);
});

Deno.test('computeNextAttemptAt: 429 backs off at least the rate-limit window', () => {
  const now = new Date('2026-06-29T00:00:00.000Z');
  const next = computeNextAttemptAt(429, 1, 3, now);
  assert(next, 'expected a backoff timestamp');
  // >= 60s after now for the first 429.
  assert(new Date(next).getTime() - now.getTime() >= 60_000);
});

Deno.test('computeNextAttemptAt: 429 grows with attempt count', () => {
  const now = new Date('2026-06-29T00:00:00.000Z');
  const first = computeNextAttemptAt(429, 1, 3, now);
  const second = computeNextAttemptAt(429, 2, 3, now);
  assert(first, 'expected a first backoff timestamp');
  assert(second, 'expected a second backoff timestamp');
  assert(new Date(second).getTime() > new Date(first).getTime());
});

Deno.test('computeNextAttemptAt: 401 schedules a soon-ish re-auth retry', () => {
  const now = new Date('2026-06-29T00:00:00.000Z');
  const next = computeNextAttemptAt(401, 1, 3, now);
  assert(next, 'expected a backoff timestamp for 401');
  const delta = new Date(next).getTime() - now.getTime();
  // Re-auth is cheap: retry within a minute but not instantly.
  assert(delta > 0 && delta <= 60_000);
});

Deno.test('computeNextAttemptAt: transient/5xx uses capped exponential backoff', () => {
  const now = new Date('2026-06-29T00:00:00.000Z');
  const next1 = computeNextAttemptAt(500, 1, 5, now);
  const next2 = computeNextAttemptAt(500, 2, 5, now);
  const nextBig = computeNextAttemptAt(500, 9, 99, now);
  assert(next1, 'expected first transient backoff timestamp');
  assert(next2, 'expected second transient backoff timestamp');
  assert(nextBig, 'expected capped transient backoff timestamp');
  const d1 = new Date(next1).getTime() - now.getTime();
  const d2 = new Date(next2).getTime() - now.getTime();
  const dBig = new Date(nextBig).getTime() - now.getTime();
  assert(d2 > d1, 'backoff should grow');
  assert(dBig <= 300_000, 'backoff capped at 5 minutes');
});

Deno.test('computeNextAttemptAt: returns null once attempt cap is hit', () => {
  // No further auto-retry is owed at/above max_attempts.
  assertEquals(computeNextAttemptAt(500, 3, 3), null);
  assertEquals(computeNextAttemptAt(429, 4, 3), null);
});
