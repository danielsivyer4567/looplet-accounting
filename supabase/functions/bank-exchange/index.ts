/**
 * bank-exchange — frontend posts the connection_id (and optional job_id) it
 * received from Basiq's Connect callback. We:
 *   1. Validate via RLS that the caller owns the org
 *   2. Look up the Basiq connection details
 *   3. Insert a row into bank_connections
 *   4. Insert/update bank_accounts for each account on this connection
 *   5. Enqueue a durable bank_sync job to pull initial transactions
 *
 * Input:  { organization_id, connection_id }
 * Output: { ok: true, bank_connection_id, accounts: [...], sync_kicked: true, sync_job_id }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { encryptToken } from '../_shared/xero/crypto.ts';
import {
  getConnection,
  getAccountsForConnection,
  mapBasiqAccountType,
  toCents,
} from '../_shared/basiq/client.ts';

interface RequestBody {
  organization_id: string;
  connection_id: string; // Basiq connection.id from callback
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !serviceKey || !anonKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const body = (await req.json()) as RequestBody;
    if (!body.organization_id || !body.connection_id) {
      return json({ ok: false, error: 'organization_id and connection_id required' }, 400);
    }

    const { data: org } = await userClient
      .from('organizations')
      .select('id, basiq_user_id')
      .eq('id', body.organization_id)
      .maybeSingle();
    if (!org) return json({ ok: false, error: 'Organisation not accessible' }, 403);
    if (!org.basiq_user_id) {
      return json({ ok: false, error: 'No Basiq user yet — call bank-link-token first' }, 400);
    }

    const {
      data: { user },
    } = await userClient.auth.getUser();

    // 1. Look up the connection details from Basiq
    const conn = await getConnection(org.basiq_user_id, body.connection_id);

    // 2. We don't get a per-connection token from Basiq; we re-use server-token.
    //    Store the basiq_user_id (as opaque encrypted blob, since we already have
    //    AES-GCM helpers ready) so the schema's encrypted_access_token NOT NULL
    //    constraint is satisfied. The sync function reads org.basiq_user_id.
    const tokenStub = await encryptToken(`basiq_user:${org.basiq_user_id}`);

    // 3. Upsert bank_connections row
    const { data: bankConn, error: bcErr } = await admin
      .from('bank_connections')
      .upsert(
        {
          organization_id: body.organization_id,
          provider: 'basiq',
          institution_id: conn.institution.id,
          institution_name: conn.institution.name ?? conn.institution.shortName ?? null,
          external_item_id: conn.id,
          encrypted_access_token: tokenStub,
          status: conn.status === 'active' ? 'active' : 'pending',
          last_synced_at: null,
          metadata: { basiq_status: conn.status, expires_at: conn.expiryDate ?? null },
          created_by: user?.id ?? null,
        },
        { onConflict: 'organization_id,provider,external_item_id' },
      )
      .select('id')
      .single();
    if (bcErr || !bankConn) {
      return json({ ok: false, error: `connection upsert: ${bcErr?.message}` }, 500);
    }

    // 4. Pull accounts and persist
    const accounts = await getAccountsForConnection(org.basiq_user_id, conn.id);
    const accountRows = [];
    for (const acct of accounts) {
      const accountTypeStr = mapBasiqAccountType(acct.class?.type ?? 'other');
      const accountNo = acct.accountNo ?? '';
      // Common AU format: "BSB-1234 567" or "123-456 789012345" — try to split if a hyphen-leading 6 digits
      let bsb: string | undefined;
      let last4: string | undefined;
      const noDashes = accountNo.replace(/[\s-]/g, '');
      if (/^\d{6,}/.test(noDashes)) {
        if (noDashes.length >= 10) {
          bsb = noDashes.slice(0, 6);
          last4 = noDashes.slice(-4);
        } else {
          last4 = noDashes.slice(-4);
        }
      } else {
        last4 = noDashes.slice(-4) || undefined;
      }

      const { data: row } = await admin
        .from('bank_accounts')
        .upsert(
          {
            organization_id: body.organization_id,
            bank_connection_id: bankConn.id,
            external_id: acct.id,
            name: acct.name,
            account_number_last4: last4 ?? null,
            bsb: bsb ?? null,
            account_type: accountTypeStr,
            current_balance_cents: toCents(acct.balance),
            available_balance_cents: toCents(acct.availableFunds ?? null),
            currency_code: acct.currency ?? 'AUD',
            is_active: true,
          },
          { onConflict: 'organization_id,bank_connection_id,external_id' },
        )
        .select('id, name')
        .single();
      if (row) accountRows.push(row);
    }

    // 5. Queue initial transaction sync. Reuse an unfinished job if the callback
    // is retried, so a flaky redirect does not fan out duplicate bank imports.
    const { data: existingJob, error: existingJobErr } = await admin
      .from('automation_jobs')
      .select('id, status')
      .eq('organization_id', body.organization_id)
      .eq('job_kind', 'bank_sync')
      .eq('source_kind', 'bank_connection')
      .eq('source_id', bankConn.id)
      .in('status', ['pending', 'claimed', 'failed'])
      .order('run_after', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (existingJobErr) {
      return json({ ok: false, error: `sync job lookup: ${existingJobErr.message}` }, 500);
    }

    let syncJobId = (existingJob as { id?: string } | null)?.id ?? null;
    if (!syncJobId) {
      const { data: syncJob, error: syncJobErr } = await admin.rpc('enqueue_automation_job', {
        p_org_id: body.organization_id,
        p_job_kind: 'bank_sync',
        p_source_kind: 'bank_connection',
        p_source_id: bankConn.id,
        p_priority: 3,
        p_run_after: new Date().toISOString(),
        p_max_attempts: 3,
        p_payload: {
          bank_connection_id: bankConn.id,
          days: 180,
          source: 'bank_exchange',
        },
      });
      if (syncJobErr || !syncJob) {
        const detail = syncJobErr?.message ?? 'no job returned';
        return json({ ok: false, error: `sync job enqueue: ${detail}` }, 500);
      }
      syncJobId = (syncJob as { id: string }).id;
    }

    return json({
      ok: true,
      bank_connection_id: bankConn.id,
      accounts: accountRows,
      sync_kicked: true,
      sync_job_id: syncJobId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
