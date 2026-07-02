-- P0 security-advisor fixes, verified live 2026-07-02 against prod
-- (dxoikltymmknxqpkpyhi) via get_advisors + has_function_privilege spot-checks,
-- not just the lint text. Three findings, tightest-possible additive fix:
--
-- 1. run_data_completeness_scan_all() is SECURITY DEFINER with NO auth guard
--    and is anon-executable RIGHT NOW (confirmed via has_function_privilege).
--    It loops every organization and returns org_id + scan results — a live,
--    unauthenticated cross-tenant data leak via /rest/v1/rpc/run_data_completeness_scan_all.
--    Same issue on the single-org run_data_completeness_scan(p_org_id) — anon can
--    pull any org's completeness scan if they know/guess the org_id.
-- 2. v_xero_pending_pushes is a SECURITY DEFINER view — bypasses the caller's RLS.
-- 3. cron_heartbeat_jobs / cron_heartbeat_runs are public tables with RLS disabled.
--
-- Plus: revoke anon EXECUTE on 24 of the 26 anon_security_definer_function_executable
-- advisor findings, as defense-in-depth, matching this codebase's established
-- pattern (see automation_backbone_definer_hardening 20260630171500 — REVOKE
-- FROM PUBLIC does not remove the PUBLIC default grant that hands EXECUTE to
-- anon/authenticated directly; each role needs an explicit REVOKE). Several of
-- these (approve/reject/_resolve_approval/request_approval/post_journal_entry/
-- payroll_finalise_pay_run/revoke_api_key/seed_default_chart_of_accounts/
-- issue_receipt_identity) already fail closed on auth.uid() IS NULL — confirmed
-- by reading their bodies — so this is hardening, not a live-exploit fix for
-- those; the two run_data_completeness_scan variants are the only ones that
-- were actually exploitable as anon before this migration. The remaining 2 of
-- the 26 (get_accessible_org_ids, require_role) are DELIBERATELY left granted —
-- see the comment above the REVOKE block below for why (they're load-bearing
-- inside nearly every table's RLS policy; revoking would 500 instead of
-- correctly-empty-filter anon traffic, a regression not a fix).
--
-- Explicitly OUT of scope for this migration (tracked as a separate follow-up,
-- not bundled here since they need per-function judgment, not a mechanical
-- batch fix): the 26 functions with mutable search_path, and the 61
-- authenticated-executable DEFINER functions (most are correct by design).
--
-- Idempotent: REVOKE/ALTER VIEW/ENABLE RLS are all safe to re-run.

-- 1. Fix the two data-completeness scan functions: require an authenticated
--    caller who is actually a member of the org being scanned (or service_role,
--    which bypasses this check entirely — used by the daily cron and by
--    run_data_completeness_scan_all below). Real body preserved verbatim from
--    the live function (read via pg_get_functiondef 2026-07-02) — every INSERT/
--    UPDATE and the final jsonb summary are unchanged; only the auth guard at
--    the top is new. This ALSO closes an unauthenticated-write path: before
--    this fix, anon could trigger writes into data_completeness_findings for
--    any org, not just read.
CREATE OR REPLACE FUNCTION public.run_data_completeness_scan(p_org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_critical int := 0;
  v_warning int := 0;
  v_info int := 0;
  v_resolved int := 0;
BEGIN
  IF auth.role() <> 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'not authenticated';
    END IF;
    IF p_org_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
      RAISE EXCEPTION 'insufficient privilege: not a member of this organization'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  WITH offenders AS (
    SELECT DISTINCT s.id, s.name FROM public.suppliers s
    WHERE s.organization_id = p_org_id AND s.deleted_at IS NULL
      AND (s.abn IS NULL OR length(trim(s.abn)) = 0)
      AND (
        EXISTS (SELECT 1 FROM public.intake_rules r WHERE r.supplier_id = s.id AND r.category_code = 'subcontractor')
        OR EXISTS (SELECT 1 FROM public.bills b WHERE b.supplier_id = s.id AND b.auto_category_code = 'subcontractor')
      )
  )
  INSERT INTO public.data_completeness_findings (organization_id, check_code, resource_type, resource_id, severity, title, description, fix_url, fix_action, last_seen_at)
  SELECT p_org_id, 'subbie_without_abn', 'supplier', o.id, 'critical',
    'Subcontractor "' || o.name || '" has no ABN',
    'TPAR-reportable subbies must have an ABN. Without it you may need to withhold 47% PAYG and the breach is reportable to ATO.',
    '/suppliers/' || o.id::text, 'Add ABN', now()
  FROM offenders o
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL;

  INSERT INTO public.data_completeness_findings (organization_id, check_code, resource_type, resource_id, severity, title, description, fix_url, fix_action, last_seen_at)
  SELECT p_org_id, 'bill_no_category', 'bill', b.id, 'warning',
    'Bill from ' || COALESCE((SELECT s.name FROM public.suppliers s WHERE s.id = b.supplier_id), b.supplier_name_raw, 'unknown') || ' missing category',
    'Without a category code this bill won''t map to a Xero account on push.',
    '/bills/' || b.id::text, 'Pick category', now()
  FROM public.bills b
  WHERE b.organization_id = p_org_id AND b.deleted_at IS NULL AND b.status NOT IN ('void')
    AND (b.auto_category_code IS NULL OR length(trim(b.auto_category_code)) = 0)
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL;

  INSERT INTO public.data_completeness_findings (organization_id, check_code, resource_type, resource_id, severity, title, description, fix_url, fix_action, last_seen_at)
  SELECT p_org_id, 'bill_high_value_no_attachment', 'bill', b.id, 'warning',
    'Bill > $1000 has no attached invoice/receipt',
    'ATO substantiation rules (TR 95/14) require records for purchases over $82.50. This bill is over $1000 with no source document attached.',
    '/bills/' || b.id::text, 'Attach receipt', now()
  FROM public.bills b
  WHERE b.organization_id = p_org_id AND b.deleted_at IS NULL
    AND b.status NOT IN ('void')
    AND b.total_inc_gst_cents > 100000
    AND b.attached_at IS NULL
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL;

  INSERT INTO public.data_completeness_findings (organization_id, check_code, resource_type, resource_id, severity, title, description, fix_url, fix_action, last_seen_at)
  SELECT p_org_id, 'bill_gst_mismatch', 'bill', b.id, 'warning',
    'GST math doesn''t check out',
    'Bill total inc GST is $' || (b.total_inc_gst_cents / 100.0)::text ||
      ' so GST should be ~$' || ROUND(b.total_inc_gst_cents / 11.0 / 100.0, 2)::text ||
      ' but recorded as $' || (b.gst_cents / 100.0)::text || '.',
    '/bills/' || b.id::text, 'Review GST', now()
  FROM public.bills b
  WHERE b.organization_id = p_org_id AND b.deleted_at IS NULL AND b.status NOT IN ('void')
    AND b.total_inc_gst_cents > 10000 AND b.gst_cents IS NOT NULL AND b.gst_cents > 0
    AND ABS(b.gst_cents - ROUND(b.total_inc_gst_cents / 11.0)::bigint) > 200
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL;

  INSERT INTO public.data_completeness_findings (organization_id, check_code, resource_type, resource_id, severity, title, description, fix_url, fix_action, last_seen_at)
  SELECT p_org_id, 'invoice_overdue_60d', 'invoice', i.id, 'warning',
    'Invoice ' || COALESCE(i.invoice_number, 'unnumbered') || ' is over 60 days overdue',
    '$' || (i.balance_due_cents / 100.0)::text || ' outstanding from ' ||
      COALESCE((SELECT c.name FROM public.customers c WHERE c.id = i.customer_id), 'unknown customer') ||
      ' (due ' || i.due_date::text || ').',
    '/invoices/' || i.id::text, 'Follow up', now()
  FROM public.invoices i
  WHERE i.organization_id = p_org_id AND i.deleted_at IS NULL
    AND i.status NOT IN ('paid', 'void') AND i.balance_due_cents > 0
    AND i.due_date < CURRENT_DATE - INTERVAL '60 days'
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL;

  INSERT INTO public.data_completeness_findings (organization_id, check_code, resource_type, resource_id, severity, title, description, fix_url, fix_action, last_seen_at)
  SELECT p_org_id, 'vehicle_expenses_no_logbook', 'org_profile', p_org_id, 'warning',
    'Motor vehicle expenses claimed but no logbook on file',
    'You have $' || (
      SELECT (SUM(total_inc_gst_cents) / 100.0)::text FROM public.bills
       WHERE organization_id = p_org_id AND auto_category_code = 'motor_vehicle' AND deleted_at IS NULL
    ) || ' in motor vehicle bills but Business Profile says no logbook. Cents-per-km method caps at 5,000km/year.',
    '/settings', 'Fix profile', now()
  FROM public.business_profile bp
  WHERE bp.organization_id = p_org_id AND bp.has_logbook = false
    AND EXISTS (SELECT 1 FROM public.bills b WHERE b.organization_id = p_org_id AND b.auto_category_code = 'motor_vehicle' AND b.deleted_at IS NULL AND b.total_inc_gst_cents > 0)
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL;

  INSERT INTO public.data_completeness_findings (organization_id, check_code, resource_type, resource_id, severity, title, description, fix_url, fix_action, last_seen_at)
  SELECT p_org_id, 'subscription_unclassified', 'subscription', s.id, 'info',
    'Subscription "' || s.merchant_name || '" not tagged business/personal',
    'Tag this as business (deductible) or personal (not deductible).',
    '/subscriptions/' || s.id::text, 'Tag', now()
  FROM public.subscriptions s
  WHERE s.organization_id = p_org_id
    AND s.status NOT IN ('cancelled', 'dismissed')
    AND s.is_personal = false AND s.is_business = false
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL;

  WITH missing AS (
    SELECT CASE WHEN bp.entity_type IS NULL THEN 'entity_type' END AS f FROM public.business_profile bp WHERE bp.organization_id = p_org_id
    UNION ALL SELECT CASE WHEN bp.state_code IS NULL THEN 'state_code' END FROM public.business_profile bp WHERE bp.organization_id = p_org_id
    UNION ALL SELECT CASE WHEN bp.aggregated_turnover_bracket IS NULL OR bp.aggregated_turnover_bracket = 'unknown' THEN 'turnover_bracket' END FROM public.business_profile bp WHERE bp.organization_id = p_org_id
    UNION ALL SELECT CASE WHEN bp.is_gst_registered IS NULL OR (bp.is_gst_registered = true AND bp.bas_frequency IS NULL) THEN 'gst_or_bas_frequency' END FROM public.business_profile bp WHERE bp.organization_id = p_org_id
  )
  INSERT INTO public.data_completeness_findings (organization_id, check_code, resource_type, resource_id, severity, title, description, fix_url, fix_action, last_seen_at)
  SELECT p_org_id, 'profile_incomplete', 'org_profile', p_org_id, 'info',
    'Business profile incomplete: ' || string_agg(f, ', '),
    'The /ask bot uses these fields to tailor tax advice.',
    '/settings', 'Complete profile', now()
  FROM missing
  WHERE f IS NOT NULL
  HAVING COUNT(f) > 0
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL, title = EXCLUDED.title;

  INSERT INTO public.data_completeness_findings (organization_id, check_code, resource_type, resource_id, severity, title, description, fix_url, fix_action, last_seen_at)
  SELECT p_org_id, 'bill_personal_with_business_category', 'bill', b.id, 'warning',
    'Bill flagged personal but has a business category',
    'is_personal=true means this won''t hit your business P&L, yet auto_category_code is a deductible business code. One of them is wrong.',
    '/bills/' || b.id::text, 'Reconcile', now()
  FROM public.bills b
  WHERE b.organization_id = p_org_id AND b.deleted_at IS NULL
    AND b.is_personal = true AND b.auto_category_code IS NOT NULL
    AND b.auto_category_code NOT IN ('personal_expense', 'uncategorized')
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL;

  UPDATE public.data_completeness_findings
  SET resolved_at = now()
  WHERE organization_id = p_org_id AND resolved_at IS NULL
    AND last_seen_at < now() - INTERVAL '5 seconds';

  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  SELECT
    COUNT(*) FILTER (WHERE severity = 'critical' AND resolved_at IS NULL AND is_muted = false),
    COUNT(*) FILTER (WHERE severity = 'warning'  AND resolved_at IS NULL AND is_muted = false),
    COUNT(*) FILTER (WHERE severity = 'info'     AND resolved_at IS NULL AND is_muted = false)
  INTO v_critical, v_warning, v_info
  FROM public.data_completeness_findings WHERE organization_id = p_org_id;

  RETURN jsonb_build_object('ok', true, 'organization_id', p_org_id,
    'critical', v_critical, 'warning', v_warning, 'info', v_info,
    'resolved_this_run', v_resolved, 'scanned_at', now());
END $function$;

CREATE OR REPLACE FUNCTION public.run_data_completeness_scan_all()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org RECORD;
  v_results jsonb := '[]'::jsonb;
  v_one jsonb;
  v_critical_total int := 0;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service_role only: run_data_completeness_scan_all scans every organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOR v_org IN SELECT id FROM public.organizations WHERE deleted_at IS NULL LOOP
    BEGIN
      v_one := public.run_data_completeness_scan(v_org.id);
      v_results := v_results || jsonb_build_array(v_one);
      v_critical_total := v_critical_total + COALESCE((v_one->>'critical')::int, 0);
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object('org_id', v_org.id, 'error', SQLERRM));
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'orgs_scanned', jsonb_array_length(v_results),
    'critical_total', v_critical_total, 'results', v_results,
    'ran_at', now()
  );
END $function$;

-- 2. v_xero_pending_pushes: stop bypassing the caller's RLS.
ALTER VIEW public.v_xero_pending_pushes SET (security_invoker = on);

-- 3. cron_heartbeat_jobs / cron_heartbeat_runs: internal cron bookkeeping,
--    never meant to be readable by end users. No policy = service_role only
--    (service_role has BYPASSRLS; app/anon/authenticated get nothing).
ALTER TABLE public.cron_heartbeat_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cron_heartbeat_runs ENABLE ROW LEVEL SECURITY;

-- 4. Defense-in-depth: revoke anon EXECUTE on 24 of the 26 advisor-flagged
--    functions. REVOKE is idempotent (no-op if already revoked); wrapped so a
--    name that doesn't exist on some future branch doesn't abort the migration.
--
--    DELIBERATELY EXCLUDED — get_accessible_org_ids() and both require_role()
--    overloads. Verified live 2026-07-02 via pg_policies: these two are called
--    inside the USING/WITH CHECK clause of essentially every table's RLS
--    policy in this schema (bills, journal_entries, organizations,
--    chart_of_accounts, customers, and dozens more), and every one of those
--    policies applies to role {public} (which includes anon). Revoking EXECUTE
--    on them would not close any hole — an anon caller today already gets
--    correctly-filtered EMPTY results (get_accessible_org_ids() returns
--    nothing for a caller with no auth.uid()) — it would instead turn every
--    anon-adjacent query across the whole app into a hard 500
--    ("permission denied for function get_accessible_org_ids") instead of an
--    empty array. That is a functional regression, not a security fix. Do NOT
--    add these two back to this list without re-checking pg_policies first.
--    (integration_org_id() was checked against the same pg_policies query and
--    is NOT referenced by any policy, so it stays in the revoke list below.)
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._resolve_approval(uuid, public.approval_status, text)',
    'public.approve(uuid)',
    'public.audit_log_trigger_v2()',
    'public.bills_autolink_supplier()',
    'public.dispatch_tag_notification()',
    'public.emit_critical_finding_notifications()',
    'public.integration_org_id()',
    'public.invoice_payments_validate()',
    'public.invoices_apply_payment()',
    'public.invoices_assign_number()',
    'public.invoices_recompute_totals()',
    'public.is_action_approved(uuid, text, uuid, text)',
    'public.is_action_approved(uuid, text, uuid, jsonb)',
    'public.issue_receipt_identity(uuid, text, text)',
    'public.payroll_finalise_pay_run(uuid)',
    'public.post_journal_entry(uuid)',
    'public.reject(uuid, text)',
    'public.request_approval(uuid, text, uuid, public.approval_risk_tier, jsonb)',
    'public.revoke_api_key(uuid)',
    'public.run_data_completeness_scan(uuid)',
    'public.run_data_completeness_scan_all()',
    'public.seed_default_chart_of_accounts(uuid)',
    'public.write_audit_log()'
  ]
  LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', v_fn);
    EXCEPTION WHEN undefined_function THEN
      RAISE NOTICE 'skip (not found): %', v_fn;
    END;
  END LOOP;
END $$;
