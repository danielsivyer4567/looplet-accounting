// One Redbark connection's sync, separated from the HTTP handler so it can be tested with a fake client and store.
//
// For each active account linked under the connection:
//   1. check Redbark still lists it on this connection as an AUD account (a link is never assumed to still hold);
//   2. refresh its balance when Redbark has a fresh observation;
//   3. read history in date windows from its checkpoint (see _shared/redbark/history.ts): the first import starts at
//      the account's import-from date, pending rows are skipped, and a truncated window is split;
//   4. insert only transactions that are new on (bank_account_id, external_id = Redbark transaction id), then move the
//      checkpoint forward. Rows already imported are never rewritten, so a re-run, a duplicate webhook or a lost
//      checkpoint cannot duplicate or alter a transaction that may already be matched or posted.
// A failing account is reported and the others still sync. The checkpoint only moves after its rows are stored.

import type { FeedAccount, FeedBalance, FeedTransaction, RedbarkClient } from '../_shared/redbark/client.ts';
import { readNextWindow, type WindowLimits } from '../_shared/redbark/history.ts';

/** Windows per account per run; a long backlog continues on the next run from the stored checkpoint. */
export const MAX_WINDOWS_PER_RUN = 3;

export interface FeedConnection {
  id: string;
  organization_id: string;
  /** The Redbark connection id. */
  external_item_id: string;
}

export interface LinkedAccount {
  id: string;
  /** The Redbark account id. */
  external_id: string;
  feed_sync_from: string | null;
  feed_covered_through: string | null;
}

export interface BankTransactionRow {
  organization_id: string;
  bank_account_id: string;
  external_id: string;
  posted_at: string;
  description: string;
  amount_cents: number;
  running_balance_cents: null;
  reference: string | null;
  category_external: string | null;
  raw: Record<string, unknown>;
  raw_event_id: string | null;
}

export interface SyncStore {
  /** Active accounts linked under the connection. */
  linkedAccounts(connection: FeedConnection): Promise<LinkedAccount[]>;
  /** Stores each transaction's raw payload (bank_events_raw); returns transaction id to raw event id. */
  storeRawTransactions(organizationId: string, transactions: FeedTransaction[]): Promise<Map<string, string>>;
  /** Inserts the rows that are new on (bank_account_id, external_id) and returns only those; existing rows are untouched. */
  insertNewTransactions(rows: BankTransactionRow[]): Promise<{ id: string; external_id: string }[]>;
  saveBalance(bankAccountId: string, balance: FeedBalance): Promise<void>;
  /** Moves the account's checkpoint forward; never backwards. */
  advanceCheckpoint(bankAccountId: string, coveredThrough: string): Promise<void>;
}

export interface AccountSyncResult {
  bank_account_id: string;
  transactions_synced: number;
  transactions_existing: number;
  pending_skipped: number;
  covered_through: string | null;
  caught_up: boolean;
  error?: string;
}

export interface ConnectionSyncResult {
  accounts_synced: number;
  transactions_synced: number;
  transactions_existing: number;
  pending_skipped: number;
  inserted_txn_ids: string[];
  accounts: AccountSyncResult[];
  errors: string[];
}

export async function syncRedbarkConnection(
  client: RedbarkClient,
  store: SyncStore,
  connection: FeedConnection,
  feedAccounts: FeedAccount[],
  options: { today: string; maxWindows?: number; limits?: WindowLimits },
): Promise<ConnectionSyncResult> {
  const result: ConnectionSyncResult = {
    accounts_synced: 0,
    transactions_synced: 0,
    transactions_existing: 0,
    pending_skipped: 0,
    inserted_txn_ids: [],
    accounts: [],
    errors: [],
  };
  for (const account of await store.linkedAccounts(connection)) {
    const outcome: AccountSyncResult = {
      bank_account_id: account.id,
      transactions_synced: 0,
      transactions_existing: 0,
      pending_skipped: 0,
      covered_through: account.feed_covered_through,
      caught_up: false,
    };
    result.accounts.push(outcome);
    try {
      await syncAccount(client, store, connection, account, feedAccounts, options, outcome, result.inserted_txn_ids);
      result.accounts_synced += 1;
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
      result.errors.push(outcome.error);
    }
    result.transactions_synced += outcome.transactions_synced;
    result.transactions_existing += outcome.transactions_existing;
    result.pending_skipped += outcome.pending_skipped;
  }
  return result;
}

async function syncAccount(
  client: RedbarkClient,
  store: SyncStore,
  connection: FeedConnection,
  account: LinkedAccount,
  feedAccounts: FeedAccount[],
  options: { today: string; maxWindows?: number; limits?: WindowLimits },
  outcome: AccountSyncResult,
  insertedIds: string[],
) {
  const syncFrom = account.feed_sync_from;
  if (!syncFrom) throw new Error('This account has no import-from date; link it again from Settings.');
  const feed = feedAccounts.find((a) => a.externalAccountId === account.external_id);
  if (!feed || feed.connectionId !== connection.external_item_id || (feed.currency ?? '').toUpperCase() !== 'AUD') {
    throw new Error('Redbark no longer lists this account as an AUD account on its connection.');
  }

  const balance = await client.balance(account.external_id);
  if (balance) await store.saveBalance(account.id, balance);

  const checkpoint = {
    externalAccountId: account.external_id,
    connectionId: connection.external_item_id,
    syncFrom,
    coveredThrough: account.feed_covered_through,
  };
  const maxWindows = options.maxWindows ?? MAX_WINDOWS_PER_RUN;
  for (let round = 0; round < maxWindows; round++) {
    const window = await readNextWindow(client, checkpoint, options.today, options.limits);
    outcome.pending_skipped += window.pending;
    // Never import a row dated before the chosen import-from date, whatever the provider returns.
    const rows = window.transactions.filter((t) => t.date >= syncFrom);
    if (rows.length > 0) {
      const rawIds = await store.storeRawTransactions(connection.organization_id, rows);
      const inserted = await store.insertNewTransactions(rows.map((t) => ({
        organization_id: connection.organization_id,
        bank_account_id: account.id,
        external_id: t.id,
        posted_at: t.date,
        description: t.description,
        amount_cents: t.cents,
        running_balance_cents: null,
        reference: t.reference,
        category_external: t.category,
        raw: t.raw,
        raw_event_id: rawIds.get(t.id) ?? null,
      })));
      outcome.transactions_synced += inserted.length;
      outcome.transactions_existing += rows.length - inserted.length;
      insertedIds.push(...inserted.map((row) => row.id));
    }
    const advanced = window.coveredThrough !== null && window.coveredThrough !== checkpoint.coveredThrough;
    if (advanced && window.coveredThrough) {
      await store.advanceCheckpoint(account.id, window.coveredThrough);
      checkpoint.coveredThrough = window.coveredThrough;
    }
    outcome.covered_through = checkpoint.coveredThrough;
    outcome.caught_up = window.caughtUp;
    if (window.caughtUp || !advanced) break;
  }
}
