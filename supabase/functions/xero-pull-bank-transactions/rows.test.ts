// XERO-02: the Xero bank pull writes schema-valid rows — a real bank connection and a valid account type.
//
// Run: deno test --allow-env --allow-read --allow-net supabase/functions/xero-pull-bank-transactions/rows.test.ts
//
// The row builders are pure, so they are tested directly. The schema facts they must satisfy are read from the
// migrations (bank_account_type values, bank_provider values, NOT NULL bank_connection_id / currency_code), so the
// test fails if either side drifts. A source check confirms index.ts writes through these builders.

import { assert, assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  BANK_ACCOUNT_TYPES,
  bankAccountRow,
  bankAccountTypeFromXero,
  bankTransactionRow,
  xeroBankConnectionRow,
  type XeroBankAccount,
  type XeroBankTransaction,
} from './rows.ts';

const ORG = '33333333-3333-3333-3333-333333333333';
const CONN = '44444444-4444-4444-4444-444444444444';
const migrationsDir = new URL('../../migrations/', import.meta.url);

async function allMigrationsSql(): Promise<string> {
  const names: string[] = [];
  for await (const e of Deno.readDir(migrationsDir)) if (e.isFile && e.name.endsWith('.sql')) names.push(e.name);
  names.sort();
  let sql = '';
  for (const n of names) sql += `\n-- ${n}\n` + (await Deno.readTextFile(new URL(n, migrationsDir)));
  return sql;
}

/** Enum labels from CREATE TYPE ... AS ENUM (...) plus any ALTER TYPE ... ADD VALUE. */
function enumValues(sql: string, typeName: string): Set<string> {
  const values = new Set<string>();
  const create = new RegExp(`CREATE TYPE (?:public\\.)?${typeName}\\s+AS ENUM\\s*\\(([^)]*)\\)`, 'i').exec(sql);
  if (create) for (const m of create[1].matchAll(/'([^']*)'/g)) values.add(m[1]);
  const add = new RegExp(`ALTER TYPE (?:public\\.)?${typeName} ADD VALUE (?:IF NOT EXISTS )?'([^']*)'`, 'gi');
  for (const m of sql.matchAll(add)) values.add(m[1]);
  return values;
}

const xeroAccount = (overrides: Partial<XeroBankAccount> = {}): XeroBankAccount => ({
  AccountID: 'xero-acct-1',
  Name: 'Business Everyday',
  Type: 'BANK',
  Status: 'ACTIVE',
  BankAccountNumber: '062-000 1234 5678',
  BankAccountType: 'BANK',
  CurrencyCode: 'AUD',
  ...overrides,
});

Deno.test('bank account rows always carry the real connection and a bank_account_type value', async () => {
  const sql = await allMigrationsSql();
  const validTypes = enumValues(sql, 'bank_account_type');
  assert(validTypes.size > 0, 'bank_account_type enum found in migrations');
  assertEquals([...BANK_ACCOUNT_TYPES].sort(), [...validTypes].sort(), 'BANK_ACCOUNT_TYPES matches the enum');

  for (const type of ['BANK', 'CREDITCARD', 'PAYPAL', 'NONE', '', undefined]) {
    const row = bankAccountRow(ORG, CONN, xeroAccount({ BankAccountType: type }));
    assertEquals(row.bank_connection_id, CONN);
    assert(validTypes.has(row.account_type), `${String(type)} -> ${row.account_type} is a valid bank_account_type`);
    assert(row.account_type !== ('bank' as string));
  }
});

Deno.test('Xero BankAccountType maps to the closest bank_account_type', () => {
  assertEquals(bankAccountTypeFromXero('BANK'), 'checking');
  assertEquals(bankAccountTypeFromXero('CREDITCARD'), 'credit_card');
  assertEquals(bankAccountTypeFromXero('PAYPAL'), 'other');
  assertEquals(bankAccountTypeFromXero(undefined), 'other');
});

Deno.test('bank account row fields: last 4 digits, currency never null, archived/deleted inactive', () => {
  const row = bankAccountRow(ORG, CONN, xeroAccount());
  assertEquals(row, {
    organization_id: ORG,
    bank_connection_id: CONN,
    external_id: 'xero-acct-1',
    name: 'Business Everyday',
    account_number_last4: '5678',
    account_type: 'checking',
    currency_code: 'AUD',
    is_active: true,
  });
  assertEquals(bankAccountRow(ORG, CONN, xeroAccount({ CurrencyCode: undefined })).currency_code, 'AUD');
  assertEquals(bankAccountRow(ORG, CONN, xeroAccount({ Status: 'ARCHIVED' })).is_active, false);
  assertEquals(bankAccountRow(ORG, CONN, xeroAccount({ Status: 'DELETED' })).is_active, false);
  assertThrows(() => bankAccountRow(ORG, '', xeroAccount()), Error, 'bank_connection_id is required');
});

Deno.test('the Xero bank connection row is a valid bank_connections row', async () => {
  const sql = await allMigrationsSql();
  const providers = enumValues(sql, 'bank_provider');
  const row = xeroBankConnectionRow(ORG, 'tenant-9');
  assert(providers.has(row.provider), `bank_provider has '${row.provider}' (values: ${[...providers].join(', ')})`);
  assertEquals(row.organization_id, ORG);
  assertEquals(row.external_item_id, 'tenant-9');
  assertEquals(row.status, 'active');
  assertEquals(typeof row.encrypted_access_token, 'string', 'encrypted_access_token is NOT NULL');
  assertEquals(row.encrypted_access_token, '', 'no token is copied out of xero_integrations');
  assertThrows(() => xeroBankConnectionRow(ORG, ''), Error, 'xero_tenant_id');
});

Deno.test('transactions: signed integer cents, unknown accounts and voided transactions skipped', () => {
  const ids = new Map([['xero-acct-1', 'bank-account-uuid']]);
  const base: XeroBankTransaction = {
    BankTransactionID: 'tx-1',
    Type: 'SPEND',
    BankAccount: { AccountID: 'xero-acct-1' },
    DateString: '2026-09-15T00:00:00',
    Total: 123.45,
    Reference: 'Timber',
    Status: 'AUTHORISED',
  };
  const spend = bankTransactionRow(ORG, ids, base, '2026-10-03T00:00:00.000Z');
  assertEquals(spend?.amount_cents, -12345);
  assertEquals(spend?.bank_account_id, 'bank-account-uuid');
  assertEquals(spend?.description, 'Timber');
  assertEquals(bankTransactionRow(ORG, ids, { ...base, Type: 'RECEIVE', Total: 1.15 }, 'x')?.amount_cents, 115);
  assertEquals(bankTransactionRow(ORG, ids, { ...base, BankAccount: { AccountID: 'other' } }, 'x'), null);
  assertEquals(bankTransactionRow(ORG, ids, { ...base, Status: 'DELETED' }, 'x'), null);
  assertEquals(
    bankTransactionRow(ORG, ids, { ...base, DateString: undefined, Date: '/Date(1757894400000+0000)/' }, 'x')
      ?.posted_at,
    '2025-09-15T00:00:00.000Z',
  );
});

Deno.test('index.ts writes through the row builders, never a NULL connection or account_type bank', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  assert(src.includes('bankAccountRow('), 'uses bankAccountRow');
  assert(src.includes('xeroBankConnectionRow('), 'uses xeroBankConnectionRow');
  assert(src.includes('bankTransactionRow('), 'uses bankTransactionRow');
  assertEquals(/bank_connection_id:\s*null/.test(src), false, 'no NULL bank_connection_id');
  assertEquals(/account_type:\s*'bank'/.test(src), false, "no account_type 'bank'");
});
