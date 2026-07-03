-- Follow-up to 20260702150000_advisor_p0_security_fixes, both findings made
-- during POST-APPLY verification of that migration (not before) — recorded
-- honestly here rather than silently folded in, since the first migration's
-- own claims turned out to be partially wrong and needed correcting.
--
-- FINDING 1 — the first migration's REVOKE targeted the wrong role. It ran
-- `REVOKE EXECUTE ... FROM anon`, but 14 of the 24 targeted functions never
-- had anon-specific grants to begin with — their EXECUTE access came from the
-- bare PUBLIC default grant (visible in pg_proc.proacl as a leading `=X/...`
-- entry with no role name), which `FROM anon` does not touch (anon inherits
-- PUBLIC automatically; PostgreSQL requires revoking FROM PUBLIC explicitly
-- to actually close that path — this codebase's own prior hardening comment,
-- which the first migration quoted, already said exactly this). Verified via
-- has_function_privilege() + proacl inspection post-apply. The 10 other
-- functions were already correctly PUBLIC-revoked by an earlier migration, so
-- `FROM anon` was a correct no-op there — this fix widens the same 14 that
-- were still open, it does not touch anything already closed.
--
-- Runtime impact check performed before writing this fix (not assumed):
--   - run_data_completeness_scan(_all): confirmed the auth guard added in the
--     prior migration DOES reject a real anonymous call (live HTTP 401,
--     message "service_role only: ..."), so the primary exploit was already
--     closed by that migration's function-body fix; this grant fix only
--     closes the secondary "who can even attempt to call it" surface.
--   - payroll_finalise_pay_run: live-probed with anon key + a random
--     non-existent pay_run_id — got "pay_run not found", NOT an auth bypass.
--     Read the full function body: it checks require_role(org,'owner') before
--     any mutation, and require_role filters on `user_id = auth.uid()`, which
--     is NULL for an anon caller and therefore never matches any row (SQL
--     NULL semantics) — so a real pay_run_id would still correctly fail at
--     the require_role check. Confirmed NOT exploitable; still revoking the
--     grant here as defense-in-depth, consistent with the rest of the list.
--   - revoke_api_key / issue_receipt_identity: live-probed, both correctly
--     rejected with "not authenticated" — explicit auth.uid() IS NULL guards
--     already present in their bodies. Not exploitable; grant fix is
--     defense-in-depth only.
--   - audit_log_trigger_v2 / bills_autolink_supplier / invoice_payments_validate
--     / invoices_apply_payment / invoices_assign_number / invoices_recompute_totals
--     / write_audit_log: all RETURN trigger and reference NEW/OLD/TG_OP —
--     genuine trigger functions. Postgres refuses to execute a trigger
--     function outside real trigger context ("trigger functions can only be
--     called as triggers"), so these are inert via direct RPC regardless of
--     grants. Grant fix is defense-in-depth only.
--   - integration_org_id: reads only the caller's own JWT claim, no privileged
--     data, no write. Harmless either way; grant fix is defense-in-depth only.
--
-- FINDING 2 — emit_critical_finding_notifications() is a genuinely new,
-- previously-unflagged-by-name-but-caught-by-this-same-audit issue: it is
-- SECURITY DEFINER, takes no arguments, has NO auth check at all, and queries
-- data_completeness_findings with NO organization_id filter (a global sweep
-- across every org), then INSERTs into public.notifications for whichever
-- org(s) had matches. It does not leak finding details back to the caller
-- (returns only a created-count), so this is an unauthenticated cross-tenant
-- WRITE (notification injection into any/every org), not a data leak — same
-- family of bug as run_data_completeness_scan_all, same fix: gate to
-- service_role only, since it's designed to run from a cron sweep, not be
-- called directly by any user. Real body preserved verbatim (read via
-- pg_get_functiondef 2026-07-02); only the guard at the top is new.
--
-- Idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION public.emit_critical_finding_notifications()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count int := 0;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service_role only: emit_critical_finding_notifications sweeps every organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  WITH new_critical AS (
    SELECT f.*
    FROM public.data_completeness_findings f
    WHERE f.severity = 'critical'
      AND f.resolved_at IS NULL
      AND f.is_muted = false
      AND f.first_seen_at >= now() - INTERVAL '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n
        WHERE n.organization_id = f.organization_id
          AND n.category = 'data_completeness'
          AND n.resource_type = f.resource_type
          AND n.resource_id = f.resource_id
          AND n.dismissed_at IS NULL
      )
  )
  INSERT INTO public.notifications (
    organization_id, category, severity, title, body, link, resource_type, resource_id, metadata
  )
  SELECT
    nc.organization_id, 'data_completeness', 'error', -- map our 'critical' → notifications enum 'error'
    nc.title, COALESCE(nc.description, ''),
    COALESCE(nc.fix_url, '/quality'),
    nc.resource_type, nc.resource_id,
    jsonb_build_object('check_code', nc.check_code, 'fix_action', nc.fix_action, 'finding_severity', 'critical')
  FROM new_critical nc;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'notifications_created', v_count);
END $function$;

-- Correct the REVOKE target: FROM PUBLIC, not FROM anon, on the 14 functions
-- confirmed still holding the stale bare-PUBLIC grant. This does not affect
-- the separate explicit `authenticated=X` grant each of these already carries
-- (confirmed present in proacl for all of them pre-fix) — authenticated
-- callers keep working exactly as before.
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.audit_log_trigger_v2()',
    'public.bills_autolink_supplier()',
    'public.emit_critical_finding_notifications()',
    'public.integration_org_id()',
    'public.invoice_payments_validate()',
    'public.invoices_apply_payment()',
    'public.invoices_assign_number()',
    'public.invoices_recompute_totals()',
    'public.issue_receipt_identity(uuid, text, text)',
    'public.payroll_finalise_pay_run(uuid)',
    'public.revoke_api_key(uuid)',
    'public.run_data_completeness_scan(uuid)',
    'public.run_data_completeness_scan_all()',
    'public.write_audit_log()'
  ]
  LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_fn);
    EXCEPTION WHEN undefined_function THEN
      RAISE NOTICE 'skip (not found): %', v_fn;
    END;
  END LOOP;
END $$;
