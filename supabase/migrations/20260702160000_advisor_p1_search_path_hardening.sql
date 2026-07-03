-- P1 security-advisor hardening: pin search_path on all 26 functions flagged
-- by the function_search_path_mutable lint (get_advisors, verified live
-- 2026-07-02 against prod dxoikltymmknxqpkpyhi — the exact 26 names below
-- came from the advisor's own metadata, not guessed).
--
-- Risk model: an unpinned search_path lets a caller who can create objects in
-- a schema (e.g. a temp schema, or any schema earlier in their session's
-- search_path) shadow an unqualified reference inside the function body with
-- their own object. For SECURITY DEFINER functions this means code the
-- attacker controls can run with the DEFINER's elevated privileges — the
-- classic Postgres search_path privilege-escalation vector. Only 2 of the 26
-- are SECURITY DEFINER (check_rate_limit, deduct_credits) — those are the
-- functions where this was a real (if narrow) risk; both bodies were read in
-- full and only reference schema-qualified public.* tables, so pinning
-- changes no behavior, it only removes the residual attack surface. The
-- other 24 are SECURITY INVOKER (10 are zero-arg trigger functions) — lower
-- risk since they run with the calling user's own privileges, not elevated
-- ones, but pinning is the standard Supabase-recommended fix regardless and
-- is free to apply.
--
-- Fix: `SET search_path = public, pg_temp` on each — this is the standard,
-- purely additive remediation for this lint (matches Supabase's own
-- database-linter docs, lint 0011). pg_catalog is always implicitly searched
-- first by Postgres regardless of this setting, so built-ins are unaffected;
-- pg_temp is included so session temp tables still resolve normally.
--
-- Idempotent: ALTER FUNCTION ... SET is safe to re-run. Wrapped in a DO block
-- so a signature mismatch on any one function reports and skips rather than
-- aborting the whole migration.

DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.set_updated_at()',
    'public.block_modifications()',
    'public.trg_recompute_overhead()',
    'public.trg_overhead_profile_changed()',
    'public.compute_loaded_hourly_rate(uuid, date)',
    'public.recompute_overhead_for_date(uuid, date)',
    'public.onboarding_progress(uuid)',
    'public.normalise_supplier_name(text)',
    'public.match_job_for_bill(uuid, text)',
    'public.lookup_known_sender(text)',
    'public.match_intake_rule(uuid, text, text, text)',
    'public.extract_addresses(text)',
    'public.record_intake_rule_hit(uuid)',
    'public.business_profile_signals(uuid)',
    'public.timesheet_recompute_cost()',
    'public.payroll_set_updated_at()',
    'public.handle_updated_at()',
    'public.check_rate_limit(text, integer, integer)',
    'public.deduct_credits(uuid, integer)',
    'public.au_bas_quarter(date)',
    'public.enforce_split_total()',
    'public.calc_payg_tax(bigint, text, boolean)',
    'public._payg_pick_tier(bigint, integer, integer)',
    'public.block_resolved_decision_change()',
    'public.check_period_lock_v2()',
    'public.au_sg_rate_pct(date)'
  ]
  LOOP
    BEGIN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', v_fn);
    EXCEPTION WHEN undefined_function THEN
      RAISE NOTICE 'skip (signature not found, needs manual check): %', v_fn;
    END;
  END LOOP;
END $$;
