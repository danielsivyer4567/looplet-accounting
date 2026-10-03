// Linking one Redbark account to a bank account in an organisation, separated from Deno.serve for testing.
//
// The caller is already authorised (admin or owner of an organisation allowed to use the feed). Linking:
//   1. validates the import-from date: a real date, no later than today (AEST) and no earlier than 2000-01-01;
//   2. checks Redbark lists the account on that active banking connection, in AUD;
//   3. finds or creates the organisation's bank_connections row for the Redbark connection. The row is unique per
//      (provider, external_item_id) across all organisations, so a connection another organisation linked is refused;
//   4. creates or updates the bank_accounts row for the Redbark account with the import-from date and an empty
//      checkpoint, so the next sync imports from that date. bank-sync never imports a transaction twice, so linking
//      again (for example with an earlier date) is safe.

import { isCalendarDate, lastFour, mapAccountType, type BankAccountType, type FeedAccount } from '../_shared/redbark/client.ts';

export const EARLIEST_SYNC_FROM = '2000-01-01';

export interface FeedConnectionRow {
  id: string;
  organization_id: string;
  status: string;
}

export interface NewConnectionRow {
  organization_id: string;
  provider: 'redbark';
  external_item_id: string;
  institution_name: string | null;
  status: 'active';
  /** Redbark is read with the server key; there is no per-connection token to store. */
  encrypted_access_token: '';
  metadata: Record<string, unknown>;
  created_by: string | null;
}

export interface LinkedAccountRow {
  organization_id: string;
  bank_connection_id: string;
  external_id: string;
  name: string;
  account_number_last4: string | null;
  account_type: BankAccountType;
  currency_code: 'AUD';
  is_active: true;
  feed_sync_from: string;
  feed_covered_through: null;
}

export interface LinkDeps {
  feedAccounts(): Promise<FeedAccount[]>;
  /** The bank_connections row for a Redbark connection id, in any organisation. */
  findConnection(externalConnectionId: string): Promise<FeedConnectionRow | null>;
  /** Inserts the row; 'conflict' when another request created it first (unique violation). */
  createConnection(row: NewConnectionRow): Promise<{ id: string } | 'conflict'>;
  reactivateConnection(id: string): Promise<void>;
  /** Insert or update on (organization_id, bank_connection_id, external_id). */
  upsertAccount(row: LinkedAccountRow): Promise<{ id: string }>;
}

export interface LinkInput {
  organizationId: string;
  connectionId: unknown;
  accountId: unknown;
  syncFrom: unknown;
  userId: string | null;
  /** Today's bank date (AEST), the latest allowed import-from date. */
  today: string;
}

export type LinkResult =
  | { ok: true; bank_connection_id: string; bank_account_id: string; sync_from: string }
  | { ok: false; status: 400 | 404 | 409 | 422; error: string };

export const LINKED_ELSEWHERE = 'This Redbark connection is already linked to another organisation.';

const text = (value: unknown) => (typeof value === 'string' && value.trim() && value.length <= 200 ? value.trim() : null);

export async function linkFeedAccount(input: LinkInput, deps: LinkDeps): Promise<LinkResult> {
  const connectionId = text(input.connectionId), accountId = text(input.accountId);
  if (!connectionId || !accountId) return { ok: false, status: 400, error: 'connection_id and account_id are required.' };
  const syncFrom = input.syncFrom;
  if (!isCalendarDate(syncFrom) || syncFrom < EARLIEST_SYNC_FROM || syncFrom > input.today) {
    return { ok: false, status: 400, error: `Choose an import-from date between ${EARLIEST_SYNC_FROM} and today (${input.today}).` };
  }

  const feed = (await deps.feedAccounts()).find((a) => a.externalAccountId === accountId && a.connectionId === connectionId);
  if (!feed) return { ok: false, status: 404, error: 'Redbark does not list that account on an active banking connection.' };
  if ((feed.currency ?? '').toUpperCase() !== 'AUD') {
    return { ok: false, status: 422, error: 'Only Australian dollar accounts can be linked.' };
  }

  let connection = await deps.findConnection(connectionId);
  if (!connection) {
    const created = await deps.createConnection({
      organization_id: input.organizationId,
      provider: 'redbark',
      external_item_id: connectionId,
      institution_name: feed.institution,
      status: 'active',
      encrypted_access_token: '',
      metadata: { source: 'redbark' },
      created_by: input.userId,
    });
    connection = created === 'conflict'
      ? await deps.findConnection(connectionId)
      : { id: created.id, organization_id: input.organizationId, status: 'active' };
    if (!connection) throw new Error('The bank connection could not be created.');
  }
  if (connection.organization_id !== input.organizationId) return { ok: false, status: 409, error: LINKED_ELSEWHERE };
  if (connection.status !== 'active') await deps.reactivateConnection(connection.id);

  const account = await deps.upsertAccount({
    organization_id: input.organizationId,
    bank_connection_id: connection.id,
    external_id: accountId,
    name: feed.name,
    account_number_last4: lastFour(feed.accountNumber),
    account_type: mapAccountType(feed.accountType),
    currency_code: 'AUD',
    is_active: true,
    feed_sync_from: syncFrom,
    feed_covered_through: null,
  });
  return { ok: true, bank_connection_id: connection.id, bank_account_id: account.id, sync_from: syncFrom };
}
