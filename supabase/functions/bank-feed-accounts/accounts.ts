// The Redbark accounts an organisation's admin can see and link, separated from Deno.serve for testing.
//
// Each account is reported as:
//   linked            linked in this organisation (with its import-from date and checkpoint)
//   available         an AUD account on an active banking connection that no organisation has linked
//   linked_elsewhere  its connection belongs to another organisation; nothing about that link is returned
//   not_aud           not an Australian dollar account, so it cannot be linked

import { lastFour, type FeedAccount } from '../_shared/redbark/client.ts';

export interface FeedConnectionOwner {
  id: string;
  organization_id: string;
  external_item_id: string;
  status: string;
}

export interface OrgFeedAccountRow {
  id: string;
  external_id: string;
  bank_connection_id: string;
  feed_sync_from: string | null;
  feed_covered_through: string | null;
  is_active: boolean;
}

export interface AccountsDeps {
  feedAccounts(): Promise<FeedAccount[]>;
  /** Redbark bank_connections rows for these Redbark connection ids, in any organisation. */
  connectionsFor(externalConnectionIds: string[]): Promise<FeedConnectionOwner[]>;
  /** This organisation's bank accounts under these bank connections. */
  accountsFor(organizationId: string, bankConnectionIds: string[]): Promise<OrgFeedAccountRow[]>;
}

export interface FeedAccountView {
  account_id: string;
  connection_id: string;
  name: string;
  institution: string | null;
  account_last4: string | null;
  account_type: string | null;
  currency: string | null;
  status: 'linked' | 'available' | 'linked_elsewhere' | 'not_aud';
  link: { bank_connection_id: string; bank_account_id: string; sync_from: string | null; covered_through: string | null } | null;
}

export async function listFeedAccounts(organizationId: string, deps: AccountsDeps): Promise<FeedAccountView[]> {
  const accounts = await deps.feedAccounts();
  const connections = accounts.length ? await deps.connectionsFor([...new Set(accounts.map((a) => a.connectionId))]) : [];
  const byExternal = new Map(connections.map((c) => [c.external_item_id, c]));
  const ours = connections.filter((c) => c.organization_id === organizationId);
  const rows = ours.length ? await deps.accountsFor(organizationId, ours.map((c) => c.id)) : [];

  return accounts.map((account) => {
    const connection = byExternal.get(account.connectionId);
    const base = {
      account_id: account.externalAccountId,
      connection_id: account.connectionId,
      name: account.name,
      institution: account.institution,
      account_last4: lastFour(account.accountNumber),
      account_type: account.accountType,
      currency: account.currency,
    };
    if (connection && connection.organization_id !== organizationId) return { ...base, status: 'linked_elsewhere', link: null };
    const row = connection && connection.status === 'active'
      ? rows.find((r) => r.bank_connection_id === connection.id && r.external_id === account.externalAccountId && r.is_active)
      : undefined;
    if (connection && row) {
      return {
        ...base,
        status: 'linked',
        link: { bank_connection_id: connection.id, bank_account_id: row.id, sync_from: row.feed_sync_from, covered_through: row.feed_covered_through },
      };
    }
    if ((account.currency ?? '').toUpperCase() !== 'AUD') return { ...base, status: 'not_aud', link: null };
    return { ...base, status: 'available', link: null };
  });
}
