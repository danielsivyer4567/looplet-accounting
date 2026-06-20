/**
 * xero-sync-accounts — pulls Xero chart of accounts and upserts them into
 * xero_account_codes for each org that has an active Xero integration.
 *
 * Called:
 *   - daily by pg_cron (03:00 AEST) via pg_net.http_post with ?secret=...
 *   - on-demand by the Settings page "Refresh accounts" button (authenticated)
 *
 * Input:  { organization_id?: string }
 *   If organization_id is provided, syncs only that org.
 *   If omitted (cron path), syncs ALL orgs with is_enabled=true.
 *
 * Output: { ok: true, orgs_synced: number, accounts_upserted: number }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { callXeroWithRetry, xeroFetch } from '../_shared/xero/auth.ts';
import { requireEnv } from '../_shared/env.ts';

interface XeroAccount {
  AccountID: string;
  Code?: string;
  Name: string;
  Type: string;
  TaxType?: string;
  Description?: string;
  EnablePaymentsToAccount?: boolean;
  Status?: string;
}

interface XeroAccountsResponse {
  Accounts: XeroAccount[];
}

const CRON_SECRET = Deno.env.get('XERO_CRON_SECRET');

function isCronRequest(req: Request): boolean {
  const url = new URL(req.url);
  return (
    url.searchParams.get('secret') === CRON_SECRET && Boolean(CRON_SECRET)
  );
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
    // Auth: either cron secret (no Authorization header needed) or user JWT
    let orgIds: string[];

    if (isCronRequest(req)) {
      // Pull all enabled orgs
      const { data, error } = await admin
        .from('xero_integrations')
        .select('organization_id')
        .eq('is_enabled', true);
      if (error) throw new Error(`DB query failed: ${error.message}`);
      orgIds = (data ?? []).map((r: { organization_id: string }) => r.organization_id);
    } else {
      // User-authenticated request
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });

      let body: { organization_id?: string } = {};
      try {
        body = await req.json();
      } catch {
        // Empty body is fine for cron-style calls
      }

      if (body.organization_id) {
        // Verify user has access to this org
        const { data: org } = await userClient
          .from('organizations')
          .select('id')
          .eq('id', body.organization_id)
          .maybeSingle();
        if (!org) return json({ ok: false, error: 'Organisation not accessible' }, 403);
        orgIds = [body.organization_id];
      } else {
        // Sync all orgs accessible to this user that have Xero connected
        const { data: session } = await userClient.auth.getUser();
        if (!session.user) return json({ ok: false, error: 'Not signed in' }, 401);

        const { data: integrations } = await userClient
          .from('xero_integrations')
          .select('organization_id')
          .eq('is_enabled', true);
        orgIds = (integrations ?? []).map((r: { organization_id: string }) => r.organization_id);
      }
    }

    let totalAccountsUpserted = 0;

    for (const orgId of orgIds) {
      try {
        const data = await callXeroWithRetry<XeroAccountsResponse>(
          admin,
          orgId,
          (ctx) => xeroFetch(ctx, '/api.xro/2.0/Accounts?where=Status=="ACTIVE"'),
        );

        const accounts = data?.Accounts ?? [];

        // Batch upsert into xero_account_codes
        if (accounts.length > 0) {
          const rows = accounts
            .filter((a): a is XeroAccount & { Code: string } => Boolean(a.Code)) // skip accounts with no code
            .map((a) => ({
              organization_id: orgId,
              code: a.Code,
              name: a.Name,
              type: a.Type,
              tax_type: a.TaxType ?? null,
              description: a.Description ?? null,
              is_enabled: a.Status !== 'ARCHIVED',
              synced_at: new Date().toISOString(),
            }));

          const { error: upsertErr } = await admin
            .from('xero_account_codes')
            .upsert(rows, { onConflict: 'organization_id,code' });

          if (upsertErr) {
            console.error(`[xero-sync-accounts] upsert failed for org ${orgId}: ${upsertErr.message}`);
          } else {
            totalAccountsUpserted += rows.length;
          }
        }
      } catch (orgErr) {
        // Log but don't fail the whole cron — one broken org shouldn't block others
        const msg = orgErr instanceof Error ? orgErr.message : String(orgErr);
        console.error(`[xero-sync-accounts] org ${orgId} failed: ${msg}`);
        await admin
          .from('xero_integrations')
          .update({ last_error: msg.slice(0, 500), updated_at: new Date().toISOString() })
          .eq('organization_id', orgId);
      }
    }

    return json({ ok: true, orgs_synced: orgIds.length, accounts_upserted: totalAccountsUpserted });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[xero-sync-accounts] fatal:', msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Re-export for type-checking
export type { XeroAccount };
