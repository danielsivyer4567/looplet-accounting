/**
 * xero-pull-bank-transactions — pulls Xero bank accounts + reconciled bank
 * transactions into the app's bank_accounts / bank_transactions tables. Xero
 * (where the real bank feed lives) is the source of truth for organisations
 * without a Redbark feed. The existing classifier / reconcile / job-attribution
 * pipeline runs on the resulting bank_transactions unchanged.
 *
 * Connection: one bank_connections row per org + Xero tenant (provider 'xero'),
 *   upserted on (organization_id, provider, external_item_id). Tokens stay in
 *   xero_integrations.
 * Bank accounts: Xero Accounts where Type=="BANK" → bank_accounts under that
 *   connection, upserted on (organization_id, bank_connection_id, external_id).
 *   account_type maps Xero's BankAccountType (CREDITCARD → credit_card, BANK →
 *   checking, other → other); see rows.ts.
 * Transactions: Xero BankTransactions (paginated, newest first) → bank_transactions,
 *   upserted on (bank_account_id, external_id). RECEIVE* = +, SPEND* = −; voided
 *   (DELETED) transactions are skipped.
 *
 * Auth: cron secret (X-Cron-Secret header = XERO_CRON_SECRET) OR a user JWT with org access.
 * Input:  { organization_id?: string }  (omitted on cron = all enabled orgs)
 * Output: { ok, orgs_synced, accounts_upserted, transactions_upserted }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { hasCronSecret } from '../_shared/cronSecret.ts';
import { callXeroWithRetry, xeroFetch } from '../_shared/xero/auth.ts';
import { requireEnv } from '../_shared/env.ts';
import {
  bankAccountRow,
  bankTransactionRow,
  type XeroBankAccount,
  xeroBankConnectionRow,
  type XeroBankTransaction,
} from './rows.ts';

const MAX_PAGES = 100; // 100 txns/page → up to 10k per run; log if capped.
const CRON_SECRET = Deno.env.get('XERO_CRON_SECRET');

function isCronRequest(req: Request): boolean {
  return hasCronSecret(req, CRON_SECRET);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = requireEnv('SUPABASE_ANON_KEY');
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    // ---- resolve target orgs (cron secret → all enabled; user JWT → scoped) ----
    let orgIds: string[];
    if (isCronRequest(req)) {
      const { data, error } = await admin
        .from('xero_integrations')
        .select('organization_id')
        .eq('is_enabled', true);
      if (error) throw new Error(`DB query failed: ${error.message}`);
      orgIds = (data ?? []).map((r: { organization_id: string }) => r.organization_id);
    } else {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      let body: { organization_id?: string } = {};
      try {
        body = await req.json();
      } catch {
        /* empty body ok */
      }
      if (body.organization_id) {
        const { data: org } = await userClient
          .from('organizations')
          .select('id')
          .eq('id', body.organization_id)
          .maybeSingle();
        if (!org) return json({ ok: false, error: 'Organisation not accessible' }, 403);
        orgIds = [body.organization_id];
      } else {
        const { data: session } = await userClient.auth.getUser();
        if (!session.user) return json({ ok: false, error: 'Not signed in' }, 401);
        const { data: integrations } = await userClient
          .from('xero_integrations')
          .select('organization_id')
          .eq('is_enabled', true);
        orgIds = (integrations ?? []).map((r: { organization_id: string }) => r.organization_id);
      }
    }

    let accountsUpserted = 0;
    let transactionsUpserted = 0;

    for (const orgId of orgIds) {
      try {
        // ---- 0. The org's Xero bank connection (bank_accounts need a real one) ----
        const { data: integ, error: integErr } = await admin
          .from('xero_integrations')
          .select('xero_tenant_id')
          .eq('organization_id', orgId)
          .eq('is_enabled', true)
          .maybeSingle();
        if (integErr) throw new Error(`xero_integrations read failed: ${integErr.message}`);
        if (!integ?.xero_tenant_id) throw new Error('Xero is not connected for this organisation');
        const { data: conn, error: connErr } = await admin
          .from('bank_connections')
          .upsert(xeroBankConnectionRow(orgId, integ.xero_tenant_id), {
            onConflict: 'organization_id,provider,external_item_id',
          })
          .select('id')
          .single();
        if (connErr || !conn) throw new Error(`bank_connections upsert failed: ${connErr?.message}`);

        // ---- 1. Xero bank accounts (Type==BANK) → bank_accounts ----
        const acctData = await callXeroWithRetry<{ Accounts?: XeroBankAccount[] }>(
          admin,
          orgId,
          (ctx) => xeroFetch(ctx, '/api.xro/2.0/Accounts?where=Type=="BANK"'),
        );
        const bankAccounts = acctData?.Accounts ?? [];

        const idByExternal = new Map<string, string>();
        for (const a of bankAccounts) {
          const { data: acct, error: acctErr } = await admin
            .from('bank_accounts')
            .upsert(bankAccountRow(orgId, conn.id, a), {
              onConflict: 'organization_id,bank_connection_id,external_id',
            })
            .select('id')
            .single();
          if (acctErr || !acct) {
            console.error(`[xero-pull] bank_accounts upsert failed (org ${orgId}): ${acctErr?.message}`);
            continue;
          }
          idByExternal.set(a.AccountID, acct.id);
          accountsUpserted++;
        }

        // ---- 2. Xero bank transactions → bank_transactions (paginated) ----
        for (let page = 1; page <= MAX_PAGES; page++) {
          const txData = await callXeroWithRetry<{ BankTransactions?: XeroBankTransaction[] }>(
            admin,
            orgId,
            (ctx) =>
              xeroFetch(ctx, `/api.xro/2.0/BankTransactions?page=${page}&order=Date%20DESC`),
          );
          const txns = txData?.BankTransactions ?? [];
          if (txns.length === 0) break;

          const nowIso = new Date().toISOString();
          const rows = txns
            .map((t) => bankTransactionRow(orgId, idByExternal, t, nowIso))
            .filter((r): r is NonNullable<typeof r> => r !== null);

          if (rows.length > 0) {
            const { error: upErr } = await admin
              .from('bank_transactions')
              .upsert(rows, { onConflict: 'bank_account_id,external_id' });
            if (upErr) {
              console.error(`[xero-pull] bank_transactions upsert failed (org ${orgId}): ${upErr.message}`);
            } else {
              transactionsUpserted += rows.length;
            }
          }

          if (txns.length < 100) break; // last page
          if (page === MAX_PAGES) {
            console.warn(`[xero-pull] org ${orgId} hit MAX_PAGES (${MAX_PAGES}); more transactions may exist.`);
          }
        }
        await admin
          .from('bank_connections')
          .update({ last_synced_at: new Date().toISOString(), last_error: null })
          .eq('id', conn.id);
      } catch (orgErr) {
        const msg = orgErr instanceof Error ? orgErr.message : String(orgErr);
        console.error(`[xero-pull] org ${orgId} failed: ${msg}`);
        await admin
          .from('xero_integrations')
          .update({ last_error: msg.slice(0, 500), updated_at: new Date().toISOString() })
          .eq('organization_id', orgId);
      }
    }

    return json({
      ok: true,
      orgs_synced: orgIds.length,
      accounts_upserted: accountsUpserted,
      transactions_upserted: transactionsUpserted,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[xero-pull-bank-transactions] fatal:', msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
