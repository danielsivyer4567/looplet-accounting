/**
 * entity-tfn-backfill — one-off, owner-run: encrypt the plain trust/SMSF TFNs that migration 20261003130100 moved
 * into entity_tfn_legacy_plaintext, into entity_tfn_vault. Idempotent; run it again until needs_review is empty or
 * only holds values someone must correct.
 *
 * POST {}  with  Authorization: Bearer <service role key>
 *
 *   curl -X POST "$SUPABASE_URL/functions/v1/entity-tfn-backfill" -H "Authorization: Bearer $SERVICE_ROLE_KEY"
 *
 * Returns counts and, for values that are not 8- or 9-digit TFNs, their row ids (never the values).
 * Encryption uses ENCRYPTION_KEY, the same key as employee TFNs and Xero tokens.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { isExactServiceRoleBearer } from '../_shared/serviceRole.ts';
import { encryptToken } from '../_shared/xero/crypto.ts';
import { backfillLegacyTfns, type LegacyTfnRow } from './backfill.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: 'Server config missing' }, 500);

  // Operator-only: the exact service role key, never a user session.
  if (!isExactServiceRoleBearer(req.headers.get('Authorization'), serviceKey)) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const result = await backfillLegacyTfns({
      async listLegacy(afterId, limit) {
        let query = admin
          .from('entity_tfn_legacy_plaintext')
          .select('id, organization_id, entity_table, entity_id, tfn_plaintext')
          .order('id', { ascending: true })
          .limit(limit);
        if (afterId) query = query.gt('id', afterId);
        const { data, error } = await query;
        if (error) throw new Error(`list legacy TFNs: ${error.message}`);
        return (data ?? []) as LegacyTfnRow[];
      },
      async hasVaultTfn(entityTable, entityId) {
        const { data, error } = await admin
          .from('entity_tfn_vault')
          .select('id')
          .eq('entity_table', entityTable)
          .eq('entity_id', entityId)
          .maybeSingle();
        if (error) throw new Error(`read vault: ${error.message}`);
        return Boolean(data);
      },
      encrypt: encryptToken,
      async insertVault(row) {
        const { error } = await admin
          .from('entity_tfn_vault')
          .upsert(row, { onConflict: 'entity_table,entity_id', ignoreDuplicates: true });
        if (error) throw new Error(`write vault for ${row.entity_table} ${row.entity_id}: ${error.message}`);
      },
      async deleteLegacy(id) {
        const { error } = await admin.from('entity_tfn_legacy_plaintext').delete().eq('id', id);
        if (error) throw new Error(`delete legacy row ${id}: ${error.message}`);
      },
    });
    return json({ ok: true, ...result });
  } catch (e) {
    // Errors name rows and tables only; they never include a TFN.
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
