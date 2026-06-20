/**
 * gmail-backfill — sweep historical Gmail for attachments matching a date
 * window. Runs in batches because edge functions have a wall clock.
 *
 * Input:  { integration_id: UUID, days?: number = 180, page_token?: string, max?: number = 50 }
 * Output: {
 *   ok: true,
 *   stats: { fetched, bills_created, duplicates_skipped, rejected, errors },
 *   next_page_token: string | null,
 *   query: string,
 * }
 *
 * The frontend calls this repeatedly until next_page_token is null. Each call
 * processes up to `max` messages so we stay under the 60s wall clock.
 *
 * Auth: requires Authorization header with the user's JWT (RLS-checked).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { loadAndRefreshGmail } from '../_shared/gmail/auth.ts';
import type { GmailIntegrationRow } from '../_shared/gmail/ingest.ts';
import { ingestGmailMessage } from '../_shared/gmail/ingest.ts';

interface RequestBody {
  integration_id: string;
  days?: number;
  page_token?: string;
  max?: number;
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
    if (!body.integration_id) {
      return json({ ok: false, error: 'integration_id required' }, 400);
    }

    const days = Math.max(1, Math.min(365, body.days ?? 180));
    const max = Math.max(1, Math.min(100, body.max ?? 50));

    // Verify caller has access to the integration's org via RLS
    const { data: integForUser, error: integErr } = await userClient
      .from('gmail_integrations')
      .select('id, organization_id, gmail_address, allowlist')
      .eq('id', body.integration_id)
      .maybeSingle();
    if (integErr || !integForUser) {
      return json({ ok: false, error: 'Integration not accessible' }, 403);
    }

    const integ = integForUser as GmailIntegrationRow;

    // Get a fresh access token via service role (no RLS on gmail_integrations
    // for service_role; loadAndRefreshGmail reads encrypted_refresh_token)
    const { accessToken } = await loadAndRefreshGmail(admin, integ.id);

    // Build Gmail search query: attachments in inbox after the cutoff date
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const yyyy = cutoff.getUTCFullYear();
    const mm = String(cutoff.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(cutoff.getUTCDate()).padStart(2, '0');
    const query = `has:attachment after:${yyyy}/${mm}/${dd} in:inbox`;

    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    listUrl.searchParams.set('q', query);
    listUrl.searchParams.set('maxResults', String(Math.min(max, 100)));
    if (body.page_token) listUrl.searchParams.set('pageToken', body.page_token);

    const listResp = await fetch(listUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listResp.ok) {
      const t = await listResp.text();
      return json(
        {
          ok: false,
          error: `Gmail messages.list failed (${listResp.status}): ${t.slice(0, 300)}`,
        },
        502,
      );
    }

    const list = (await listResp.json()) as {
      messages?: { id: string; threadId: string }[];
      nextPageToken?: string;
      resultSizeEstimate?: number;
    };

    const stats = {
      fetched: list.messages?.length ?? 0,
      bills_created: 0,
      duplicates_skipped: 0,
      rejected: 0,
      errors: 0,
    };

    for (const m of list.messages ?? []) {
      try {
        const r = await ingestGmailMessage(admin, accessToken, integ, m.id);
        stats.bills_created += r.bills.length;
        stats.duplicates_skipped += r.duplicates;
        stats.rejected += r.rejected.length;
      } catch (err) {
        stats.errors += 1;
        console.error('ingest error:', err);
      }
    }

    // Track sweep progress on the integration row
    await admin
      .from('gmail_integrations')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('id', integ.id);

    return json({
      ok: true,
      stats,
      next_page_token: list.nextPageToken ?? null,
      query,
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
