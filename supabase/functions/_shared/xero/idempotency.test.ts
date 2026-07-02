import { assertEquals, assertMatch, assertNotEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveXeroIdempotencyKey } from './idempotency.ts';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.test('resolveXeroIdempotencyKey accepts a valid supplied UUID after trimming', async () => {
  const supplied = '  123e4567-e89b-12d3-a456-426614174000  ';
  const result = await resolveXeroIdempotencyKey(supplied, ['xero', 'bill', 'org-1', 'bill-1']);

  assertEquals(result, '123e4567-e89b-12d3-a456-426614174000');
});

Deno.test('resolveXeroIdempotencyKey derives a deterministic UUID-shaped fallback', async () => {
  const first = await resolveXeroIdempotencyKey(undefined, ['xero', 'bill', 'org-1', 'bill-1']);
  const second = await resolveXeroIdempotencyKey('', ['xero', 'bill', 'org-1', 'bill-1']);
  const different = await resolveXeroIdempotencyKey(undefined, ['xero', 'bill', 'org-1', 'bill-2']);

  assertEquals(first, second);
  assertNotEquals(first, different);
  assertMatch(first, UUID_RE);
});

Deno.test('resolveXeroIdempotencyKey ignores malformed supplied keys and falls back stably', async () => {
  const malformed = await resolveXeroIdempotencyKey('not-a-uuid', [
    'xero',
    'contact',
    'org-1',
    'acme supplies',
  ]);
  const fallback = await resolveXeroIdempotencyKey(undefined, [
    'xero',
    'contact',
    'org-1',
    'acme supplies',
  ]);

  assertEquals(malformed, fallback);
  assertMatch(malformed, UUID_RE);
});
