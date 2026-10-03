/**
 * entity-tfn-save — encrypt and store the TFN of a trust, trust beneficiary, family trust election test individual,
 * SMSF fund or SMSF member.
 *
 * POST {
 *   organization_id: string,
 *   entity: 'trust' | 'trust_beneficiary' | 'fte_test_individual' | 'smsf_fund' | 'smsf_member',
 *   entity_id: string,
 *   tfn: string
 * }
 *
 * The TFN is stored only in entity_tfn_vault, encrypted with the same helper and key as employee TFNs. The plain
 * columns on those tables are held NULL by CHECK constraints (migration 20261003130100). The response carries the
 * masked TFN only.
 *
 * Auth: Bearer JWT, caller must be an accepted admin or owner of the org.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { authorizeOrgMember, supabaseOrgAccessDeps } from '../_shared/orgRole.ts';
import { encryptToken } from '../_shared/xero/crypto.ts';
import { isTfnShape, maskTfnLast4, normaliseTfn, tfnLast4 } from '../_shared/tfn.ts';
import { tfnEntityTable } from './entities.ts';

interface Body {
  organization_id?: string;
  entity?: string;
  entity_id?: string;
  tfn?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return json({ ok: false, error: 'Server config missing' }, 500);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return json({ ok: false, error: 'Unauthorized' }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const organizationId = body.organization_id;
  const entityId = body.entity_id;
  const table = tfnEntityTable(body.entity);
  const tfn = normaliseTfn(body.tfn);

  if (!organizationId || !entityId || !body.entity || !tfn) {
    return json({ ok: false, error: 'organization_id, entity, entity_id and tfn are required' }, 400);
  }
  if (!table) {
    return json(
      { ok: false, error: 'entity must be trust, trust_beneficiary, fte_test_individual, smsf_fund or smsf_member' },
      400,
    );
  }
  if (!isTfnShape(tfn)) {
    return json({ ok: false, error: 'TFN must contain 8 or 9 digits' }, 400);
  }

  // TFNs are stored only by an ACCEPTED admin or owner; a pending admin invite is not enough.
  const access = await authorizeOrgMember(user.id, organizationId, supabaseOrgAccessDeps(admin, serviceKey), 'admin');
  if (!access.ok) return json({ ok: false, error: 'Only an admin or owner can store TFNs' }, access.status);

  const { data: entity, error: entityErr } = await admin
    .from(table)
    .select('id')
    .eq('id', entityId)
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .maybeSingle();
  if (entityErr) return json({ ok: false, error: entityErr.message }, 500);
  if (!entity) return json({ ok: false, error: `${body.entity} not found` }, 404);

  const last4 = tfnLast4(tfn);
  const { error: upsertErr } = await admin.from('entity_tfn_vault').upsert(
    {
      organization_id: organizationId,
      entity_table: table,
      entity_id: entityId,
      tfn_encrypted: await encryptToken(tfn),
      tfn_last4: last4,
      created_by: user.id,
      updated_by: user.id,
    },
    { onConflict: 'entity_table,entity_id' },
  );
  if (upsertErr) return json({ ok: false, error: upsertErr.message }, 500);

  // A TFN saved now supersedes any old plain value still waiting for the backfill.
  const { error: legacyErr } = await admin
    .from('entity_tfn_legacy_plaintext')
    .delete()
    .eq('entity_table', table)
    .eq('entity_id', entityId);
  if (legacyErr) return json({ ok: false, error: legacyErr.message }, 500);

  return json({ ok: true, entity: body.entity, entity_id: entityId, tfn_masked: maskTfnLast4(last4) });
});
