import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

interface FunctionInventory {
  local_function_count: number;
  live_observed_count: number;
  local_only: string[];
  functions: { name: string; deploy_by_default: boolean }[];
}

function readRepoFile(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

function listFiles(relativePath: string, extension: string): string[] {
  return readdirSync(join(root, relativePath), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name)
    .sort();
}

describe('deployment docs reconciliation', () => {
  it('keeps the migration baseline runbook aligned with the local migration ceiling', () => {
    const migrations = listFiles('supabase/migrations', '.sql');
    const latestMigration = migrations[migrations.length - 1];
    const runbook = readRepoFile('docs/MIGRATION_BASELINE_RUNBOOK.md');
    const p005Runbook = readRepoFile('docs/DEPLOY_PROOF_P0-05.md');

    expect(latestMigration).toBe('20261003120000_money_table_write_roles.sql');
    expect(runbook).toContain(`Current local ceiling:** \`${latestMigration}\``);
    expect(runbook).toMatch(/supabase db push --linked --dry-run/);
    expect(runbook).toMatch(/Rollback \/ Abort/);
    expect(runbook).toMatch(/COMPLIANCE_BACKLOG/);

    expect(p005Runbook).toContain('ceiling is now `20261003120000_money_table_write_roles.sql`');
    expect(p005Runbook).toContain('`0199`-`0207`');
    expect(p005Runbook).toContain('Only redeploy after `0199` has applied');
    expect(p005Runbook).toContain('production Pages deployed and signed-in P0-05 proof complete');
    expect(p005Runbook).toContain(
      'The only remaining finish-line tracker TODOs are the externally gated ATO',
    );
    expect(p005Runbook).not.toMatch(/There is no `0208`\/`0209`\/`0210`/);
  });

  it('keeps legacy AR-table FK indexes guarded for consolidated live schemas', () => {
    const fkIndexes = readRepoFile('supabase/migrations/0202_fk_indexes.sql');

    expect(fkIndexes).toMatch(/to_regclass\('public\.customer_invoices'\)/);
    expect(fkIndexes).toMatch(/customer_invoices_created_by_idx/);
    expect(fkIndexes).toMatch(/Skipping customer_invoices FK index/);
    expect(fkIndexes).toMatch(/invoices_created_by_idx/);
  });

  it('keeps edge-function inventory in sync with local directories and live-observed holdbacks', () => {
    const inventory = JSON.parse(
      readRepoFile('supabase/functions-inventory.json'),
    ) as FunctionInventory;
    const localFunctions = readdirSync(join(root, 'supabase/functions'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory() && entry.name !== '_shared')
      .map((entry) => entry.name)
      .sort();
    const inventoryNames = inventory.functions.map((fn) => fn.name).sort();
    const holdbacks = inventory.functions
      .filter((fn) => !fn.deploy_by_default)
      .map((fn) => fn.name)
      .sort();

    expect(inventory.local_function_count).toBe(localFunctions.length);
    expect(inventory.live_observed_count).toBe(
      inventory.functions.filter((fn) => fn.deploy_by_default).length,
    );
    expect(inventoryNames).toEqual(localFunctions);
    expect(inventory.local_only.sort()).toEqual(holdbacks);

    const inventoryDoc = readRepoFile('docs/FUNCTION_INVENTORY.md');
    for (const functionName of localFunctions) {
      expect(inventoryDoc).toContain(`\`${functionName}\``);
    }
  });

  it('keeps every root docs file listed in the docs index', () => {
    const index = readRepoFile('docs/INDEX.md');
    const docs = listFiles('docs', '.md').map((name) => `docs/${basename(name)}`);

    for (const docPath of docs) {
      expect(index).toContain(`\`${docPath}\``);
    }
  });

  it('keeps ATO lodgement as the explicit external TODO list', () => {
    const tracker = readRepoFile('docs/FINISH_LINE_TRACKER.md');
    const backlog = readRepoFile('docs/COMPLIANCE_BACKLOG.md');

    for (const item of ['P2-LODGE-2', 'P2-LODGE-3', 'P2-LODGE-4']) {
      expect(tracker).toMatch(new RegExp(`- \\[ \\] ${item}`));
      expect(backlog).toMatch(new RegExp(`- \\[ \\] \`${item}\``));
    }

    expect(backlog).toMatch(/external-gated TODO list/);
    expect(backlog).toMatch(/not live ATO electronic\s+transmission/);
  });

  it('publishes a manual staging deploy workflow with dry-run and inventory gates', () => {
    const workflow = readRepoFile('.github/workflows/staging-deploy.yml');

    expect(workflow).toMatch(/workflow_dispatch/);
    expect(workflow).toMatch(/npm run test:accounting/);
    expect(workflow).toMatch(/deploymentDocsReconciliation\.test\.ts/);
    expect(workflow).toMatch(/supabase db push --linked --dry-run/);
    expect(workflow).toMatch(/functions-inventory\.json/);
    expect(workflow).toMatch(/deploy_by_default/);
  });
});
