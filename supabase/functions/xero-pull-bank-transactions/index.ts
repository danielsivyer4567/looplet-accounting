/**
 * xero-pull-bank-transactions — pulls Xero bank accounts + reconciled bank
 * transactions into the app's bank_accounts / bank_transactions tables. Xero
 * (where the real bank feed lives) is the source of truth; this replaces the
 * removed Basiq feed. The existing classifier / reconcile / job-attribution
 * pipeline runs on the resulting bank_transactions unchanged.
 *
 * Bank accounts: Xero Accounts where Type=="BANK" → bank_accounts with
 *   bank_connection_id NULL. Deduped by (organization_id, external_id) via a
 *   read-then-insert map, because the table's unique index includes the nullable
 *   bank_connection_id (NULLs are distinct, so onConflict can't dedupe them).
 * Transactions: Xero BankTransactions (paginated, newest first) → bank_transactions,
 *   upserted on (bank_account_id, external_id). RECEIVE* = +, SPEND* = −.
 *
 * Auth: cron secret (?secret=XERO_CRON_SECRET) OR a user JWT with org access.
 * Input:  { organization_id?: string }  (omitted on cron = all enabled orgs)
 * Output: { ok, orgs_synced, accounts_upserted, transactions_upserted }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { callXeroWithRetry, xeroFetch } from '../_shared/xero/auth.ts';
import { requireEnv } from '../_shared/env.ts';

interface XeroBankAccount {
  AccountID: string;
  Code?: string;
  Name: string;
  Type: string;
  Status?: string;
  CurrencyCode?: string;
  BankAccountNumber?: string;
}

interface XeroBankTransaction {
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

const MAX_PAGES = 100; // 100 txns/page → up to 10k per run; log if capped.
const CRON_SECRET = Deno.env.get('XERO_CRON_SECRET');

function isCronRequest(req: Request): boolean {
  return Boolean(CRON_SECRET) && new URL(req.url).searchParams.get('secret') === CRON_SECRET;
}

/** Xero JSON dates come as "/Date(1518685950940+0000)/"; DateString is ISO. */
function parseXeroDate(ms?: string, iso?: string): string | null {
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
        // ---- 1. Xero bank accounts (Type==BANK) → bank_accounts ----
        const acctData = await callXeroWithRetry<{ Accounts?: XeroBankAccount[] }>(
          admin,
          orgId,
          (ctx) => xeroFetch(ctx, '/api.xro/2.0/Accounts?where=Type=="BANK"'),
        );
        const bankAccounts = acctData?.Accounts ?? [];

        // Read existing Xero-sourced (bank_connection_id IS NULL) accounts to dedupe.
        const { data: existing } = await admin
          .from('bank_accounts')
          .select('id, external_id')
          .eq('organization_id', orgId)
          .is('bank_connection_id', null);
        const idByExternal = new Map<string, string>(
          (existing ?? []).map((a: { id: string; external_id: string }) => [a.external_id, a.id]),
        );

        for (const a of bankAccounts) {
          const row = {
            organization_id: orgId,
            bank_connection_id: null,
            external_id: a.AccountID,
            name: a.Name,
            account_number_last4: a.BankAccountNumber
              ? a.BankAccountNumber.replace(/\s+/g, '').slice(-4)
              : null,
            account_type: 'bank',
            currency_code: a.CurrencyCode ?? null,
            is_active: a.Status !== 'ARCHIVED',
          };
          const existingId = idByExternal.get(a.AccountID);
          if (existingId) {
            await admin.from('bank_accounts').update(row).eq('id', existingId);
          } else {
            const { data: ins, error: insErr } = await admin
              .from('bank_accounts')
              .insert(row)
              .select('id')
              .single();
            if (insErr || !ins) {
              console.error(`[xero-pull] bank_accounts insert failed (org ${orgId}): ${insErr?.message}`);
              continue;
            }
            idByExternal.set(a.AccountID, ins.id);
          }
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

          const rows = txns
            .map((t) => {
              const bankAccountId = t.BankAccount?.AccountID
                ? idByExternal.get(t.BankAccount.AccountID)
                : undefined;
              if (!bankAccountId) return null; // account not in our map — skip, never orphan
              const sign = t.Type?.startsWith('RECEIVE') ? 1 : -1;
              const cents = Math.round(Math.abs(t.Total ?? 0) * 100) * sign;
              const desc =
                t.Reference || t.Contact?.Name || t.LineItems?.[0]?.Description || t.Type || 'Xero transaction';
              return {
                organization_id: orgId,
                bank_account_id: bankAccountId,
                external_id: t.BankTransactionID,
                posted_at: parseXeroDate(t.Date, t.DateString) ?? new Date().toISOString(),
                description: desc,
                amount_cents: cents,
                reference: t.Reference ?? null,
                category_external: t.LineItems?.[0]?.AccountCode ?? null,
                raw: t,
              };
            })
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
