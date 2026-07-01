import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = readFileSync(join(root, 'supabase/functions/coding-classifier/index.ts'), 'utf8');

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
});
