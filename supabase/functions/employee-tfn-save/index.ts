/**
 * employee-tfn-save — encrypt and store an employee TFN for STP.
 *
 * POST {
 *   organization_id: string,
 *   employee_id: string,
 *   tfn: string,
 *   declaration_status?: 'declared' | 'not_provided' | 'exemption'
 * }
 *
 * Auth: Bearer JWT, caller must be admin+ for the org. Plain TFNs are never
 * stored in employees.wage_components and are never returned.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { authorizeOrgMember, supabaseOrgAccessDeps } from '../_shared/orgRole.ts';
import { encryptToken } from '../_shared/xero/crypto.ts';

type DeclarationStatus = 'declared' | 'not_provided' | 'exemption';

interface Body {
  organization_id?: string;
  employee_id?: string;
  tfn?: string;
  declaration_status?: DeclarationStatus;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function normalizeTfn(value: string | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

function validateTfn(value: string): boolean {
  return /^\d{8,9}$/.test(value);
}

function maskTfn(value: string): string {
  return `*****${value.slice(-4)}`;
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
  const employeeId = body.employee_id;
  const tfn = normalizeTfn(body.tfn);
  const declarationStatus = body.declaration_status ?? 'declared';

  if (!organizationId || !employeeId || !tfn) {
    return json({ ok: false, error: 'organization_id, employee_id and tfn are required' }, 400);
  }
  if (!validateTfn(tfn)) {
    return json({ ok: false, error: 'TFN must contain 8 or 9 digits' }, 400);
  }
  if (!['declared', 'not_provided', 'exemption'].includes(declarationStatus)) {
    return json({ ok: false, error: 'invalid declaration_status' }, 400);
  }

  // TFNs are stored only by an ACCEPTED admin or owner; a pending admin invite is not enough.
  const access = await authorizeOrgMember(user.id, organizationId, supabaseOrgAccessDeps(admin, serviceKey), 'admin');
  if (!access.ok) return json({ ok: false, error: 'Only admin or owner can store employee TFNs' }, access.status);

  const { data: employee, error: employeeErr } = await admin
    .from('employees')
    .select('id, organization_id, wage_components')
    .eq('id', employeeId)
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .maybeSingle();
  if (employeeErr) return json({ ok: false, error: employeeErr.message }, 500);
  if (!employee) return json({ ok: false, error: 'employee not found' }, 404);

  const encrypted = await encryptToken(tfn);
  const { error: upsertErr } = await admin.from('employee_tfn_vault').upsert(
    {
      organization_id: organizationId,
      employee_id: employeeId,
      tfn_encrypted: encrypted,
      tfn_last4: tfn.slice(-4),
      declaration_status: declarationStatus,
      updated_by: user.id,
      created_by: user.id,
    },
    { onConflict: 'employee_id' },
  );
  if (upsertErr) return json({ ok: false, error: upsertErr.message }, 500);

  const wage = { ...((employee.wage_components ?? {}) as Record<string, unknown>) };
  delete wage.tfn;
  delete wage.tax_file_number;
  delete wage.taxFileNumber;
  delete wage.tfn_encrypted;
  await admin.from('employees').update({ wage_components: wage }).eq('id', employeeId);

  return json({
    ok: true,
    employee_id: employeeId,
    tfn_masked: maskTfn(tfn),
    declaration_status: declarationStatus,
  });
});
