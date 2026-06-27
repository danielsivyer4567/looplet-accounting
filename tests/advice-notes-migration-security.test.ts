import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const tableMigration = readFileSync(
  join(root, 'supabase/migrations/0175_advice_notes.sql'),
  'utf8',
);
const rpcMigration = readFileSync(
  join(root, 'supabase/migrations/0176_advice_notes_rpcs.sql'),
  'utf8',
);

describe('advice_notes migration security posture', () => {
  it('does not grant direct advice_notes mutation privileges to authenticated users', () => {
    expect(tableMigration).toMatch(
      /revoke all on table public\.advice_notes from public,\s*anon,\s*authenticated;/i,
    );
    expect(tableMigration).toMatch(/grant select on public\.advice_notes to authenticated;/i);
    expect(tableMigration).not.toMatch(
      /grant\s+select\s*,\s*insert\s*,\s*update\s*,\s*delete\s+on\s+public\.advice_notes\s+to\s+authenticated/i,
    );
  });

  it('keeps direct table write policies role-gated as a defense in depth', () => {
    expect(tableMigration).toMatch(
      /advice_notes_insert[\s\S]*require_role\(organization_id,\s*'accountant'::public\.org_role\)/i,
    );
    expect(tableMigration).toMatch(
      /advice_notes_update[\s\S]*require_role\(organization_id,\s*'accountant'::public\.org_role\)/i,
    );
    expect(tableMigration).toMatch(
      /advice_notes_delete[\s\S]*require_role\(organization_id,\s*'admin'::public\.org_role\)/i,
    );
  });

  it('role-gates every mutating advice note RPC', () => {
    expect(rpcMigration).toMatch(
      /create_advice_note[\s\S]*require_role\(p_org,\s*'accountant'::public\.org_role\)/i,
    );
    expect(rpcMigration).toMatch(
      /sign_off_advice_note[\s\S]*require_role\(v_org,\s*'accountant'::public\.org_role\)/i,
    );
    expect(rpcMigration).toMatch(
      /dismiss_advice_note[\s\S]*require_role\(v_org,\s*'accountant'::public\.org_role\)/i,
    );
  });
});
