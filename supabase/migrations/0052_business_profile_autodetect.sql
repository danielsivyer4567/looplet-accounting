-- 0052: business_profile_autodetect — RPC that infers profile fields from existing data.
--
-- Reduces onboarding from "fill 20 fields" to "review the auto-detected guesses
-- and tweak". Returns a JSONB shaped like the business_profile row.

CREATE OR REPLACE FUNCTION public.business_profile_autodetect(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_employees_count int;
  v_subbies_count int;
  v_is_gst_registered boolean;
  v_revenue_cents bigint;
  v_turnover_bracket text;
  v_has_pay_runs boolean;
  v_has_subbies boolean;
  v_has_motor_vehicle_bills boolean;
  v_quarterly_bas boolean;
BEGIN
  -- Verify caller has access (RLS proxy — function is invoker-rights so this is a sanity check)
  IF p_org_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  -- Count employees
  SELECT COUNT(*) INTO v_employees_count
    FROM public.employees
   WHERE organization_id = p_org_id AND deleted_at IS NULL;

  -- Count subbies — suppliers that have an intake_rule with category 'subcontractor'
  SELECT COUNT(DISTINCT s.id) INTO v_subbies_count
    FROM public.suppliers s
    LEFT JOIN public.intake_rules r ON r.supplier_id = s.id
   WHERE s.organization_id = p_org_id
     AND s.deleted_at IS NULL
     AND (r.category_code = 'subcontractor' OR
          EXISTS (SELECT 1 FROM public.bills b
                   WHERE b.supplier_id = s.id AND b.category_code = 'subcontractor'));

  -- GST registered if any bill or invoice has GST cents > 0
  SELECT EXISTS (
    SELECT 1 FROM public.bills WHERE organization_id = p_org_id AND gst_cents > 0
    UNION ALL
    SELECT 1 FROM public.invoices WHERE organization_id = p_org_id AND gst_cents > 0
  ) INTO v_is_gst_registered;

  -- Revenue from realtime PnL view
  SELECT COALESCE(revenue_inc_gst_cents, 0) INTO v_revenue_cents
    FROM public.v_organization_realtime_pnl
   WHERE organization_id = p_org_id;

  v_turnover_bracket := CASE
    WHEN v_revenue_cents IS NULL OR v_revenue_cents = 0 THEN 'unknown'
    WHEN v_revenue_cents < 200000000 THEN 'under_2m'
    WHEN v_revenue_cents < 1000000000 THEN 'under_10m'
    WHEN v_revenue_cents < 5000000000 THEN 'under_50m'
    ELSE 'over_50m'
  END;

  -- PAYG-W: has pay runs?
  SELECT EXISTS (
    SELECT 1 FROM public.pay_runs WHERE organization_id = p_org_id LIMIT 1
  ) INTO v_has_pay_runs;

  -- Has subbies (TPAR proxy)
  v_has_subbies := COALESCE(v_subbies_count, 0) > 0;

  -- Vehicles: heuristic from bills
  SELECT EXISTS (
    SELECT 1 FROM public.bills WHERE organization_id = p_org_id AND category_code = 'motor_vehicle' LIMIT 1
  ) INTO v_has_motor_vehicle_bills;

  -- BAS quarterly: assume true (most common for SBE) unless there's evidence of monthly
  v_quarterly_bas := true;

  RETURN jsonb_build_object(
    'employees_count', v_employees_count,
    'subbies_count', v_subbies_count,
    'is_gst_registered', v_is_gst_registered,
    'estimated_annual_turnover_cents', v_revenue_cents,
    'aggregated_turnover_bracket', v_turnover_bracket,
    'is_paygw_registered', v_has_pay_runs OR v_employees_count > 0,
    'is_paygi_registered', v_revenue_cents > 200000000, -- ATO PAYG-I usually kicks in around $4k tax payable, rough proxy
    'is_workcover_registered', v_has_pay_runs OR v_employees_count > 0,
    'is_tpar_required', v_has_subbies,
    'bas_frequency', CASE WHEN v_quarterly_bas THEN 'quarterly' ELSE NULL END,
    'bas_paygw_included', v_has_pay_runs,
    'vehicle_count', CASE WHEN v_has_motor_vehicle_bills THEN 1 ELSE 0 END,
    'detected_at', now(),
    'detection_notes',
      'Inferred from your books. Review and tweak fields that need correction. ' ||
      'Some fields (state, entity type, vehicle business-use %) can''t be auto-detected and need manual entry.'
  );
END $$;

GRANT EXECUTE ON FUNCTION public.business_profile_autodetect(uuid) TO authenticated;
