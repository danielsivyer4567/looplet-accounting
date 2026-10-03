import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildStpEvent, type StpRun, type StpSlip } from '../../supabase/functions/payroll-export-stp/stp.ts';
import {
  backfillLegacyTfns,
  type BackfillDeps,
  type LegacyTfnRow,
  type VaultInsert,
} from '../../supabase/functions/entity-tfn-backfill/backfill.ts';
import { tfnEntityTable } from '../../supabase/functions/entity-tfn-save/entities.ts';

// TFN-01: a full TFN never reaches the browser (STP export, save responses, trust queries) and is never stored as
// plain text. The database half (constraints, vault access, audit redaction) is tests/db-sql/trust-tfn-encryption.sql.

const TFN = '123456782';
const source = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

function slip(employee: Partial<StpSlip['employee']>): StpSlip {
  return {
    hours_ordinary: 38,
    hours_overtime: 0,
    hours_leave: 0,
    gross_ordinary_cents: 171000,
    gross_overtime_cents: 0,
    gross_leave_cents: 0,
    gross_total_cents: 171000,
    payg_tax_cents: 26000,
    super_guarantee_cents: 20520,
    super_rate_pct: 12,
    net_pay_cents: 145000,
    ytd_gross_cents: 171000,
    ytd_tax_cents: 26000,
    ytd_super_cents: 20520,
    employee: {
      id: 'emp-1',
      full_name: 'Sam Nail',
      email: null,
      wage_components: { stp_tax_treatment_code: 'RT' },
      ...employee,
    },
  };
}

const RUN: StpRun = {
  organization_id: 'org-1',
  period_start: '2025-09-22',
  period_end: '2025-09-28',
  pay_date: '2025-10-01',
  total_gross_cents: 171000,
  total_tax_cents: 26000,
  total_super_cents: 20520,
  total_net_cents: 145000,
  metadata: null,
};

function build(employee: Partial<StpSlip['employee']>) {
  return buildStpEvent({ run: RUN, org: null, slips: [slip(employee)], generatedBy: 'admin@example.test' });
}

function employeesOf(stp: Record<string, unknown>) {
  return (stp as { pay_event: { employees: Record<string, unknown>[] } }).pay_event.employees;
}

describe('the STP file carries masked TFNs only', () => {
  it('uses the vault last four digits and has no full TFN anywhere', () => {
    const stp = build({ tfn_masked: '*****6782' });
    const [employee] = employeesOf(stp);
    expect(employee?.['tfn_masked']).toBe('*****6782');
    expect(employee).not.toHaveProperty('tfn');
    expect(JSON.stringify(stp)).not.toMatch(/\d{5,}6782/);
  });

  it('masks a full TFN even if a caller passes one', () => {
    const stp = build({ tfn: '123 456 782' });
    expect(employeesOf(stp)[0]?.['tfn_masked']).toBe('*****6782');
    expect(JSON.stringify(stp)).not.toContain(TFN);
    expect(JSON.stringify(stp)).not.toContain('123 456 782');
  });

  it('still requires a TFN on file, and rejects a full TFN smuggled in as the masked value', () => {
    expect(() => build({})).toThrow(/missing or invalid TFN for employee Sam Nail/);
    expect(() => build({ tfn_masked: TFN })).toThrow(/missing or invalid TFN/);
    expect(() => build({ tfn: '1234' })).toThrow(/missing or invalid TFN/);
  });

  it('payroll-export-stp never decrypts or selects the encrypted TFN', () => {
    const src = source('supabase/functions/payroll-export-stp/index.ts');
    expect(src).not.toMatch(/decryptToken|xero\/crypto/);
    expect(src).not.toMatch(/tfn_encrypted/);
    expect(src).toMatch(/\.select\('employee_id, tfn_last4, declaration_status'\)/);
    expect(src).toMatch(/tfn_masked: maskedTfnByEmployee\.get\(slip\.employee\.id\) \?\? null/);
    // The browser and the ledger get the same masked event.
    expect(src).toMatch(/payload: stp,/);
    expect(src).toMatch(/return json\(\{ ok: true, stp, lodgement_id: lodgementId, payload_hash: payloadHash \}\)/);
  });

  it('the pay run page says TFNs are masked and does not claim anything was lodged', () => {
    const page = source('src/pages/PayRunDetail.tsx');
    expect(page).toMatch(/Employee TFNs appear masked to the last\s+four digits/);
    expect(page).toMatch(/Nothing is lodged with the ATO from\s+here\./);
    expect(page).not.toMatch(/from encrypted TFN vault records/);
  });
});

describe('TFN save functions return the masked TFN only', () => {
  // The success response of each function: the last `return json(` call that carries `ok: true`.
  const successResponse = (src: string) => {
    const start = src.lastIndexOf('return json(', src.lastIndexOf('ok: true'));
    return src.slice(start, src.indexOf(');', start) + 2);
  };

  it('employee-tfn-save encrypts into the vault and echoes only tfn_masked', () => {
    const src = source('supabase/functions/employee-tfn-save/index.ts');
    expect(src).toMatch(/tfn_encrypted: encrypted/);
    const response = successResponse(src);
    expect(response).toMatch(/tfn_masked: maskTfn\(tfn\)/);
    expect(response).not.toMatch(/[\s{,]tfn[,:\s}]/);
  });

  it('entity-tfn-save encrypts into entity_tfn_vault, never writes the plain columns, and echoes only tfn_masked', () => {
    const src = source('supabase/functions/entity-tfn-save/index.ts');
    expect(src).toMatch(/tfn_encrypted: await encryptToken\(tfn\)/);
    expect(src).toMatch(/\.from\('entity_tfn_vault'\)\.upsert\(/);
    // The entity row is only read (to check it is in this organisation), never written.
    const entityChain = src.slice(src.indexOf('.from(table)'), src.indexOf('.maybeSingle()', src.indexOf('.from(table)')));
    expect(entityChain).not.toMatch(/\.(insert|update|upsert)\(/);
    expect(src).not.toMatch(/console\.(log|info|debug)/);
    const response = successResponse(src);
    expect(response).toMatch(/tfn_masked: maskTfnLast4\(last4\)/);
    expect(response).not.toMatch(/[\s{,]tfn[,:\s}]/);
  });

  it('maps only the five TFN-holding record types to tables', () => {
    expect(tfnEntityTable('trust')).toBe('trusts');
    expect(tfnEntityTable('trust_beneficiary')).toBe('trust_beneficiaries');
    expect(tfnEntityTable('fte_test_individual')).toBe('family_trust_elections');
    expect(tfnEntityTable('smsf_fund')).toBe('smsf_funds');
    expect(tfnEntityTable('smsf_member')).toBe('smsf_members');
    for (const bad of ['employees', 'toString', '__proto__', 'constructor', '', null, 7]) {
      expect(tfnEntityTable(bad)).toBeNull();
    }
  });
});

describe('the legacy plain-text backfill', () => {
  function fakeStore(rows: LegacyTfnRow[], existingVault: string[] = []) {
    const legacy = new Map(rows.map((r) => [r.id, r]));
    const vault = new Map<string, VaultInsert>(
      existingVault.map((key) => [key, { organization_id: 'org-1', entity_table: key.split(':')[0] ?? '', entity_id: key.split(':')[1] ?? '', tfn_encrypted: 'existing', tfn_last4: '0000' }]),
    );
    const encryptedInputs: string[] = [];
    let failInsertFor: string | null = null;
    const deps: BackfillDeps = {
      async listLegacy(afterId, limit) {
        return [...legacy.values()]
          .filter((r) => afterId == null || r.id > afterId)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit);
      },
      async hasVaultTfn(table, id) {
        return vault.has(`${table}:${id}`);
      },
      async encrypt(plain) {
        encryptedInputs.push(plain);
        return `ciphertext-of-${plain.length}-digits`;
      },
      async insertVault(row) {
        if (row.entity_id === failInsertFor) throw new Error(`write vault for ${row.entity_table} ${row.entity_id}: boom`);
        if (!vault.has(`${row.entity_table}:${row.entity_id}`)) vault.set(`${row.entity_table}:${row.entity_id}`, row);
      },
      async deleteLegacy(id) {
        legacy.delete(id);
      },
    };
    return { deps, legacy, vault, encryptedInputs, failInsert: (id: string | null) => (failInsertFor = id) };
  }

  const row = (id: string, entityId: string, tfn: string, table = 'trusts'): LegacyTfnRow => ({
    id,
    organization_id: 'org-1',
    entity_table: table,
    entity_id: entityId,
    tfn_plaintext: tfn,
  });

  it('encrypts valid TFNs, lets a newer vault TFN win, and reports bad values by id only', async () => {
    const store = fakeStore(
      [row('a1', 'trust-1', '123 456 782'), row('a2', 'trust-2', 'pending'), row('a3', 'ben-3', '87654321', 'trust_beneficiaries')],
      ['trust_beneficiaries:ben-3'],
    );
    const result = await backfillLegacyTfns(store.deps);

    expect(result.encrypted).toBe(1);
    expect(result.superseded).toBe(1);
    expect(result.needs_review).toEqual([
      expect.objectContaining({ id: 'a2', entity_table: 'trusts', entity_id: 'trust-2' }),
    ]);
    expect(store.vault.get('trusts:trust-1')).toEqual({
      organization_id: 'org-1',
      entity_table: 'trusts',
      entity_id: 'trust-1',
      tfn_encrypted: 'ciphertext-of-9-digits',
      tfn_last4: '6782',
    });
    // The newer TFN saved through entity-tfn-save is not overwritten.
    expect(store.vault.get('trust_beneficiaries:ben-3')?.tfn_encrypted).toBe('existing');
    expect([...store.legacy.keys()]).toEqual(['a2']);
    // Only normalised digits are encrypted, and nothing plain is reported back.
    expect(store.encryptedInputs).toEqual([TFN]);
    expect(JSON.stringify(result)).not.toMatch(/123|456|782|87654321|pending/);
  });

  it('is idempotent: a second run changes nothing and reports the same review rows', async () => {
    const store = fakeStore([row('a1', 'trust-1', TFN), row('a2', 'trust-2', '12')]);
    await backfillLegacyTfns(store.deps);
    const vaultAfterFirst = JSON.stringify([...store.vault]);
    const second = await backfillLegacyTfns(store.deps);
    expect(second.encrypted).toBe(0);
    expect(second.superseded).toBe(0);
    expect(second.needs_review.map((r) => r.id)).toEqual(['a2']);
    expect(JSON.stringify([...store.vault])).toBe(vaultAfterFirst);
    expect(store.encryptedInputs).toEqual([TFN]);
  });

  it('keeps the plain row when the vault write fails, so a rerun can finish it', async () => {
    const store = fakeStore([row('a1', 'trust-1', TFN)]);
    store.failInsert('trust-1');
    await expect(backfillLegacyTfns(store.deps)).rejects.toThrow('write vault for trusts trust-1: boom');
    expect(store.legacy.has('a1')).toBe(true);
    store.failInsert(null);
    expect((await backfillLegacyTfns(store.deps)).encrypted).toBe(1);
    expect(store.legacy.size).toBe(0);
  });

  it('pages through every waiting row', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => row(`r${String(i).padStart(3, '0')}`, `trust-${i}`, TFN));
    const store = fakeStore(rows);
    expect((await backfillLegacyTfns(store.deps, 100)).encrypted).toBe(250);
    expect(store.legacy.size).toBe(0);
  });

  it('entity-tfn-backfill accepts only the exact service role key, before touching the database', () => {
    const src = source('supabase/functions/entity-tfn-backfill/index.ts');
    const guard = src.indexOf("if (!isExactServiceRoleBearer(req.headers.get('Authorization'), serviceKey))");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(src.indexOf('createClient(supabaseUrl, serviceKey'));
    expect(src).toMatch(/ignoreDuplicates: true/);
  });
});

describe('the browser never reads a TFN column', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'test' ? [] : files(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  it('no frontend query selects tfn or test_individual_tfn', () => {
    const offenders = files('src').filter((path) =>
      /\.select\(\s*(['"`])(?:(?!\1)[\s\S])*\b(tfn|test_individual_tfn)\b/.test(source(path)),
    );
    expect(offenders).toEqual([]);
  });
});
