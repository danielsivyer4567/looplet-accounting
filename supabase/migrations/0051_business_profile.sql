-- 0051: business_profile — structured per-org context the /ask bot reads on every
-- question so answers are tailored to the user's actual situation.
--
-- One row per organization. Most fields nullable; the bot treats unknowns as
-- "I don't know your X — answer covers the common cases."

CREATE TABLE IF NOT EXISTS public.business_profile (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Entity structure (drives most tax outcomes)
  entity_type text CHECK (entity_type IN ('sole_trader', 'partnership', 'company', 'trust', 'other')),
  industry_code text,                          -- ATO industry code (e.g. '32990' for fencing)
  industry_label text,                         -- "Fencing services"
  state_code text CHECK (state_code IN ('QLD','NSW','VIC','WA','SA','TAS','NT','ACT')),

  -- GST / BAS
  is_gst_registered boolean DEFAULT false,
  gst_registered_since date,
  bas_frequency text CHECK (bas_frequency IN ('monthly','quarterly','annual','not_required')),
  bas_paygw_included boolean DEFAULT false,    -- PAYG withholding on BAS

  -- Turnover & SBE eligibility (drives instant asset write-off, simplified depreciation, etc.)
  aggregated_turnover_bracket text CHECK (
    aggregated_turnover_bracket IN ('under_2m', 'under_10m', 'under_50m', 'over_50m', 'unknown')
  ),
  estimated_annual_turnover_cents bigint,      -- user-entered estimate (refines bracket)

  -- Tax registrations
  is_fbt_registered boolean DEFAULT false,
  is_paygi_registered boolean DEFAULT false,   -- PAYG instalments
  is_paygw_registered boolean DEFAULT false,   -- PAYG withholding (if employees)
  is_workcover_registered boolean DEFAULT false,

  -- Workforce composition
  employees_count int DEFAULT 0,
  subbies_count int DEFAULT 0,                 -- subcontractors paid via TPAR
  is_tpar_required boolean DEFAULT false,      -- Taxable Payments Annual Report

  -- Vehicles & office
  vehicle_count int DEFAULT 0,
  primary_vehicle_business_use_pct int CHECK (primary_vehicle_business_use_pct BETWEEN 0 AND 100),
  has_logbook boolean,
  office_setup text CHECK (office_setup IN ('home_office', 'commercial_premises', 'mobile_only', 'mixed')),

  -- Free-text scratchpad (anything specific the bot should know)
  notes text,

  -- Audit
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- Updated-at trigger
CREATE TRIGGER trg_business_profile_updated
  BEFORE UPDATE ON public.business_profile
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS — read/write for org members
ALTER TABLE public.business_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY business_profile_select ON public.business_profile
  FOR SELECT USING (organization_id IN (SELECT public.get_accessible_org_ids()));

CREATE POLICY business_profile_insert ON public.business_profile
  FOR INSERT WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

CREATE POLICY business_profile_update ON public.business_profile
  FOR UPDATE USING (organization_id IN (SELECT public.get_accessible_org_ids()))
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

CREATE POLICY business_profile_delete ON public.business_profile
  FOR DELETE USING (organization_id IN (SELECT public.get_accessible_org_ids()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_profile TO authenticated;

-- Convenience view: profile + auto-derived live signals from the user's data.
-- The /ask bot reads from here so it gets everything in one query.
CREATE OR REPLACE VIEW public.v_business_context AS
SELECT
  o.id AS organization_id,
  o.name AS organization_name,
  bp.entity_type,
  bp.industry_code,
  bp.industry_label,
  bp.state_code,
  bp.is_gst_registered,
  bp.gst_registered_since,
  bp.bas_frequency,
  bp.bas_paygw_included,
  bp.aggregated_turnover_bracket,
  bp.estimated_annual_turnover_cents,
  bp.is_fbt_registered,
  bp.is_paygi_registered,
  bp.is_paygw_registered,
  bp.is_workcover_registered,
  bp.employees_count,
  bp.subbies_count,
  bp.is_tpar_required,
  bp.vehicle_count,
  bp.primary_vehicle_business_use_pct,
  bp.has_logbook,
  bp.office_setup,
  bp.notes,
  -- Auto-derived from data
  (SELECT COUNT(*) FROM public.employees e WHERE e.organization_id = o.id AND e.deleted_at IS NULL) AS live_employees_count,
  (SELECT COUNT(*) FROM public.suppliers s WHERE s.organization_id = o.id AND s.deleted_at IS NULL) AS live_suppliers_count,
  (SELECT COUNT(*) FROM public.customers c WHERE c.organization_id = o.id AND c.deleted_at IS NULL) AS live_customers_count,
  (SELECT COUNT(*) FROM public.jobs j WHERE j.organization_id = o.id AND j.deleted_at IS NULL AND j.status = 'active') AS live_active_jobs_count,
  (SELECT COALESCE(revenue_inc_gst_cents, 0) FROM public.v_organization_realtime_pnl p WHERE p.organization_id = o.id) AS live_revenue_inc_gst_cents,
  (SELECT COALESCE(gross_profit_cents, 0) FROM public.v_organization_realtime_pnl p WHERE p.organization_id = o.id) AS live_gross_profit_cents,
  (SELECT MAX(quarter_end) FROM public.v_bas_quarterly q WHERE q.organization_id = o.id AND q.due_date >= CURRENT_DATE - INTERVAL '180 days') AS next_bas_due_quarter_end
FROM public.organizations o
LEFT JOIN public.business_profile bp ON bp.organization_id = o.id
WHERE o.deleted_at IS NULL;

GRANT SELECT ON public.v_business_context TO authenticated;
