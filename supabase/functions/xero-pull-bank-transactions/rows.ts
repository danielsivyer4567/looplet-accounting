// xero-pull-bank-transactions/rows.ts — pure row builders for the Xero bank pull.
//
// Every row matches the database schema:
//   * bank_connections: one per organisation and Xero tenant, provider 'xero'
//     (enum value added by 20261003155000_bank_provider_xero.sql). The OAuth
//     tokens stay encrypted in xero_integrations, so no token is stored here.
//   * bank_accounts: bank_connection_id is that connection (NOT NULL), and
//     account_type is a bank_account_type value mapped from Xero's
//     BankAccountType (BANK | CREDITCARD | PAYPAL | NONE | ""), per the Xero
//     Accounting API Account schema. currency_code is never null.
//   * bank_transactions: RECEIVE* = +, SPEND* = -, integer cents; DELETED
//     (voided) Xero transactions are not imported.
// No network, DB or Deno APIs, so these are unit-tested directly.

export interface XeroBankAccount {
  AccountID: string;
  Code?: string;
  Name: string;
  Type: string;
  Status?: string;
  CurrencyCode?: string;
  BankAccountNumber?: string;
  BankAccountType?: string;
}

export interface XeroBankTransaction {
  BankTransactionID: string;
  Type: string; // SPEND* | RECEIVE*
  BankAccount?: { AccountID: string };
  Date?: string; // "/Date(ms+tz)/" or ISO
  DateString?: string;
  Total?: number;
  Reference?: string;
  Contact?: { Name?: string };
  LineItems?: { AccountCode?: string; Description?: string }[];
  Status?: string;
}

/** bank_account_type enum values (0001_initial_schema.sql). */
export const BANK_ACCOUNT_TYPES = ['checking', 'savings', 'credit_card', 'loan', 'investment', 'other'] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];

export interface XeroBankConnectionRow {
  organization_id: string;
  provider: 'xero';
  external_item_id: string;
  institution_name: string;
  encrypted_access_token: string;
  status: 'active';
  metadata: Record<string, unknown>;
}

export interface BankAccountRow {
  organization_id: string;
  bank_connection_id: string;
  external_id: string;
  name: string;
  account_number_last4: string | null;
  account_type: BankAccountType;
  currency_code: string;
  is_active: boolean;
}

export interface BankTransactionRow {
  organization_id: string;
  bank_account_id: string;
  external_id: string;
  posted_at: string;
  description: string;
  amount_cents: number;
  reference: string | null;
  category_external: string | null;
  raw: XeroBankTransaction;
}

/** The bank connection that owns an organisation's Xero bank accounts. */
export function xeroBankConnectionRow(organizationId: string, xeroTenantId: string): XeroBankConnectionRow {
  if (!organizationId || !xeroTenantId) {
    throw new Error('organization_id and xero_tenant_id are required for a Xero bank connection');
  }
  return {
    organization_id: organizationId,
    provider: 'xero',
    external_item_id: xeroTenantId,
    institution_name: 'Xero',
    // Tokens live encrypted in xero_integrations; nothing is stored on this row.
    encrypted_access_token: '',
    status: 'active',
    metadata: { source: 'xero-pull-bank-transactions', tokens: 'xero_integrations' },
  };
}

/** Xero BankAccountType -> bank_account_type. */
export function bankAccountTypeFromXero(bankAccountType: string | undefined): BankAccountType {
  switch ((bankAccountType ?? '').toUpperCase()) {
    case 'BANK':
      return 'checking';
    case 'CREDITCARD':
      return 'credit_card';
    default:
      // PAYPAL, NONE and "" have no closer match in bank_account_type.
      return 'other';
  }
}

export function bankAccountRow(
  organizationId: string,
  bankConnectionId: string,
  a: XeroBankAccount,
): BankAccountRow {
  if (!bankConnectionId) throw new Error('bank_connection_id is required for a bank account');
  return {
    organization_id: organizationId,
    bank_connection_id: bankConnectionId,
    external_id: a.AccountID,
    name: a.Name,
    account_number_last4: a.BankAccountNumber ? a.BankAccountNumber.replace(/\s+/g, '').slice(-4) : null,
    account_type: bankAccountTypeFromXero(a.BankAccountType),
    currency_code: a.CurrencyCode || 'AUD',
    is_active: a.Status !== 'ARCHIVED' && a.Status !== 'DELETED',
  };
}

/** Xero JSON dates come as "/Date(1518685950940+0000)/"; DateString is ISO. */
export function parseXeroDate(ms?: string, iso?: string): string | null {
  if (iso) {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  if (ms) {
    const m = /\/Date\((\d+)/.exec(ms);
    if (m) return new Date(parseInt(m[1], 10)).toISOString();
    const t = Date.parse(ms);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

/** A bank_transactions row, or null when the account is unknown or Xero voided the transaction. */
export function bankTransactionRow(
  organizationId: string,
  idByExternal: Map<string, string>,
  t: XeroBankTransaction,
  nowIso: string,
): BankTransactionRow | null {
  if (t.Status === 'DELETED') return null;
  const bankAccountId = t.BankAccount?.AccountID ? idByExternal.get(t.BankAccount.AccountID) : undefined;
  if (!bankAccountId) return null; // account not in our map — skip, never orphan
  const sign = t.Type?.startsWith('RECEIVE') ? 1 : -1;
  const cents = Math.round(Math.abs(t.Total ?? 0) * 100) * sign;
  const desc = t.Reference || t.Contact?.Name || t.LineItems?.[0]?.Description || t.Type || 'Xero transaction';
  return {
    organization_id: organizationId,
    bank_account_id: bankAccountId,
    external_id: t.BankTransactionID,
    posted_at: parseXeroDate(t.Date, t.DateString) ?? nowIso,
    description: desc,
    amount_cents: cents,
    reference: t.Reference ?? null,
    category_external: t.LineItems?.[0]?.AccountCode ?? null,
    raw: t,
  };
}
