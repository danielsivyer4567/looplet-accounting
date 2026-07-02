import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = readFileSync(join(root, 'supabase/functions/coding-classifier/index.ts'), 'utf8');
const intakeRoutingApply = readFileSync(
  join(root, 'supabase/functions/intake-routing-apply/index.ts'),
  'utf8',
);
const codingQueueHook = readFileSync(join(root, 'src/hooks/useCodingQueue.ts'), 'utf8');
const fixedAssetsHook = readFileSync(join(root, 'src/hooks/useFixedAssets.ts'), 'utf8');
const capitalPurchaseMigration = readFileSync(
  join(root, 'supabase/migrations/0094_capital_purchase_detect.sql'),
  'utf8',
);

describe('coding-classifier source contract', () => {
  it('maps common intake categories to the seeded Looplet COA codes before stale Xero codes', () => {
    const requiredMappings = {
      materials: '5000',
      subcontractor: '5100',
      subscriptions_saas: '6400',
      telephone_internet: '6300',
      insurance: '6200',
      professional_fees: '6500',
      bank_fees: '6600',
      fuel: '6100',
      motor_vehicle: '6100',
    } as const;

    for (const [category, accountCode] of Object.entries(requiredMappings)) {
      expect(source).toContain(`${category}: "${accountCode}"`);
    }

    expect(source).toContain('DEFAULT_CATEGORY_ACCOUNT_CODES[rule.category_code]');
    expect(source).toContain('accountOverride || defaultAccountCode || cat?.xero_account_code');
    expect(source).toContain('default_category_coa');
  });

  it('routes extracted bills into coding, review, capital detection, and GL posting paths', () => {
    expect(intakeRoutingApply).toMatch(/await runCodingClassify\(supabaseUrl, serviceKey, billId\)/);
    expect(intakeRoutingApply).toMatch(/functions\/v1\/coding-classifier/);
    expect(intakeRoutingApply).toMatch(/coding-classifier failed/);
    expect(intakeRoutingApply).toMatch(/ledger_handoff:\s*ledgerHandoff/);
    expect(intakeRoutingApply).toMatch(/ledger_handoffs:\s*ledgerHandoffs/);
    expect(intakeRoutingApply).toMatch(/ledger_path:\s*'coding_classifier_post_journal_entry'/);

    expect(source).toMatch(/const suggestionId = await upsertSuggestion\(admin, typedBill, classification, "needs_review"\)/);
    expect(source).toMatch(/status = "auto_posted"/);
    expect(source).toMatch(/await setRationaleStatus\(admin, suggestionId, "auto_posted"/);
    expect(source).toMatch(/orgClient\.rpc\("post_journal_entry", \{ p_entry_id: entryId \}\)/);

    expect(source).toMatch(/admin\.rpc\("detect_capital_purchases"/);
    expect(source).toMatch(/admin\.rpc\("propose_capitalisation"/);
    expect(source).toMatch(/capital_purchase: \{ candidate: true, fixed_asset_id: capital\.fixedAssetId \}/);
    expect(source).toMatch(/capital_purchase_candidate: capital\.isCandidate/);
  });

  it('routes human AP review decisions back through the journal posting path', () => {
    expect(codingQueueHook).toMatch(/from\('coding_review_queue'\)/);
    expect(codingQueueHook).toMatch(/supabase\.functions\.invoke\('coding-classifier'/);
    expect(codingQueueHook).toMatch(/decision:\s*'accept'/);
    expect(codingQueueHook).toMatch(/decision:\s*'override'/);

    expect(source).toMatch(/async function handleDecision/);
    expect(source).toMatch(/postBillJournal\(admin, supabaseUrl, anonKey, bill, accountCode, true\)/);
    expect(source).toMatch(/const newStatus = decision === "override" \? "overridden" : "accepted"/);
    expect(source).toMatch(/journal_entry_id: result\.journalEntryId/);
    expect(source).toMatch(/return json\(\{\s*ok: true,[\s\S]*journal_entry_id: result\.journalEntryId/);
  });

  it('turns capital-purchase candidates into depreciation schedules behind a human confirm gate', () => {
    expect(source).toMatch(/detectAndProposeCapitalAsset/);
    expect(source).toMatch(/admin\.rpc\("detect_capital_purchases"/);
    expect(source).toMatch(/admin\.rpc\("propose_capitalisation"/);
    expect(source).toMatch(/A capital-purchase candidate NEVER auto-posts as a period expense/);

    expect(capitalPurchaseMigration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.propose_capitalisation/i,
    );
    expect(capitalPurchaseMigration).toMatch(/INSERT INTO public\.fixed_assets/i);
    expect(capitalPurchaseMigration).toMatch(/status[\s\S]*'proposed'/i);
    expect(capitalPurchaseMigration).toMatch(/INSERT INTO public\.depreciation_schedules/i);
    expect(capitalPurchaseMigration).toMatch(/fixed_assets_source_bill_uniq/i);

    expect(fixedAssetsHook).toMatch(/from\('depreciation_schedules'\)/);
    expect(fixedAssetsHook).toMatch(/update\(\{ status: 'active' \}\)/);
    expect(fixedAssetsHook).toMatch(/\.eq\('status', 'proposed'\)/);
    expect(fixedAssetsHook).toMatch(/depreciation[\s\S]*cron[\s\S]*begins posting/);
  });
});
