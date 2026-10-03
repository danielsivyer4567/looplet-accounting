import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migration = readFileSync(
  join(root, 'supabase/migrations/0227_stp_secure_tfn_lifecycle.sql'),
  'utf8',
);
const exportStp = readFileSync(
  join(root, 'supabase/functions/payroll-export-stp/index.ts'),
  'utf8',
);
const stpBuilder = readFileSync(join(root, 'supabase/functions/payroll-export-stp/stp.ts'), 'utf8');
const tfnSave = readFileSync(join(root, 'supabase/functions/employee-tfn-save/index.ts'), 'utf8');

describe('0227 STP secure TFN lifecycle', () => {
  it('creates a locked TFN vault and masked status RPC', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.employee_tfn_vault/);
    expect(migration).toMatch(/tfn_encrypted text NOT NULL/);
    expect(migration).toMatch(/tfn_last4 text NOT NULL CHECK/);
    expect(migration).toMatch(/ALTER TABLE public\.employee_tfn_vault ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(
      /REVOKE ALL ON public\.employee_tfn_vault FROM PUBLIC, anon, authenticated/,
    );
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.employee_tfn_status/);
    expect(migration).toMatch(/'\*\*\*\*\*' \|\| v\.tfn_last4/);
  });

  it('scrubs plaintext TFNs from employee wage JSON', () => {
    expect(migration).toMatch(/strip_employee_tfn_from_wage_components/);
    expect(migration).toMatch(/- 'tfn'/);
    expect(migration).toMatch(/- 'tax_file_number'/);
    expect(migration).toMatch(/employees_strip_tfn_from_wage_components/);
  });

  it('requires vault TFNs and records redacted STP lifecycle rows', () => {
    expect(exportStp).toMatch(/employee_tfn_vault/);
    // TFN-01: the export reads only tfn_last4 and never decrypts, so the file and the ledger hold masked TFNs only.
    expect(exportStp).not.toMatch(/decryptToken/);
    expect(exportStp).not.toMatch(/tfn_encrypted/);
    expect(exportStp).toMatch(/payload: stp,/);
    expect(exportStp).toMatch(/from\('lodgements'\)/);
    expect(exportStp).toMatch(/lodgement_type: 'stp'/);
    expect(exportStp).toMatch(/status: 'draft'/);
    expect(exportStp).not.toMatch(/000000000/);
  });

  it('builds Phase 2 disaggregation without reading TFN from wage_components', () => {
    expect(stpBuilder).toMatch(/normaliseTfn/);
    expect(stpBuilder).toMatch(/maskTfn/);
    expect(stpBuilder).toMatch(/disaggregation/);
    expect(stpBuilder).toMatch(/income_type/);
    expect(stpBuilder).toMatch(/tax_treatment_code/);
    expect(stpBuilder).not.toMatch(/wage\["tfn"\]/);
  });

  it('stores TFNs only through the encrypted edge function', () => {
    expect(tfnSave).toMatch(/encryptToken\(tfn\)/);
    expect(tfnSave).toMatch(/employee_tfn_vault/);
    expect(tfnSave).toMatch(/Only admin or owner can store employee TFNs/);
    expect(tfnSave).toMatch(/delete wage\.tfn/);
    expect(tfnSave).not.toMatch(/console\.log/);
  });
});
