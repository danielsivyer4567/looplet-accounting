/**
 * bank-sync — import the latest Redbark bank-feed transactions for one connection, or every active Redbark connection
 * in an organisation, then run the post-sync chain (subscriptions, intake routing, classifier, auto-reconcile).
 *
 * Input: {
 *   organization_id,
 *   bank_connection_id?: string,   // single connection
 *   days?: number,                 // accepted from older callers and ignored: the window is the account's
 *                                  // import-from date and checkpoint (bank_accounts.feed_sync_from / feed_covered_through)
 * }
 * Output: { ok, results: [{ bank_connection_id, accounts_synced, transactions_synced, ... }], post_sync }
 *
 * Idempotent: transactions are inserted only when new on (bank_account_id, external_id = Redbark transaction id) and
 * existing rows are never rewritten. See sync.ts. Pending rows are skipped.
 *
 * Callers: bank-webhook, bank-sync-all (cron) and automation-worker send the exact service-role key; a signed-in
 * caller needs the accountant role or higher. Only organisations in REDBARK_ORGANIZATION_IDS are synced.
 * Secrets: REDBARK_API_KEY, REDBARK_ORGANIZATION_IDS.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { authorizeOrgCaller, supabaseOrgAccessDeps } from '../_shared/orgRole.ts';
import { FEED_NOT_ENABLED, feedOrganizationIds, isFeedOrganization } from '../_shared/bankfeed/access.ts';
import { sha256Hex } from '../_shared/bankfeed/webhook.ts';
import { createRedbarkClient, type FeedAccount, type FeedTransaction } from '../_shared/redbark/client.ts';
import { feedToday } from '../_shared/redbark/history.ts';
import { syncRedbarkConnection, type FeedConnection, type SyncStore } from './sync.ts';

interface RequestBody {
  organization_id: string;
  bank_connection_id?: string;
  days?: number;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = (await req.json()) as RequestBody;
    if (!body.organization_id) return json({ ok: false, error: 'organization_id required' }, 400);

    // Service-role callers must present the exact configured key; a user needs an accepted accountant+ membership.
    const access = await authorizeOrgCaller(
      req.headers.get('Authorization'),
      body.organization_id,
      supabaseOrgAccessDeps(admin, serviceKey),
      'accountant',
    );
    if (!access.ok) return json({ ok: false, error: access.error }, access.status);

    if (!isFeedOrganization(feedOrganizationIds(Deno.env.get('REDBARK_ORGANIZATION_IDS')), body.organization_id)) {
      return json({ ok: true, results: [], message: FEED_NOT_ENABLED });
    }

    let connQuery = admin
      .from('bank_connections')
      .select('id, organization_id, external_item_id')
      .eq('organization_id', body.organization_id)
      .eq('provider', 'redbark')
      .eq('status', 'active');
    if (body.bank_connection_id) connQuery = connQuery.eq('id', body.bank_connection_id);

    const { data: connections, error: connErr } = await connQuery;
    if (connErr) return json({ ok: false, error: `connections: ${connErr.message}` }, 500);
    if (!connections || connections.length === 0) {
      return json({ ok: true, results: [], message: 'No active bank feed connections to sync' });
    }

    const apiKey = Deno.env.get('REDBARK_API_KEY');
    if (!apiKey) {
      return json({ ok: false, error: 'The bank feed is not configured on the server (REDBARK_API_KEY).' }, 500);
    }
    const client = createRedbarkClient(apiKey);
    const store = supabaseSyncStore(admin);

    // One account listing serves every connection; a failure is recorded on each connection below.
    let feedAccounts: FeedAccount[] | null = null;
    let feedError = '';
    try {
      feedAccounts = await client.accounts();
    } catch (err) {
      feedError = err instanceof Error ? err.message : String(err);
    }

    const today = feedToday();
    const results: Record<string, unknown>[] = [];
    const allInsertedTxnIds: string[] = [];
    for (const c of connections as FeedConnection[]) {
      try {
        if (!feedAccounts) throw new Error(feedError);
        const stats = await syncRedbarkConnection(client, store, c, feedAccounts, { today });
        results.push({ bank_connection_id: c.id, ...stats });
        allInsertedTxnIds.push(...stats.inserted_txn_ids);
        const anySynced = stats.accounts.some((a) => !a.error);
        await admin
          .from('bank_connections')
          .update({
            ...(anySynced ? { last_synced_at: new Date().toISOString() } : {}),
            last_error: stats.errors.length ? stats.errors.join('; ').slice(0, 500) : null,
          })
          .eq('id', c.id);
      } catch (err) {
        // The connection stays active: a provider outage or rate limit is not a broken link, and the next sync
        // resumes from each account's checkpoint.
        const msg = err instanceof Error ? err.message : String(err);
        await admin
          .from('bank_connections')
          .update({ last_error: msg.slice(0, 500) })
          .eq('id', c.id);
        results.push({ bank_connection_id: c.id, error: msg });
      }
    }

    const postSyncErrors: string[] = [];
    const postSync: Record<string, unknown> = {};

    try {
      postSync['subscriptions_detect'] = await runPostSyncFunction(
        supabaseUrl,
        serviceKey,
        'subscriptions-detect',
        body.organization_id,
      );
    } catch (err) {
      postSyncErrors.push(
        `subscriptions-detect: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!postSyncErrors.some((err) => err.startsWith('subscriptions-detect:'))) {
      try {
        postSync['subscriptions_autoconfirm'] = await runPostSyncFunction(
          supabaseUrl,
          serviceKey,
          'subscriptions-autoconfirm',
          body.organization_id,
        );
      } catch (err) {
        postSyncErrors.push(
          `subscriptions-autoconfirm: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (allInsertedTxnIds.length > 0) {
      try {
        await runIntakeRouting(
          supabaseUrl,
          serviceKey,
          body.organization_id,
          'bank_transaction',
          allInsertedTxnIds,
        );
      } catch (err) {
        postSyncErrors.push(
          `intake-routing-apply: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    try {
      postSync['bank_transaction_classifier'] = await runPostSyncFunction(
        supabaseUrl,
        serviceKey,
        'bank-transaction-classifier',
        body.organization_id,
      );
    } catch (err) {
      postSyncErrors.push(
        `bank-transaction-classifier: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      postSync['auto_reconcile'] = await runPostSyncFunction(
        supabaseUrl,
        serviceKey,
        'auto-reconcile',
        body.organization_id,
      );
    } catch (err) {
      postSyncErrors.push(
        `auto-reconcile: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (postSyncErrors.length > 0) {
      return json(
        { ok: false, results, post_sync: postSync, post_sync_errors: postSyncErrors },
        502,
      );
    }
    return json({ ok: true, results, post_sync: postSync });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

async function runPostSyncFunction(
  supabaseUrl: string,
  serviceKey: string,
  functionName:
    | 'subscriptions-detect'
    | 'subscriptions-autoconfirm'
    | 'bank-transaction-classifier'
    | 'auto-reconcile',
  orgId: string,
): Promise<unknown> {
  const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ organization_id: orgId }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(body)}`.trim());
  }
  if (body && typeof body === 'object' && (body as { ok?: unknown }).ok === false) {
    throw new Error(JSON.stringify(body));
  }
  return body;
}

/** The sync's storage, on the service-role client. */
function supabaseSyncStore(admin: SupabaseClient): SyncStore {
  const RAW_CHUNK = 200;
  const INSERT_CHUNK = 500;
  return {
    async linkedAccounts(connection) {
      const { data, error } = await admin
        .from('bank_accounts')
        .select('id, external_id, feed_sync_from, feed_covered_through')
        .eq('organization_id', connection.organization_id)
        .eq('bank_connection_id', connection.id)
        .eq('is_active', true);
      if (error) throw new Error(`linked accounts: ${error.message}`);
      return data ?? [];
    },

    // The raw layer (bank_events_raw) keeps each source payload for audit and replay; raw_event_id links a
    // transaction to it. A raw-layer failure is logged and does not block the import.
    async storeRawTransactions(organizationId, transactions: FeedTransaction[]) {
      const ids = new Map<string, string>();
      for (let i = 0; i < transactions.length; i += RAW_CHUNK) {
        const chunk = transactions.slice(i, i + RAW_CHUNK);
        const hashes = await Promise.all(chunk.map((t) => sha256Hex(JSON.stringify(t.raw))));
        const rows = chunk.map((t, j) => ({
          organization_id: organizationId,
          provider: 'redbark',
          provider_event_id: `txn:${t.id}`,
          payload_hash: hashes[j],
          raw_payload: t.raw,
        }));
        const { error: upsertError } = await admin.from('bank_events_raw').upsert(rows, {
          onConflict: 'provider,organization_id,provider_event_id,payload_hash',
          ignoreDuplicates: true,
        });
        if (upsertError) console.error('bank_events_raw upsert error:', upsertError.message);
        const { data } = await admin
          .from('bank_events_raw')
          .select('id, provider_event_id, payload_hash')
          .eq('organization_id', organizationId)
          .eq('provider', 'redbark')
          .in('provider_event_id', rows.map((r) => r.provider_event_id));
        // Key by event id AND hash: a transaction whose payload changed has a newer raw row.
        const wanted = new Map(rows.map((r) => [`${r.provider_event_id}:${r.payload_hash}`, r.provider_event_id.slice(4)]));
        for (const row of (data ?? []) as { id: string; provider_event_id: string; payload_hash: string }[]) {
          const txnId = wanted.get(`${row.provider_event_id}:${row.payload_hash}`);
          if (txnId) ids.set(txnId, row.id);
        }
      }
      return ids;
    },

    async insertNewTransactions(rows) {
      const inserted: { id: string; external_id: string }[] = [];
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        // ON CONFLICT DO NOTHING: existing rows (possibly matched, coded or posted) are never rewritten, and
        // RETURNING lists only the rows inserted now.
        const { data, error } = await admin
          .from('bank_transactions')
          .upsert(rows.slice(i, i + INSERT_CHUNK), { onConflict: 'bank_account_id,external_id', ignoreDuplicates: true })
          .select('id, external_id');
        if (error) throw new Error(`bank_transactions insert: ${error.message}`);
        inserted.push(...((data ?? []) as { id: string; external_id: string }[]));
      }
      return inserted;
    },

    async saveBalance(bankAccountId, balance) {
      const { error } = await admin
        .from('bank_accounts')
        .update({
          current_balance_cents: balance.currentCents,
          ...(balance.availableCents !== null ? { available_balance_cents: balance.availableCents } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', bankAccountId);
      if (error) throw new Error(`balance: ${error.message}`);
    },

    async advanceCheckpoint(bankAccountId, coveredThrough) {
      const { error } = await admin
        .from('bank_accounts')
        .update({ feed_covered_through: coveredThrough })
        .eq('id', bankAccountId)
        .or(`feed_covered_through.is.null,feed_covered_through.lt.${coveredThrough}`);
      if (error) throw new Error(`checkpoint: ${error.message}`);
    },
  };
}

async function runIntakeRouting(
  supabaseUrl: string,
  serviceKey: string,
  orgId: string,
  target: 'bill' | 'bank_transaction',
  targetIds: string[],
) {
  const response = await fetch(`${supabaseUrl}/functions/v1/intake-routing-apply`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ organization_id: orgId, target, target_ids: targetIds }),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text().catch(() => '')}`.trim());
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
