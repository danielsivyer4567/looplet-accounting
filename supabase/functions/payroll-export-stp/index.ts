/**
 * payroll-export-stp — generate Single Touch Payroll (STP) Phase 2 JSON for a
 * pay run, ready for handoff to a registered tax/BAS agent for SBR lodgement.
 *
 * POST { run_id: string }
 *
 * Output structure (STP Phase 2 — simplified):
 *   {
 *     header: { abn, bms_id, software, run_date, ... },
 *     pay_event: {
 *       period_start, period_end, pay_date,
 *       totals: { gross, payg, super, net },
 *       employees: [
 *         {
 *           tfn_masked, name, address,
 *           ytd: { gross, payg, super },
 *           pay: {
 *             gross_ordinary_cents, gross_overtime_cents, gross_leave_cents,
 *             ote_cents, payg_tax_cents, super_guarantee_cents, net_pay_cents,
 *             hours: { ordinary, overtime, leave }
 *           }
 *         }, ...
 *       ]
 *     }
 *   }
 *
 * NOTE: actual ATO submission requires SBR (Standard Business Reporting)
 * gateway integration — out of scope. This file is for tax-agent lodgement.
 *
 * TFNs: the file carries each employee's masked TFN (last four digits) only.
 * The function reads tfn_last4 from employee_tfn_vault and never decrypts, so a
 * full TFN never reaches the browser or the downloaded file.
 *
 * Auth: Bearer JWT, caller must be admin+ for the org.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { authorizeOrgMember, supabaseOrgAccessDeps } from '../_shared/orgRole.ts';
import { buildStpEvent, type StpOrg, type StpRun, type StpSlip } from './stp.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
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

  let body: { run_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }
  const { run_id } = body;
  if (!run_id) return json({ ok: false, error: 'run_id is required' }, 400);

  // Caller must be admin+ for the run's org.
  const { data: run, error: runErr } = await admin
    .from('pay_runs')
    .select('*')
    .eq('id', run_id)
    .single();
  if (runErr || !run) return json({ ok: false, error: 'pay_run not found' }, 404);

  // STP export reads pay and TFN-vault data: an ACCEPTED admin or owner of the run's org only.
  const access = await authorizeOrgMember(user.id, run.organization_id, supabaseOrgAccessDeps(admin, serviceKey), 'admin');
  if (!access.ok) return json({ ok: false, error: 'Only an admin or owner can export STP' }, access.status);

  // Org-level info (ABN etc.) lives in organizations.settings.
  const { data: org } = await admin
    .from('organizations')
    .select('id, name, settings')
    .eq('id', run.organization_id)
    .single();

  // Fetch slips + employees joined.
  const { data: slips, error: slipsErr } = await admin
    .from('pay_slips')
    .select(
      `
      hours_ordinary, hours_overtime, hours_leave,
      gross_ordinary_cents, gross_overtime_cents, gross_leave_cents, gross_total_cents,
      payg_tax_cents, super_guarantee_cents, super_rate_pct, net_pay_cents,
      ytd_gross_cents, ytd_tax_cents, ytd_super_cents,
      employee:employees!inner(id, full_name, email, wage_components)
    `,
    )
    .eq('pay_run_id', run_id);
  if (slipsErr) return json({ ok: false, error: slipsErr.message }, 500);

  const employeeIds = Array.from(
    new Set(
      ((slips ?? []) as { employee?: { id?: string } }[])
        .map((slip) => slip.employee?.id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  // Only the last four digits: the encrypted TFN is not read, so nothing here can decrypt it.
  const { data: tfnRows, error: tfnErr } = await admin
    .from('employee_tfn_vault')
    .select('employee_id, tfn_last4, declaration_status')
    .eq('organization_id', run.organization_id)
    .in('employee_id', employeeIds);
  if (tfnErr) return json({ ok: false, error: tfnErr.message }, 500);

  const maskedTfnByEmployee = new Map<string, string>();
  for (const row of (tfnRows ?? []) as { employee_id: string; tfn_last4: string }[]) {
    maskedTfnByEmployee.set(row.employee_id, `*****${row.tfn_last4}`);
  }

  const slipsWithTfn = ((slips ?? []) as unknown as StpSlip[]).map((slip) => ({
    ...slip,
    employee: {
      ...slip.employee,
      tfn_masked: maskedTfnByEmployee.get(slip.employee.id) ?? null,
    },
  }));

  // Shape the STP Phase 2 event (incl. the termination/ETP block when the run carries
  // run.metadata.termination) via the pure, unit-tested builder.
  let stp: Record<string, unknown>;
  try {
    stp = buildStpEvent({
      run: run as unknown as StpRun,
      org: (org ?? null) as StpOrg | null,
      slips: slipsWithTfn,
      generatedBy: user.email ?? user.id,
    });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
  }

  // The event already carries masked TFNs only, so the ledger keeps the same payload the browser receives.
  const payloadHash = await sha256Hex(JSON.stringify(stp));
  let lodgementId: string | null = null;
  const periodLabel = `${run.period_start} to ${run.period_end}`;
  const { data: lodgement, error: lodgementErr } = await admin
    .from('lodgements')
    .insert({
      organization_id: run.organization_id,
      lodgement_type: 'stp',
      period_label: periodLabel,
      payload_hash: payloadHash,
      payload: stp,
      status: 'draft',
      response: {
        transport: 'disabled',
        reason:
          'STP export generated for external review; live ATO lodgement remains external-gated',
      },
      created_by: user.id,
    })
    .select('id')
    .single();
  if (lodgementErr) {
    if (lodgementErr.code === '23505') {
      const { data: existing } = await admin
        .from('lodgements')
        .select('id')
        .eq('organization_id', run.organization_id)
        .eq('lodgement_type', 'stp')
        .eq('period_label', periodLabel)
        .eq('payload_hash', payloadHash)
        .maybeSingle();
      lodgementId = (existing as { id?: string } | null)?.id ?? null;
    } else {
      return json({ ok: false, error: lodgementErr.message }, 500);
    }
  } else {
    lodgementId = (lodgement as { id?: string } | null)?.id ?? null;
  }

  return json({ ok: true, stp, lodgement_id: lodgementId, payload_hash: payloadHash });
});
