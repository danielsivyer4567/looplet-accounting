import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isExactSecret, isExactServiceRoleBearer } from './serviceRole.ts';

Deno.test('isExactServiceRoleBearer only accepts the exact configured service key', () => {
  assertEquals(isExactServiceRoleBearer('Bearer service-secret', 'service-secret'), true);
  assertEquals(isExactServiceRoleBearer('service-secret', 'service-secret'), true);
  assertEquals(isExactServiceRoleBearer('Bearer service-secret ', 'service-secret'), true);
  assertEquals(isExactServiceRoleBearer('Bearer other-secret', 'service-secret'), false);
  assertEquals(isExactServiceRoleBearer(null, 'service-secret'), false);
});

Deno.test('isExactServiceRoleBearer does not trust self-asserted JWT role payloads', () => {
  const forgedPayload = btoa(JSON.stringify({ role: 'service_role' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const forgedJwt = `header.${forgedPayload}.signature`;

  assertEquals(isExactServiceRoleBearer(`Bearer ${forgedJwt}`, 'service-secret'), false);
});

Deno.test('isExactSecret only accepts exact query secrets', () => {
  assertEquals(isExactSecret('cron-secret', 'cron-secret'), true);
  assertEquals(isExactSecret('cron-secret ', 'cron-secret'), false);
  assertEquals(isExactSecret(null, 'cron-secret'), false);
});
