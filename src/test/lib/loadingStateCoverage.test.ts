import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPLACED_LOADING_COPY: Record<string, RegExp[]> = {
  'src/components/settings/BusinessProfileForm.tsx': [/Loading profile/],
  'src/components/settings/OrgProfile.tsx': [/>Loading org/],
  'src/components/settings/BankConnect.tsx': [/>\s*Loading…\s*</],
  'src/components/settings/GmailConnect.tsx': [/>\s*Loading…\s*</],
  'src/components/settings/XeroConnect.tsx': [/>\s*Loading…\s*</],
  'src/components/settings/ConnectorApiKeys.tsx': [/>\s*Loading\.\.\.\s*</],
  'src/pages/onboarding/Triage.tsx': [/>Loading triage list/],
  'src/pages/MyActivity.tsx': [/Loading sessions/],
  'src/pages/Team.tsx': [/Loading members/],
  'src/pages/reports/TaxReturn.tsx': [/Loading draft return/],
  'src/pages/Approvals.tsx': [/>\s*Loading…\s*</],
  'src/pages/LegalHorizon.tsx': [/>\s*Loading…\s*</],
  'src/pages/Quality.tsx': [/Checking duplicates/],
  'src/components/DocumentPreviewModal.tsx': [/>Loading document/],
  'src/components/BankTransactionCodingQueue.tsx': [/>Loading coding queue/],
  'src/components/AllocationSplitButton.tsx': [/>Loading splits/],
  'src/pages/AuditLog.tsx': [
    />Loading correspondence/,
    />Loading drafts/,
    />Loading audit events/,
  ],
  'src/pages/Payroll.tsx': [/>Loading batch/],
  'src/pages/reports/Bas.tsx': [/>Loading worksheet/],
  'src/pages/Settings.tsx': [/>Loading…/],
  'src/components/OrgSelector.tsx': [/>Loading orgs/],
  'src/pages/BillDetail.tsx': [/>Loading preview/, />Loading…/],
};

describe('loading state coverage', () => {
  it('keeps the audited auxiliary loading states on skeletons', () => {
    const offenders = Object.entries(REPLACED_LOADING_COPY).flatMap(([file, patterns]) => {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      return patterns.some((pattern) => pattern.test(source)) ? [file] : [];
    });

    expect(offenders).toEqual([]);
  });
});
