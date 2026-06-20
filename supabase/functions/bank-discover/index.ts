// bank-discover — recover a Basiq connection that was authorised on Basiq's side
// but never saved into Looplet (no provider='basiq' bank_connections row).
//
// Looks up the org's basiq_user_id, asks Basiq which connections exist for that
// user, and upserts each as a provider='basiq' bank_connections row so bank-sync
// can then pull transactions. Service-role only (one-off recovery / ops tool).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { listConnections } from '../_shared/basiq/client.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!serviceKey || !supabaseUrl) return json({ ok: false, error: 'server config missing' }, 500);

    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    let isServiceRole = token === serviceKey;
    if (!isServiceRole) {
      try {
        const payloadB64 = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(atob(payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4)));
        isServiceRole = payload?.role === 'service_role';
      } catch { /* not a JWT */ }
    }
    if (!isServiceRole) return json({ ok: false, error: 'unauthorized' }, 401);

    const { organization_id } = await req.json();
    if (!organization_id) return json({ ok: false, error: 'organization_id required' }, 400);

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: org } = await admin
      .from('organizations')
      .select('basiq_user_id')
      .eq('id', organization_id)
      .maybeSingle();
    if (!org?.basiq_user_id) return json({ ok: false, error: 'org has no basiq_user_id (Basiq Connect was never started)' }, 400);

    const conns = await listConnections(org.basiq_user_id as string);

    const saved: Record<string, unknown>[] = [];
    for (const c of conns) {
      const status = c.status?.toLowerCase() === 'active' ? 'active'
        : (c.status?.toLowerCase().includes('pend') ? 'pending' : 'active');
      const { data, error } = await admin
        .from('bank_connections')
        .upsert(
          {
            organization_id,
            provider: 'basiq',
            external_item_id: c.id,
            institution_name: c.institution?.name ?? c.institution?.shortName ?? 'Bank',
            status,
            encrypted_access_token: '', // Basiq auth is org-level (server token), not per-connection
            metadata: { source: 'bank-discover', basiq_status: c.status, expiry: c.expiryDate ?? null },
          },
          { onConflict: 'organization_id,provider,external_item_id' },
        )
        .select('id')
        .maybeSingle();
      saved.push({
        basiq_connection_id: c.id,
        institution: c.institution?.name ?? c.institution?.shortName,
        basiq_status: c.status,
        our_connection_id: data?.id ?? null,
        saved: !error,
        error: error?.message ?? null,
      });
    }

    return json({
      ok: true,
      basiq_user_id: org.basiq_user_id,
      connections_found: conns.length,
      saved,
      next: conns.length > 0 ? 'call bank-sync with this organization_id to pull transactions' : 'no Basiq connections exist for this user — the Connect flow never completed',
    });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
