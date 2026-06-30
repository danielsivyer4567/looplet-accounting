import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migration = readFileSync(
  join(root, 'supabase/migrations/20260701062500_harden_notify_org_guard.sql'),
  'utf8',
);

describe('notify RPC org guard contract', () => {
  it('keeps notify definer-scoped but enforces org membership for authenticated callers', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.notify/);
    expect(migration).toMatch(/SECURITY DEFINER/);
    expect(migration).toMatch(/SET search_path = pg_catalog, public/);
    expect(migration).toMatch(/v_caller uuid := auth\.uid\(\)/);
    expect(migration).toMatch(/v_role text := COALESCE\(auth\.role\(\), ''\)/);
    expect(migration).toMatch(/IF v_role <> 'service_role' THEN/);
    expect(migration).toMatch(/m\.organization_id = p_org/);
    expect(migration).toMatch(/m\.user_id = v_caller/);
    expect(migration).toMatch(/m\.accepted_at IS NOT NULL/);
    expect(migration).toMatch(/target_member\.organization_id = p_org/);
    expect(migration).toMatch(/target_member\.user_id = p_user_id/);
    expect(migration).toMatch(/notification target user is not a member/);
  });

  it('does not allow anonymous execute through PUBLIC grants', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.notify[\s\S]*FROM PUBLIC, anon/);
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.notify[\s\S]*TO service_role, authenticated/,
    );
  });
});
