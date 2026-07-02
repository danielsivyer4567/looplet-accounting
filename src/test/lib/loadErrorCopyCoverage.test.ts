import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CHECKED_FILES = [
  'src/components/AllocationQueuePanel.tsx',
  'src/components/CgtEventsPanel.tsx',
  'src/pages/CodingReview.tsx',
  'src/pages/FixedAssets.tsx',
  'src/pages/Dashboard.tsx',
  'src/pages/NewPaymentRun.tsx',
  'src/pages/PaymentRuns.tsx',
  'src/pages/PaymentRunDetail.tsx',
  'src/pages/Quality.tsx',
  'src/pages/SMSF.tsx',
  'src/pages/settings/Registrations.tsx',
  'src/pages/Trusts.tsx',
] as const;

const LEGACY_PATTERNS = [
  /Failed to load:\s*\{error\}/,
  /Failed to load [^:]+:\s*\{error\}/,
  /Error loading [^:]+:\s*\{error\}/,
];

describe('load error copy coverage', () => {
  it('keeps audited secondary pages on categorized resource-specific copy', () => {
    const offenders = CHECKED_FILES.flatMap((file) => {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      return LEGACY_PATTERNS.some((pattern) => pattern.test(source)) ? [file] : [];
    });

    expect(offenders).toEqual([]);
  });
});
