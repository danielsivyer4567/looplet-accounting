-- 0053: Data completeness / tax-readiness scan.
--
-- Runs ~10 systematic checks across the user's books and persists findings
-- with severity. Each finding has a fix_url so the user can click to resolve.
-- Cron runs nightly + edge fn for on-demand.

CREATE TABLE IF NOT EXISTS public.data_completeness_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Finding identity (used to dedupe across runs)
  check_code text NOT NULL,                  -- e.g. 'suppliers_without_abn_tpar', 'bills_no_category'
  resource_type text,                        -- 'bill', 'supplier', 'invoice', 'subscription', 'org_profile'
  resource_id uuid,                          -- the row that failed the check (if applicable)
  -- Display
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title text NOT NULL,
  description text,
  fix_url text,                              -- relative URL e.g. '/suppliers/123' or '/settings'
  fix_action text,                           -- short verb like "Add ABN" or "Set GST registered date"
  -- Audit / dedupe
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  is_muted boolean NOT NULL DEFAULT false,   -- user can permanently mute "I know about this, don't tell me again"
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Dedupe: one finding per (org, check_code, resource_id)
CREATE UNIQUE INDEX IF NOT EXISTS data_completeness_findings_unique
  ON public.data_completeness_findings (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS data_completeness_findings_open_idx
  ON public.data_completeness_findings (organization_id, severity, last_seen_at DESC)
  WHERE resolved_at IS NULL AND is_muted = false;

ALTER TABLE public.data_completeness_findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY data_completeness_findings_select ON public.data_completeness_findings
  FOR SELECT USING (organization_id IN (SELECT public.get_accessible_org_ids()));

CREATE POLICY data_completeness_findings_update ON public.data_completeness_findings
  FOR UPDATE USING (organization_id IN (SELECT public.get_accessible_org_ids()))
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

GRANT SELECT, UPDATE ON public.data_completeness_findings TO authenticated;

-- =================================================================
-- The scan function — runs all checks for one org and upserts findings.
-- Returns a summary count by severity.
-- =================================================================
CREATE OR REPLACE FUNCTION public.run_data_completeness_scan(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_critical int := 0;
  v_warning int := 0;
  v_info int := 0;
  v_resolved int := 0;
BEGIN
  -- ===== CHECK 1: subbies without ABN (TPAR violation risk) =====
  -- Suppliers with category=subcontractor (per intake_rules or bills) AND no ABN
  WITH offenders AS (
    SELECT DISTINCT s.id, s.name
    FROM public.suppliers s
    WHERE s.organization_id = p_org_id
      AND s.deleted_at IS NULL
      AND (s.abn IS NULL OR length(trim(s.abn)) = 0)
      AND (
        EXISTS (SELECT 1 FROM public.intake_rules r WHERE r.supplier_id = s.id AND r.category_code = 'subcontractor')
        OR EXISTS (SELECT 1 FROM public.bills b WHERE b.supplier_id = s.id AND b.category_code = 'subcontractor')
      )
  )
  INSERT INTO public.data_completeness_findings (
    organization_id, check_code, resource_type, resource_id,
    severity, title, description, fix_url, fix_action, last_seen_at
  )
  SELECT
    p_org_id, 'subbie_without_abn', 'supplier', o.id,
    'critical',
    'Subcontractor "' || o.name || '" has no ABN',
    'TPAR-reportable subbies must have an ABN. Without it you may need to withhold 47% PAYG and the supplier breach is reportable to ATO.',
    '/suppliers/' || o.id::text,
    'Add ABN',
    now()
  FROM offenders o
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL;

  GET DIAGNOSTICS v_critical = ROW_COUNT;

  -- ===== CHECK 2: bills with no category_code (won't classify in Xero) =====
  INSERT INTO public.data_completeness_findings (
    organization_id, check_code, resource_type, resource_id,
    severity, title, description, fix_url, fix_action, last_seen_at
  )
  SELECT
    p_org_id, 'bill_no_category', 'bill', b.id,
    'warning',
    'Bill from ' || COALESCE((SELECT s.name FROM public.suppliers s WHERE s.id = b.supplier_id), b.supplier_name_raw, 'unknown') || ' missing category',
    'Without a category code this bill won''t map to a Xero account on push.',
    '/bills/' || b.id::text,
    'Pick category',
    now()
  FROM public.bills b
  WHERE b.organization_id = p_org_id
    AND b.deleted_at IS NULL
    AND b.status NOT IN ('void')
    AND (b.category_code IS NULL OR length(trim(b.category_code)) = 0)
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL;

  -- ===== CHECK 3: high-value bills with no attachment (substantiation risk) =====
  -- ATO requires receipts for items > $82.50 inc GST; we flag > $1000 with no source.
  INSERT INTO public.data_completeness_findings (
    organization_id, check_code, resource_type, resource_id,
    severity, title, description, fix_url, fix_action, last_seen_at
  )
  SELECT
    p_org_id, 'bill_high_value_no_attachment', 'bill', b.id,
    'warning',
    'Bill > $1000 has no attached invoice/receipt',
    'ATO substantiation rules (TR 95/14) require records for purchases over $82.50. This bill is over $1000 with no source document attached.',
    '/bills/' || b.id::text,
    'Attach receipt',
    now()
  FROM public.bills b
  WHERE b.organization_id = p_org_id
    AND b.deleted_at IS NULL
    AND b.status NOT IN ('draft', 'void')
    AND b.total_inc_gst_cents > 100000
    AND b.source_email_id IS NULL
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL;

  -- ===== CHECK 4: GST math mismatch =====
  -- For inc-GST bills, gst_cents should be round(total / 11)
  INSERT INTO public.data_completeness_findings (
    organization_id, check_code, resource_type, resource_id,
    severity, title, description, fix_url, fix_action, last_seen_at
  )
  SELECT
    p_org_id, 'bill_gst_mismatch', 'bill', b.id,
    'warning',
    'GST math doesn''t check out',
    'Bill total inc GST is $' || (b.total_inc_gst_cents / 100.0)::text ||
      ' so GST should be ~$' || ROUND(b.total_inc_gst_cents / 11.0 / 100.0, 2)::text ||
      ' but recorded as $' || (b.gst_cents / 100.0)::text || '.',
    '/bills/' || b.id::text,
    'Review GST',
    now()
  FROM public.bills b
  WHERE b.organization_id = p_org_id
    AND b.deleted_at IS NULL
    AND b.status NOT IN ('draft', 'void')
    AND b.total_inc_gst_cents > 10000
    AND b.gst_cents IS NOT NULL
    AND b.gst_cents > 0
    AND ABS(b.gst_cents - ROUND(b.total_inc_gst_cents / 11.0)::bigint) > 200  -- > 2c off
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL;

  -- ===== CHECK 5: overdue invoices (collection risk) =====
  INSERT INTO public.data_completeness_findings (
    organization_id, check_code, resource_type, resource_id,
    severity, title, description, fix_url, fix_action, last_seen_at
  )
  SELECT
    p_org_id, 'invoice_overdue_60d', 'invoice', i.id,
    'warning',
    'Invoice ' || COALESCE(i.invoice_number, 'unnumbered') || ' is over 60 days overdue',
    '$' || (i.balance_due_cents / 100.0)::text || ' outstanding from ' ||
      COALESCE((SELECT c.name FROM public.customers c WHERE c.id = i.customer_id), 'unknown customer') ||
      ' (due ' || i.due_date::text || '). Consider sending a reminder.',
    '/invoices/' || i.id::text,
    'Follow up',
    now()
  FROM public.invoices i
  WHERE i.organization_id = p_org_id
    AND i.deleted_at IS NULL
    AND i.status NOT IN ('paid', 'void')
    AND i.balance_due_cents > 0
    AND i.due_date < CURRENT_DATE - INTERVAL '60 days'
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL;

  -- ===== CHECK 6: motor vehicle bills but no logbook on profile =====
  INSERT INTO public.data_completeness_findings (
    organization_id, check_code, resource_type, resource_id,
    severity, title, description, fix_url, fix_action, last_seen_at
  )
  SELECT
    p_org_id, 'vehicle_expenses_no_logbook', 'org_profile', p_org_id,
    'warning',
    'Motor vehicle expenses claimed but no logbook on file',
    'You have $' || (
      SELECT (SUM(total_inc_gst_cents) / 100.0)::text FROM public.bills
       WHERE organization_id = p_org_id AND category_code = 'motor_vehicle' AND deleted_at IS NULL
    ) || ' in motor vehicle bills but Business Profile says no logbook. Cents-per-km method caps at 5,000km/year. ' ||
       'For higher claims you need a 12-week logbook (FBT) or full year for sole traders.',
    '/settings',
    'Fix profile',
    now()
  FROM public.business_profile bp
  WHERE bp.organization_id = p_org_id
    AND bp.has_logbook = false
    AND EXISTS (
      SELECT 1 FROM public.bills b
       WHERE b.organization_id = p_org_id AND b.category_code = 'motor_vehicle'
         AND b.deleted_at IS NULL AND b.total_inc_gst_cents > 0
    )
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL;

  -- ===== CHECK 7: subscriptions with no business/personal classification =====
  INSERT INTO public.data_completeness_findings (
    organization_id, check_code, resource_type, resource_id,
    severity, title, description, fix_url, fix_action, last_seen_at
  )
  SELECT
    p_org_id, 'subscription_unclassified', 'subscription', s.id,
    'info',
    'Subscription "' || s.merchant_name || '" not tagged business/personal',
    'Tag this as business (deductible) or personal (not deductible) so it rolls up correctly in your P&L.',
    '/subscriptions/' || s.id::text,
    'Tag',
    now()
  FROM public.subscriptions s
  WHERE s.organization_id = p_org_id
    AND s.status NOT IN ('cancelled', 'dismissed')
    AND s.is_personal = false
    AND s.is_business = false  -- v0 default for unclassified
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL;

  -- ===== CHECK 8: business profile missing critical fields =====
  WITH missing AS (
    SELECT
      CASE WHEN bp.entity_type IS NULL THEN 'entity_type' END AS f
    FROM public.business_profile bp WHERE bp.organization_id = p_org_id
    UNION ALL SELECT
      CASE WHEN bp.state_code IS NULL THEN 'state_code' END
    FROM public.business_profile bp WHERE bp.organization_id = p_org_id
    UNION ALL SELECT
      CASE WHEN bp.aggregated_turnover_bracket IS NULL OR bp.aggregated_turnover_bracket = 'unknown' THEN 'turnover_bracket' END
    FROM public.business_profile bp WHERE bp.organization_id = p_org_id
    UNION ALL SELECT
      CASE WHEN bp.is_gst_registered IS NULL OR (bp.is_gst_registered = true AND bp.bas_frequency IS NULL) THEN 'gst_or_bas_frequency' END
    FROM public.business_profile bp WHERE bp.organization_id = p_org_id
  )
  INSERT INTO public.data_completeness_findings (
    organization_id, check_code, resource_type, resource_id,
    severity, title, description, fix_url, fix_action, last_seen_at
  )
  SELECT
    p_org_id, 'profile_incomplete', 'org_profile', p_org_id,
    'info',
    'Business profile incomplete: ' || string_agg(f, ', '),
    'The /ask bot uses these fields to tailor tax advice. Filling them in makes answers much more specific.',
    '/settings',
    'Complete profile',
    now()
  FROM missing
  WHERE f IS NOT NULL
  HAVING COUNT(f) > 0
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL, title = EXCLUDED.title;

  -- ===== CHECK 9: bills tagged is_personal but with business category =====
  INSERT INTO public.data_completeness_findings (
    organization_id, check_code, resource_type, resource_id,
    severity, title, description, fix_url, fix_action, last_seen_at
  )
  SELECT
    p_org_id, 'bill_personal_with_business_category', 'bill', b.id,
    'warning',
    'Bill flagged personal but has a business category',
    'is_personal=true means this won''t hit your business P&L, yet category_code is set to a deductible business code. One of them is wrong.',
    '/bills/' || b.id::text,
    'Reconcile',
    now()
  FROM public.bills b
  WHERE b.organization_id = p_org_id
    AND b.deleted_at IS NULL
    AND b.is_personal = true
    AND b.category_code IS NOT NULL
    AND b.category_code NOT IN ('personal_expense', 'uncategorized')
  ON CONFLICT (organization_id, check_code, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET last_seen_at = now(), resolved_at = NULL;

  -- ===== AUTO-RESOLVE: clear findings whose underlying problem is now fixed =====
  -- We do this by looking for findings whose last_seen_at is older than this run
  -- (i.e. the check didn't re-emit them this time, so they're resolved).
  UPDATE public.data_completeness_findings
  SET resolved_at = now()
  WHERE organization_id = p_org_id
    AND resolved_at IS NULL
    AND last_seen_at < now() - INTERVAL '5 seconds';  -- everything we just upserted is < 5s old

  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  -- Summary
  SELECT
    COUNT(*) FILTER (WHERE severity = 'critical' AND resolved_at IS NULL AND is_muted = false),
    COUNT(*) FILTER (WHERE severity = 'warning'  AND resolved_at IS NULL AND is_muted = false),
    COUNT(*) FILTER (WHERE severity = 'info'     AND resolved_at IS NULL AND is_muted = false)
  INTO v_critical, v_warning, v_info
  FROM public.data_completeness_findings WHERE organization_id = p_org_id;

  RETURN jsonb_build_object(
    'ok', true,
    'organization_id', p_org_id,
    'critical', v_critical,
    'warning', v_warning,
    'info', v_info,
    'resolved_this_run', v_resolved,
    'scanned_at', now()
  );
END $$;

GRANT EXECUTE ON FUNCTION public.run_data_completeness_scan(uuid) TO authenticated;
