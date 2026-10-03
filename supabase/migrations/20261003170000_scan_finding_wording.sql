-- FAKE-02: the data checks say only what they check.
--
-- The Scan page runs public.run_data_completeness_scan. Two of its findings described something
-- the check does not test:
--   * bill_high_value_no_attachment tests bills.attached_at, which is set when a bill is attached
--     to a job (bills-attach, receipt-webhook). Its finding said the bill had "no attached
--     invoice/receipt" and cited a substantiation ruling, although every bill row has its source
--     document. It now says the bill is not attached to a job.
--   * bill_gst_mismatch compares GST with 1/11 of the total. Its finding said GST "should be" 1/11,
--     which is wrong for bills that mix taxable and GST-free items. It now states the comparison
--     and when a difference is expected.
--
-- Body otherwise identical to 20260702150000_advisor_p0_security_fixes.sql (auth guard included).
-- CREATE OR REPLACE keeps the function's existing grants and the anon revoke.
-- These two checks now also refresh title/description on conflict, so the wording follows the SQL.
-- Existing findings are reworded here so they read correctly before the next run.

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
    'Bill over $1,000 is not attached to a job',
    'This bill is over $1,000 and has not been attached to a job yet. Attach it to the job it belongs to, or confirm it is an overhead.',
    '/bills/' || b.id::text, 'Attach to job', now()
  FROM public.bills b
  WHERE b.organization_id = p_org_id AND b.deleted_at IS NULL
    AND b.status NOT IN ('void')
    AND b.total_inc_gst_cents > 100000
    AND b.attached_at IS NULL
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL,
    title = EXCLUDED.title, description = EXCLUDED.description, fix_action = EXCLUDED.fix_action;

  INSERT INTO public.data_completeness_findings (organization_id, check_code, resource_type, resource_id, severity, title, description, fix_url, fix_action, last_seen_at)
  SELECT p_org_id, 'bill_gst_mismatch', 'bill', b.id, 'warning',
    'GST is not 1/11 of the total',
    'Recorded GST is $' || ROUND(b.gst_cents / 100.0, 2)::text ||
      '; 1/11 of the $' || ROUND(b.total_inc_gst_cents / 100.0, 2)::text || ' total would be $' ||
      ROUND(b.total_inc_gst_cents / 11.0 / 100.0, 2)::text ||
      '. That is expected when a bill mixes taxable and GST-free items; otherwise check the GST against the tax invoice.',
    '/bills/' || b.id::text, 'Review GST', now()
  FROM public.bills b
  WHERE b.organization_id = p_org_id AND b.deleted_at IS NULL AND b.status NOT IN ('void')
    AND b.total_inc_gst_cents > 10000 AND b.gst_cents IS NOT NULL AND b.gst_cents > 0
    AND ABS(b.gst_cents - ROUND(b.total_inc_gst_cents / 11.0)::bigint) > 200
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL,
    title = EXCLUDED.title, description = EXCLUDED.description;

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

UPDATE public.data_completeness_findings
   SET title = 'Bill over $1,000 is not attached to a job',
       description = 'This bill is over $1,000 and has not been attached to a job yet. Attach it to the job it belongs to, or confirm it is an overhead.',
       fix_action = 'Attach to job'
 WHERE check_code = 'bill_high_value_no_attachment';

UPDATE public.data_completeness_findings f
   SET title = 'GST is not 1/11 of the total',
       description = 'Recorded GST is $' || ROUND(b.gst_cents / 100.0, 2)::text ||
         '; 1/11 of the $' || ROUND(b.total_inc_gst_cents / 100.0, 2)::text || ' total would be $' ||
         ROUND(b.total_inc_gst_cents / 11.0 / 100.0, 2)::text ||
         '. That is expected when a bill mixes taxable and GST-free items; otherwise check the GST against the tax invoice.'
  FROM public.bills b
 WHERE f.check_code = 'bill_gst_mismatch'
   AND f.resource_id = b.id
   AND b.gst_cents IS NOT NULL
   AND b.total_inc_gst_cents IS NOT NULL;
