-- 0029 (BACKFILL): RPC functions onboarding_progress and business_profile_signals.
--
-- RECONSTRUCTION NOTE: Exist in the LIVE DB but had no repo migration. Called by the
-- frontend (useStagedEntities .rpc('onboarding_progress'); useBusinessSignals
-- .rpc('business_profile_signals')). Reconstructed verbatim from live via
-- pg_get_functiondef (read-only MCP, 2026-06-20). Depend on staged_entities (0010) and
-- jobs (0001). CREATE OR REPLACE = safe. See docs/MIGRATION_GAP_AUDIT.md.

CREATE OR REPLACE FUNCTION public.onboarding_progress(p_org_id uuid)
 RETURNS TABLE(total_entities integer, pending_count integer, needs_review_count integer, approved_count integer, dismissed_count integer, pct_complete numeric, is_complete boolean)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    COUNT(*)::INT AS total_entities,
    COUNT(*) FILTER (WHERE status='pending')::INT AS pending_count,
    COUNT(*) FILTER (WHERE status='needs_review')::INT AS needs_review_count,
    COUNT(*) FILTER (WHERE status='approved')::INT AS approved_count,
    COUNT(*) FILTER (WHERE status='dismissed')::INT AS dismissed_count,
    CASE WHEN COUNT(*) = 0 THEN 0::NUMERIC(5,2)
         ELSE ROUND(
           100.0 * COUNT(*) FILTER (WHERE status IN ('approved','dismissed'))::NUMERIC
           / COUNT(*)::NUMERIC, 2)
    END AS pct_complete,
    COUNT(*) FILTER (WHERE status IN ('pending','needs_review')) = 0
      AND COUNT(*) > 0
      AS is_complete
  FROM staged_entities
  WHERE organization_id = p_org_id;
$function$;

CREATE OR REPLACE FUNCTION public.business_profile_signals(p_org_id uuid)
 RETURNS TABLE(signal_kind text, evidence text, confidence numeric, question text, metadata jsonb)
 LANGUAGE sql
 STABLE
AS $function$
  -- Investment-property signal: real estate / property mgmt / strata correspondents
  SELECT
    'investment_property'::TEXT AS signal_kind,
    format('%s real-estate / property-management correspondents detected: %s',
      count(*),
      string_agg(display_name, ', ' ORDER BY message_count DESC)
    ) AS evidence,
    0.85::NUMERIC AS confidence,
    'Do you own investment properties? Or are you doing work for landlords?'::TEXT AS question,
    jsonb_build_object(
      'entity_ids', array_agg(id),
      'sample_brands', array_agg(DISTINCT display_name)
    ) AS metadata
  FROM staged_entities
  WHERE organization_id = p_org_id
    AND status IN ('pending','approved')
    AND (
      LOWER(display_name) ~ '(real ?estate|realty|propertyme|strata|property mgmt|property management|coomera realty|ray white|lj hooker|harcourts|century 21|elders)'
      OR LOWER(primary_email) ~ '(@.*ljhooker|@.*raywhite|@.*propertyme|@.*coomerarealty|@.*propertymanagement|@.*strata)'
    )
  HAVING count(*) >= 1

  UNION ALL

  -- SaaS / business subscriptions
  SELECT
    'business_saas'::TEXT,
    format('%s active SaaS subscriptions: %s',
      count(*),
      string_agg(DISTINCT display_name, ', ')
    ),
    0.9::NUMERIC,
    'These look like business subscriptions. Pre-approve them as recurring monthly expenses?'::TEXT,
    jsonb_build_object('entity_ids', array_agg(id), 'brands', array_agg(DISTINCT display_name))
  FROM staged_entities
  WHERE organization_id = p_org_id
    AND status IN ('pending','approved')
    AND predicted_kind = 'subscription'
    AND predicted_category = 'subscriptions_saas'
    AND attachment_count > 0
  HAVING count(*) >= 1

  UNION ALL

  -- Recurring utilities (telco/power/water/gas)
  SELECT
    'recurring_utilities'::TEXT,
    format('Utilities detected: %s', string_agg(DISTINCT display_name, ', ')),
    0.85::NUMERIC,
    'Connect these as recurring business utility expenses?'::TEXT,
    jsonb_build_object('entity_ids', array_agg(id))
  FROM staged_entities
  WHERE organization_id = p_org_id
    AND status IN ('pending','approved')
    AND predicted_category IN ('telephone_internet','utilities')
  HAVING count(*) >= 1

  UNION ALL

  -- Vehicle expenses (fuel cards / tolls / auto parts)
  SELECT
    'vehicle_fleet'::TEXT,
    format('Fleet/vehicle correspondents: %s', string_agg(DISTINCT display_name, ', ')),
    0.85::NUMERIC,
    'Set up vehicle expense tracking? We can pre-categorise fuel/tolls/repairs to account 449.'::TEXT,
    jsonb_build_object('entity_ids', array_agg(id))
  FROM staged_entities
  WHERE organization_id = p_org_id
    AND status IN ('pending','approved')
    AND predicted_category IN ('motor_vehicle','fuel')
  HAVING count(*) >= 1

  UNION ALL

  -- Insurance providers
  SELECT
    'insurance'::TEXT,
    format('Insurance: %s', string_agg(DISTINCT display_name, ', ')),
    0.9::NUMERIC,
    'Confirm these as ongoing insurance policies (vehicle / public liability / workers comp)?'::TEXT,
    jsonb_build_object('entity_ids', array_agg(id))
  FROM staged_entities
  WHERE organization_id = p_org_id
    AND status IN ('pending','approved')
    AND predicted_category = 'insurance'
  HAVING count(*) >= 1

  UNION ALL

  -- Bank accounts (statements detected)
  SELECT
    'bank_accounts'::TEXT,
    format('Bank statements detected from: %s', string_agg(DISTINCT display_name, ', ')),
    0.95::NUMERIC,
    'These are your active bank accounts. Connect them via bank-feeds for auto-reconciliation?'::TEXT,
    jsonb_build_object('entity_ids', array_agg(id))
  FROM staged_entities
  WHERE organization_id = p_org_id
    AND status IN ('pending','approved')
    AND predicted_category = 'bank_fees'
    AND (predicted_kind = 'subscription' OR LOWER(display_name) ~ '(bank|cba|nab|anz|westpac|macquarie|ing|hsbc)')
  HAVING count(*) >= 1

  UNION ALL

  -- ATO / ASIC / government — regulatory profile
  SELECT
    'regulatory_presence'::TEXT,
    format('Government correspondents: %s', string_agg(DISTINCT display_name, ', ')),
    1.0::NUMERIC,
    'Are you a sole trader or company? (We can use this to set up BAS frequency, super obligations, PAYG.)'::TEXT,
    jsonb_build_object('entity_ids', array_agg(id))
  FROM staged_entities
  WHERE organization_id = p_org_id
    AND status IN ('pending','approved')
    AND predicted_kind = 'internal_admin'
  HAVING count(*) >= 1

  UNION ALL

  -- Subcontractor labour relationships (regular invoice receivers)
  SELECT
    'regular_subcontractors'::TEXT,
    format('Frequent subcontractor invoices from: %s',
      string_agg(format('%s (%s msgs)', display_name, message_count), ', ' ORDER BY message_count DESC)
    ),
    0.85::NUMERIC,
    'Flag these as regular subcontractors and set up payment-terms / ABN tracking?'::TEXT,
    jsonb_build_object('entity_ids', array_agg(id))
  FROM staged_entities
  WHERE organization_id = p_org_id
    AND status IN ('pending','approved')
    AND predicted_kind = 'contractor'
    AND message_count >= 3
  HAVING count(*) >= 1

  UNION ALL

  -- Customer base size
  SELECT
    'customer_base'::TEXT,
    format('%s likely customers identified from sent-folder correspondents', count(*)),
    0.7::NUMERIC,
    'Pre-create customers from these contacts? You can prune the list after.'::TEXT,
    jsonb_build_object('count', count(*))
  FROM staged_entities
  WHERE organization_id = p_org_id
    AND status IN ('pending','approved')
    AND predicted_kind = 'customer'
  HAVING count(*) >= 5

  UNION ALL

  -- Active job sites
  SELECT
    'active_jobs'::TEXT,
    format('%s job site addresses extracted from email subjects', count(*)),
    1.0::NUMERIC,
    'These addresses look like active project sites. Confirm and we''ll start tracking per-job P&L immediately.'::TEXT,
    jsonb_build_object('count', count(*), 'sample', array_agg(name ORDER BY created_at DESC) FILTER (WHERE created_at > now() - interval '7 days'))
  FROM jobs
  WHERE organization_id = p_org_id
    AND deleted_at IS NULL
    AND metadata->>'source' = 'email_subject_mining'
  HAVING count(*) >= 1
;
$function$;
