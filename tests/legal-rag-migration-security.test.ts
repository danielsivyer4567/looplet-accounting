import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const grantRepairMigration = readFileSync(
  join(root, 'supabase/migrations/0195_harden_legal_reference_table_grants.sql'),
  'utf8',
);

const legalReferenceTables = [
  'legal_corpus',
  'legal_sources',
  'legal_change_events',
  'legal_horizon',
] as const;

describe('legal RAG reference table privilege posture', () => {
  it('revokes client write privileges and keeps authenticated read-only access', () => {
    for (const table of legalReferenceTables) {
      expect(grantRepairMigration).toMatch(
        new RegExp(
          `revoke all on table public\\.${table} from public,\\s*anon,\\s*authenticated;`,
          'i',
        ),
      );
      expect(grantRepairMigration).toMatch(
        new RegExp(`grant select on table public\\.${table} to authenticated;`, 'i'),
      );
      expect(grantRepairMigration).toMatch(
        new RegExp(`grant all on table public\\.${table} to service_role;`, 'i'),
      );
      expect(grantRepairMigration).not.toMatch(
        new RegExp(
          `grant\\s+select\\s*,\\s*insert\\s*,\\s*update(?:\\s*,\\s*delete)?\\s+on\\s+(?:table\\s+)?public\\.${table}\\s+to\\s+authenticated`,
          'i',
        ),
      );
      expect(grantRepairMigration).not.toMatch(
        new RegExp(`grant\\s+.*on\\s+(?:table\\s+)?public\\.${table}\\s+to\\s+anon`, 'i'),
      );
    }
    expect(grantRepairMigration).toMatch(/notify pgrst,\s*'reload schema';/i);
  });
});
