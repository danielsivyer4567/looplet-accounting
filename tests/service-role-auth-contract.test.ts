import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

const serviceRoleBypassFunctions = [
  'bills-extract',
  'subscriptions-detect',
  'subscriptions-autoconfirm',
] as const;

describe('service-role auth source contracts', () => {
  it('does not trust self-asserted JWT service_role claims', () => {
    for (const fn of serviceRoleBypassFunctions) {
      const source = readFileSync(join(root, 'supabase/functions', fn, 'index.ts'), 'utf8');

      expect(source).toMatch(/isExactServiceRoleBearer/);
      expect(source).not.toMatch(/payload\?\.\s*role\s*===\s*['"]service_role['"]/);
    }
  });
});
