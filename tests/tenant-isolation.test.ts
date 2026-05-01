import { describe, it, expect, beforeAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Tenant isolation test suite.
 *
 * The single most important invariant of this product:
 *   User A in org A1 must NEVER see ANY data belonging to user B in org B1.
 *
 * If this suite ever goes red on `main`, deploys block until it goes green.
 * No exceptions, no temporary skips, no .only.
 *
 * To run: `npm run test:tenant-isolation`
 *
 * Prerequisites:
 *   - VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY in env
 *   - Two test users seeded with one organization each
 *     (TODO: factory in tests/fixtures/seed.ts — Phase 1.5)
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? '';

describe.skip('tenant isolation (placeholder — Phase 1.5 implements)', () => {
  let userA: SupabaseClient;
  let userB: SupabaseClient;

  beforeAll(() => {
    // TODO Phase 1.5: spin up two anon clients, sign in as A and B,
    //                 seed an organization for each, attach a fixture bill to each.
    userA = createClient(SUPABASE_URL, ANON_KEY);
    userB = createClient(SUPABASE_URL, ANON_KEY);
    // Touch to satisfy noUnusedLocals
    void userA;
    void userB;
  });

  it('user A creates a bill; user B cannot read it', () => {
    // TODO Phase 1.5
    expect(true).toBe(true);
  });

  it('user B cannot upload to user A storage prefix', () => {
    // TODO Phase 1.5
    expect(true).toBe(true);
  });

  it('user B cannot read user A audit log', () => {
    // TODO Phase 1.5
    expect(true).toBe(true);
  });

  it('agency admin sees their sub-accounts but not other agencies', () => {
    // TODO Phase 1.5
    expect(true).toBe(true);
  });
});
