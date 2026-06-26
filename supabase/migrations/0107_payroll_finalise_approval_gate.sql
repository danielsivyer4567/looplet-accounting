-- 0107: Tier-2 approval gate inside payroll_finalise_pay_run.
--
-- Phase 2.D (SC-2.D.01). payroll_finalise_pay_run (0045) is the real money-mover —
-- it flips a pay run to 'paid'. This adds the Tier-2 guardrail INSIDE the RPC (not
-- the edge fn, which just rpc()s it): no finalise without a live, human-approved
-- Tier-2 approval bound to this pay run's exact slip set.
--
-- pay_run_approval_payload(run_id) is the SINGLE canonical payload definition, so
-- the request side (request_approval) and this check (is_action_approved) can never
-- drift — both pass the same jsonb, which Postgres hashes server-side (no Deno
-- serialization trap). It binds the full per-employee slip set (gross/PAYG/super/
-- net), so editing ANY slip after approval changes the hash and silently re-gates
-- (approve-then-mutate protection). SECURITY INVOKER: a direct user call is RLS-
-- scoped to their org (no cross-org slip leak), while inside the DEFINER RPC below
-- it runs as the owner and sees the full set — identical payload for any run the
-- caller can legitimately access.
--
-- The CREATE OR REPLACE preserves the live function VERBATIM (owner-only gate,
-- status guard, RETURNS pay_runs, paid_at/paid_by stamping) and inserts ONLY the
-- approval check before the status transition. The raise carries the stable token
-- 'approval required' that the edge fn (SC-2.D.02) regexes to a 403.

CREATE OR REPLACE FUNCTION public.pay_run_approval_payload(p_run_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'pay_run_id', p_run_id,
    'slips', COALESCE(
      (SELECT jsonb_agg(
                jsonb_build_object(
                  'id',                    ps.id,
                  'employee_id',           ps.employee_id,
                  'gross_total_cents',     ps.gross_total_cents,
                  'payg_tax_cents',        ps.payg_tax_cents,
                  'super_guarantee_cents', ps.super_guarantee_cents,
                  'net_pay_cents',         ps.net_pay_cents
                )
                ORDER BY ps.id)
         FROM public.pay_slips ps
        WHERE ps.pay_run_id = p_run_id),
      '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.pay_run_approval_payload(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_run_approval_payload(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.payroll_finalise_pay_run(p_run_id uuid)
RETURNS pay_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_run pay_runs;
BEGIN
  SELECT * INTO v_run FROM public.pay_runs WHERE id = p_run_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'pay_run not found: %', p_run_id; END IF;
  IF NOT public.require_role(v_run.organization_id, 'owner'::org_role) THEN
    RAISE EXCEPTION 'only owner may finalise a pay run';
  END IF;
  IF v_run.status NOT IN ('draft', 'approved') THEN
    RAISE EXCEPTION 'cannot finalise a pay run in status %', v_run.status;
  END IF;
  -- Tier-2 approval gate (SC-2.D.01): a finalise pays real money, so it must carry a
  -- live, human-approved Tier-2 approval bound to this pay run's exact slip set.
  IF NOT public.is_action_approved(
            v_run.organization_id, 'pay_run', p_run_id,
            public.pay_run_approval_payload(p_run_id)) THEN
    RAISE EXCEPTION 'approval required before finalising this pay run';
  END IF;
  UPDATE public.pay_runs SET status = 'paid', paid_at = now(), paid_by = auth.uid(), updated_at = now()
   WHERE id = p_run_id RETURNING * INTO v_run;
  RETURN v_run;
END $function$;
