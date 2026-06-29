/**
 * bank-sync — pull latest transactions from Basiq for a connection (or all
 * active connections in an org). Idempotent: dedupes by external_id.
 *
 * Input: {
 *   organization_id,
 *   bank_connection_id?: string,   // single connection
 *   days?: number = 90,            // back-window for the first sync
 * }
 * Output: { ok, results: [{connection_id, accounts, transactions, errors}] }
 *
 * Designed to be safe for cron invocation (service-role auth tolerated).
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import {
  getAccountsForConnection,
  getAllTransactionsForConnection,
  toCents,
  mapBasiqAccountType,
} from '../_shared/basiq/client.ts';
import {
  dedupeTransactions,
  isDuplicateKeyError,
  summariseSyncRun,
  type SyncStat,
} from '../_shared/basiq/durability.ts';
import { isExactServiceRoleBearer } from '../_shared/serviceRole.ts';

type TriggerSource = 'manual' | 'webhook' | 'cron' | 'exchange' | 'discover';

interface RequestBody {
  organization_id: string;
  bank_connection_id?: string;
  days?: number;
  // Durability (slice P1-02): correlate replays + record provenance.
  idempotency_key?: string;
  trigger_source?: TriggerSource;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Service-role callers must present the exact configured key. Do not trust
    // a decoded JWT payload role claim here; verify_jwt may be disabled for
    // server-to-server callers in some deployments.
    const isServiceRole = isExactServiceRoleBearer(authHeader, serviceKey);

    const body = (await req.json()) as RequestBody;
    if (!body.organization_id) return json({ ok: false, error: 'organization_id required' }, 400);

    // Caller must own org (RLS) unless service-role
    if (!isServiceRole) {
      const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
      if (!anonKey) return json({ ok: false, error: 'SUPABASE_ANON_KEY not set' }, 500);
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: org } = await userClient
        .from('organizations')
        .select('id')
        .eq('id', body.organization_id)
        .maybeSingle();
      if (!org) return json({ ok: false, error: 'Organisation not accessible' }, 403);
    }

    const { data: orgRow } = await admin
      .from('organizations')
      .select('basiq_user_id')
      .eq('id', body.organization_id)
      .single();
    if (!orgRow?.basiq_user_id) {
      return json({ ok: false, error: 'No Basiq user — connect a bank first' }, 400);
    }

    let connQuery = admin
      .from('bank_connections')
      .select('id, external_item_id, status, last_synced_at')
      .eq('organization_id', body.organization_id)
      .eq('provider', 'basiq')
      .eq('status', 'active');
    if (body.bank_connection_id) connQuery = connQuery.eq('id', body.bank_connection_id);

    const { data: connections } = await connQuery;
    if (!connections || connections.length === 0) {
      return json({ ok: true, results: [], message: 'No active connections to sync' });
    }

    const days = Math.max(7, Math.min(730, body.days ?? 90));
    const fromDate = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
    const triggerSource: TriggerSource = body.trigger_source ?? 'manual';

    const results: Record<string, unknown>[] = [];
    const allInsertedTxnIds: string[] = [];
    const runStats: SyncStat[] = [];
    for (const c of connections) {
      // One durable bank_sync_runs row per connection per invocation. Recorded
      // up front (status 'running') so a crash leaves an auditable trace, then
      // finalised below. Best-effort: a missing runs table must not break sync.
      const runId = await startSyncRun(admin, {
        organizationId: body.organization_id,
        bankConnectionId: c.id,
        idempotencyKey: body.idempotency_key ?? null,
        triggerSource,
        fromDate,
      });
      try {
        const stats = await syncOne(
          admin,
          body.organization_id,
          orgRow.basiq_user_id as string,
          c as { id: string; external_item_id: string; last_synced_at: string | null },
          fromDate,
        );
        results.push({ bank_connection_id: c.id, ...stats });
        runStats.push({
          inserted: stats.transactions_synced,
          deduped: stats.transactions_deduped,
          skipped: stats.transactions_skipped,
        });
        if (stats.inserted_txn_ids?.length) {
          allInsertedTxnIds.push(...stats.inserted_txn_ids);
        }
        await finishSyncRun(admin, runId, {
          status: 'success',
          accountsUpdated: stats.accounts_updated,
          inserted: stats.transactions_synced,
          deduped: stats.transactions_deduped,
          skipped: stats.transactions_skipped,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await admin
          .from('bank_connections')
          .update({ last_error: msg.slice(0, 500), status: 'error' })
          .eq('id', c.id);
        results.push({ bank_connection_id: c.id, error: msg });
        runStats.push({ inserted: 0, deduped: 0, skipped: 0, error: msg });
        await finishSyncRun(admin, runId, { status: 'error', error: msg.slice(0, 500) });
      }
    }

    const summary = summariseSyncRun(runStats);

    // Fire-and-forget: kick subscriptions detection so newly-synced txns
    // immediately update the recurring-payment list.
    void fireAndForgetSubsDetect(supabaseUrl, serviceKey, body.organization_id);

    // Fire-and-forget: auto-apply intake_rules to new txns (one batch call
    // covers all connections). No-op if no rules or no new txns.
    if (allInsertedTxnIds.length > 0) {
      void fireAndForgetIntakeRouting(
        supabaseUrl,
        serviceKey,
        body.organization_id,
        'bank_transaction',
        allInsertedTxnIds,
      );
    }

    return json({ ok: true, results, summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

/** Insert a bank_sync_runs row in 'running' state. Returns its id (or null). */
async function startSyncRun(
  admin: SupabaseClient,
  args: {
    organizationId: string;
    bankConnectionId: string;
    idempotencyKey: string | null;
    triggerSource: TriggerSource;
    fromDate: string;
  },
): Promise<string | null> {
  try {
    const { data } = await admin
      .from('bank_sync_runs')
      .insert({
        organization_id: args.organizationId,
        bank_connection_id: args.bankConnectionId,
        idempotency_key: args.idempotencyKey,
        trigger_source: args.triggerSource,
        status: 'running',
        from_date: args.fromDate,
      })
      .select('id')
      .single();
    return (data?.id as string) ?? null;
  } catch {
    return null; // Ledger is best-effort; never block the actual sync.
  }
}

/** Finalise a bank_sync_runs row. No-op if startSyncRun returned null. */
async function finishSyncRun(
  admin: SupabaseClient,
  runId: string | null,
  patch: {
    status: 'success' | 'partial' | 'error';
    accountsUpdated?: number;
    inserted?: number;
    deduped?: number;
    skipped?: number;
    error?: string;
  },
): Promise<void> {
  if (!runId) return;
  try {
    await admin
      .from('bank_sync_runs')
      .update({
        status: patch.status,
        accounts_updated: patch.accountsUpdated ?? 0,
        transactions_inserted: patch.inserted ?? 0,
        transactions_deduped: patch.deduped ?? 0,
        transactions_skipped: patch.skipped ?? 0,
        last_error: patch.error ?? null,
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId);
  } catch {
    // best-effort
  }
}

async function fireAndForgetSubsDetect(supabaseUrl: string, serviceKey: string, orgId: string) {
  try {
    await fetch(`${supabaseUrl}/functions/v1/subscriptions-detect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization_id: orgId }),
    });
  } catch {
    // Don't fail bank-sync if subscription detection has a hiccup
  }
}

async function syncOne(
  admin: SupabaseClient,
  orgId: string,
  basiqUserId: string,
  conn: { id: string; external_item_id: string; last_synced_at: string | null },
  fromDate: string,
) {
  // 1. Refresh accounts (balances + status)
  const accounts = await getAccountsForConnection(basiqUserId, conn.external_item_id);
  let acctUpdated = 0;
  for (const a of accounts) {
    const { error } = await admin.from('bank_accounts').upsert(
      {
        organization_id: orgId,
        bank_connection_id: conn.id,
        external_id: a.id,
        name: a.name,
        account_type: mapBasiqAccountType(a.class?.type ?? 'other'),
        current_balance_cents: toCents(a.balance),
        available_balance_cents: toCents(a.availableFunds ?? null),
        currency_code: a.currency ?? 'AUD',
        is_active: true,
      },
      { onConflict: 'organization_id,bank_connection_id,external_id' },
    );
    if (!error) acctUpdated += 1;
  }

  // 2. Map Basiq account.id → our internal bank_accounts.id
  const { data: ourAccounts } = await admin
    .from('bank_accounts')
    .select('id, external_id')
    .eq('bank_connection_id', conn.id);
  const acctMap = new Map<string, string>();
  for (const r of (ourAccounts ?? []) as { id: string; external_id: string }[]) {
    acctMap.set(r.external_id, r.id);
  }

  // 3. Pull transactions (incremental: from last_synced_at, else fromDate)
  const since = conn.last_synced_at
    ? new Date(conn.last_synced_at).toISOString().slice(0, 10)
    : fromDate;
  const txns = await getAllTransactionsForConnection(basiqUserId, conn.external_item_id, since);

  // Idempotency, level 1: collapse duplicate external ids WITHIN this batch
  // (Basiq can return the same txn across overlapping pages) before we touch
  // the DB. Makes a single pass deterministic and saves wasted upserts.
  const { unique, duplicates: batchDuplicates } = dedupeTransactions(
    txns.map((t) => ({ ...t, id: t.id })),
  );

  let inserted = 0;
  let deduped = batchDuplicates;
  let skipped = 0;
  const insertedTxnIds: string[] = [];
  for (const t of unique) {
    const bankAccountId = acctMap.get(t.account);
    if (!bankAccountId) {
      skipped += 1;
      continue;
    }
    // Basiq amounts are signed: negative = money out, positive = money in.
    // That's already our convention (positive = money_in), so no inversion.
    const amount = toCents(t.amount);
    // Idempotency, level 2: the DB unique (bank_account_id, external_id) makes
    // this upsert safe to replay. We update existing rows in place (so a
    // re-sync refreshes mutable fields like running balance) and a re-run of
    // the same data inserts nothing new — making the whole sync replayable.
    const { data: row, error } = await admin
      .from('bank_transactions')
      .upsert(
        {
          organization_id: orgId,
          bank_account_id: bankAccountId,
          external_id: t.id,
          posted_at: t.postDate,
          description: t.description ?? '(no description)',
          amount_cents: amount,
          running_balance_cents: t.balance != null ? toCents(t.balance) : null,
          reference: t.reference ?? null,
          category_external: t.subClass?.title ?? t.class ?? null,
          raw: t,
        },
        { onConflict: 'bank_account_id,external_id', ignoreDuplicates: false },
      )
      .select('id')
      .single();
    if (error) {
      // A duplicate-key race is a successful dedupe, not a failure.
      if (isDuplicateKeyError(error)) deduped += 1;
      else skipped += 1;
    } else {
      inserted += 1;
      if (row?.id) insertedTxnIds.push(row.id as string);
    }
  }

  // 4. Bump last_synced_at
  await admin
    .from('bank_connections')
    .update({ last_synced_at: new Date().toISOString(), last_error: null })
    .eq('id', conn.id);

  return {
    accounts_updated: acctUpdated,
    transactions_synced: inserted,
    transactions_deduped: deduped,
    transactions_skipped: skipped,
    inserted_txn_ids: insertedTxnIds,
  };
}

async function fireAndForgetIntakeRouting(
  supabaseUrl: string,
  serviceKey: string,
  orgId: string,
  target: 'bill' | 'bank_transaction',
  targetIds: string[],
) {
  try {
    await fetch(`${supabaseUrl}/functions/v1/intake-routing-apply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization_id: orgId, target, target_ids: targetIds }),
    });
  } catch {
    // Routing is non-critical to bank-sync.
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
