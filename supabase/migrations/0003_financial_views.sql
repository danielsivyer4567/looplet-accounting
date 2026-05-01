-- ============================================================================
-- Migration: 0003_financial_views
-- The Phase 4 math: per-job P&L, GST netting, tax set-aside, "really yours".
--
-- All views are SECURITY INVOKER (default) so RLS on the underlying tables
-- gates per-tenant access automatically. Querying any of these as a logged-
-- in user returns only their own org's data.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. compute_loaded_hourly_rate — per ADR 0001
-- Returns the loaded $/hour for an employee on a given work date.
-- Reads `wage_components` JSONB keyed by year (e.g. "2026").
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION compute_loaded_hourly_rate(
  p_employee_id UUID,
  p_work_date DATE
) RETURNS BIGINT  -- cents
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE
  v_year         TEXT;
  v_components   JSONB;
  v_base         NUMERIC;
  v_super_pct    NUMERIC;
  v_workers_comp NUMERIC;
  v_allowances   NUMERIC;
  v_annual_cost  NUMERIC;
  v_contracted   NUMERIC;
  v_annual_leave NUMERIC;
  v_personal     NUMERIC;
  v_holidays     NUMERIC;
  v_sick         NUMERIC;
  v_admin        NUMERIC;
  v_productive   NUMERIC;
BEGIN
  v_year := EXTRACT(YEAR FROM p_work_date)::TEXT;

  SELECT wage_components -> v_year INTO v_components
    FROM employees WHERE id = p_employee_id;

  IF v_components IS NULL THEN
    -- Try previous year as fallback (for the first work day of a new year
    -- before the operator has updated their wage_components).
    v_year := (EXTRACT(YEAR FROM p_work_date)::INT - 1)::TEXT;
    SELECT wage_components -> v_year INTO v_components
      FROM employees WHERE id = p_employee_id;
  END IF;

  IF v_components IS NULL THEN
    RAISE EXCEPTION 'employee % has no wage_components for year %',
      p_employee_id, EXTRACT(YEAR FROM p_work_date)::TEXT;
  END IF;

  -- Annual cost components (defaults pulled from system_defaults if missing)
  v_base         := COALESCE((v_components->>'base_wage_cents')::NUMERIC, 0) / 100;
  v_super_pct    := COALESCE((v_components->>'super_pct')::NUMERIC,
                              (SELECT (value)::NUMERIC FROM system_defaults WHERE key='au_super_pct'));
  v_workers_comp := COALESCE((v_components->>'workers_comp_cents')::NUMERIC, 0) / 100;
  v_allowances   := COALESCE((v_components->>'allowances_cents')::NUMERIC, 0) / 100;

  v_annual_cost := v_base + (v_base * v_super_pct / 100) + v_workers_comp + v_allowances;

  -- Net productive hours (defaults from system_defaults)
  v_contracted   := COALESCE((v_components->>'contracted_hours')::NUMERIC,
                              (SELECT (value)::NUMERIC FROM system_defaults WHERE key='default_contracted_hours'));
  v_annual_leave := COALESCE((v_components->>'annual_leave_hours')::NUMERIC,
                              (SELECT (value)::NUMERIC FROM system_defaults WHERE key='default_annual_leave_hours'));
  v_personal     := COALESCE((v_components->>'personal_leave_hours')::NUMERIC,
                              (SELECT (value)::NUMERIC FROM system_defaults WHERE key='default_personal_leave_hours'));
  v_holidays     := COALESCE((v_components->>'public_holiday_hours')::NUMERIC,
                              (SELECT (value)::NUMERIC FROM system_defaults WHERE key='default_public_holiday_hours'));
  v_sick         := COALESCE((v_components->>'sick_leave_hours')::NUMERIC,
                              (SELECT (value)::NUMERIC FROM system_defaults WHERE key='default_sick_leave_hours'));
  v_admin        := COALESCE((v_components->>'admin_hours')::NUMERIC,
                              (SELECT (value)::NUMERIC FROM system_defaults WHERE key='default_admin_hours'));

  v_productive := v_contracted - v_annual_leave - v_personal - v_holidays - v_sick - v_admin;

  IF v_productive <= 0 THEN
    RAISE EXCEPTION 'productive hours computed as % for employee %', v_productive, p_employee_id;
  END IF;

  RETURN ROUND((v_annual_cost / v_productive) * 100);  -- cents
END;
$$;

COMMENT ON FUNCTION compute_loaded_hourly_rate(UUID, DATE) IS
  'Per ADR 0001. Returns loaded $/hour in cents = (annual cost of employment) / (net productive hours). Snapshot this onto wage_entries.loaded_hourly_rate_at_time_cents at insert time so historical entries do not silently rewrite when wage_components change.';

-- ----------------------------------------------------------------------------
-- B. v_job_costs — running cost ledger per job, by category
-- ----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_job_costs AS
WITH bill_costs AS (
  SELECT
    b.organization_id,
    b.job_id,
    'bills'::TEXT AS category,
    SUM(COALESCE(b.total_inc_gst_cents, 0)) AS total_cents,
    SUM(COALESCE(b.gst_cents, 0))           AS gst_cents,
    COUNT(*)::INT                           AS row_count
  FROM bills b
  WHERE b.deleted_at IS NULL
    AND b.job_id IS NOT NULL
    AND b.status IN ('attached', 'paid')
  GROUP BY b.organization_id, b.job_id
),
wage_costs AS (
  SELECT
    we.organization_id,
    we.job_id,
    'wages'::TEXT AS category,
    SUM(we.total_cost_cents) AS total_cents,
    0::BIGINT                AS gst_cents,
    COUNT(*)::INT            AS row_count
  FROM wage_entries we
  WHERE we.deleted_at IS NULL
    AND we.job_id IS NOT NULL
  GROUP BY we.organization_id, we.job_id
),
overhead_costs AS (
  SELECT
    oa.organization_id,
    oa.job_id,
    'overhead'::TEXT AS category,
    SUM(oa.amount_cents) AS total_cents,
    0::BIGINT            AS gst_cents,
    COUNT(*)::INT        AS row_count
  FROM overhead_allocations oa
  WHERE oa.job_id IS NOT NULL
  GROUP BY oa.organization_id, oa.job_id
)
SELECT * FROM bill_costs
UNION ALL SELECT * FROM wage_costs
UNION ALL SELECT * FROM overhead_costs;

COMMENT ON VIEW v_job_costs IS
  'Running per-job cost rollup by category (bills, wages, overhead). Use SUM(total_cents) to get total job cost.';

-- ----------------------------------------------------------------------------
-- C. v_job_revenue — total customer-invoiced revenue per job
-- ----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_job_revenue AS
SELECT
  ci.organization_id,
  ci.job_id,
  SUM(ci.total_inc_gst_cents)::BIGINT       AS revenue_inc_gst_cents,
  SUM(ci.subtotal_ex_gst_cents)::BIGINT     AS revenue_ex_gst_cents,
  SUM(ci.gst_cents)::BIGINT                 AS gst_collected_cents,
  SUM(ci.amount_paid_cents)::BIGINT         AS amount_paid_cents,
  COUNT(*)::INT                             AS invoice_count
FROM customer_invoices ci
WHERE ci.deleted_at IS NULL
  AND ci.job_id IS NOT NULL
  AND ci.status IN ('sent','partially_paid','paid','overdue')
GROUP BY ci.organization_id, ci.job_id;

-- ----------------------------------------------------------------------------
-- D. v_job_pnl — the headline per-job P&L
-- Joins jobs with cost rollup + revenue rollup.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_job_pnl AS
SELECT
  j.id                    AS job_id,
  j.organization_id,
  j.job_number,
  j.name                  AS job_name,
  j.status                AS job_status,
  j.start_date,
  j.end_date,
  COALESCE(r.revenue_inc_gst_cents, 0)   AS revenue_inc_gst_cents,
  COALESCE(r.revenue_ex_gst_cents, 0)    AS revenue_ex_gst_cents,
  COALESCE(r.gst_collected_cents, 0)     AS gst_collected_cents,

  -- Costs by category
  COALESCE((SELECT SUM(total_cents) FROM v_job_costs c
             WHERE c.job_id = j.id AND c.category = 'bills'),    0) AS cost_bills_cents,
  COALESCE((SELECT SUM(total_cents) FROM v_job_costs c
             WHERE c.job_id = j.id AND c.category = 'wages'),    0) AS cost_wages_cents,
  COALESCE((SELECT SUM(total_cents) FROM v_job_costs c
             WHERE c.job_id = j.id AND c.category = 'overhead'), 0) AS cost_overhead_cents,
  COALESCE((SELECT SUM(gst_cents)   FROM v_job_costs c
             WHERE c.job_id = j.id),                              0) AS gst_input_credit_cents,
  COALESCE((SELECT SUM(total_cents) FROM v_job_costs c
             WHERE c.job_id = j.id),                              0) AS total_cost_cents,

  -- Net profit (cash-basis): revenue - cost
  COALESCE(r.revenue_inc_gst_cents, 0)
    - COALESCE((SELECT SUM(total_cents) FROM v_job_costs c WHERE c.job_id = j.id), 0)
    AS gross_profit_cents,

  j.budget_cents,
  j.currency_code
FROM jobs j
LEFT JOIN v_job_revenue r ON r.job_id = j.id
WHERE j.deleted_at IS NULL;

COMMENT ON VIEW v_job_pnl IS
  'The headline per-job P&L. revenue_inc_gst - (bills + wages + overhead) = gross_profit. Tax set-aside and "what is really yours" are computed at organization level (see v_organization_realtime_pnl).';

-- ----------------------------------------------------------------------------
-- E. v_gst_summary_by_quarter — netted BAS-quarter view per org
-- ----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_gst_summary_by_quarter AS
WITH bas_quarters AS (
  SELECT
    organization_id,
    -- AU BAS quarters: Q1 Jul-Sep, Q2 Oct-Dec, Q3 Jan-Mar, Q4 Apr-Jun
    -- Encode as 'FYxxxx-Qy' string keyed off the AU fiscal year boundary
    CASE
      WHEN EXTRACT(MONTH FROM invoice_date) IN (7,8,9)
        THEN 'FY' || (EXTRACT(YEAR FROM invoice_date) + 1)::INT || '-Q1'
      WHEN EXTRACT(MONTH FROM invoice_date) IN (10,11,12)
        THEN 'FY' || (EXTRACT(YEAR FROM invoice_date) + 1)::INT || '-Q2'
      WHEN EXTRACT(MONTH FROM invoice_date) IN (1,2,3)
        THEN 'FY' || EXTRACT(YEAR FROM invoice_date)::INT || '-Q3'
      WHEN EXTRACT(MONTH FROM invoice_date) IN (4,5,6)
        THEN 'FY' || EXTRACT(YEAR FROM invoice_date)::INT || '-Q4'
    END AS bas_quarter,
    'output'::TEXT AS direction,
    SUM(gst_cents)::BIGINT AS gst_cents
  FROM customer_invoices
  WHERE deleted_at IS NULL
    AND invoice_date IS NOT NULL
    AND status IN ('sent','partially_paid','paid','overdue')
  GROUP BY organization_id, invoice_date

  UNION ALL

  SELECT
    organization_id,
    CASE
      WHEN EXTRACT(MONTH FROM invoice_date) IN (7,8,9)
        THEN 'FY' || (EXTRACT(YEAR FROM invoice_date) + 1)::INT || '-Q1'
      WHEN EXTRACT(MONTH FROM invoice_date) IN (10,11,12)
        THEN 'FY' || (EXTRACT(YEAR FROM invoice_date) + 1)::INT || '-Q2'
      WHEN EXTRACT(MONTH FROM invoice_date) IN (1,2,3)
        THEN 'FY' || EXTRACT(YEAR FROM invoice_date)::INT || '-Q3'
      WHEN EXTRACT(MONTH FROM invoice_date) IN (4,5,6)
        THEN 'FY' || EXTRACT(YEAR FROM invoice_date)::INT || '-Q4'
    END AS bas_quarter,
    'input'::TEXT AS direction,
    SUM(gst_cents)::BIGINT AS gst_cents
  FROM bills
  WHERE deleted_at IS NULL
    AND invoice_date IS NOT NULL
    AND status IN ('attached','paid')
  GROUP BY organization_id, invoice_date
)
SELECT
  organization_id,
  bas_quarter,
  SUM(CASE WHEN direction = 'output' THEN gst_cents ELSE 0 END)::BIGINT AS gst_collected_cents,
  SUM(CASE WHEN direction = 'input'  THEN gst_cents ELSE 0 END)::BIGINT AS gst_paid_cents,
  (SUM(CASE WHEN direction = 'output' THEN gst_cents ELSE 0 END)
   - SUM(CASE WHEN direction = 'input' THEN gst_cents ELSE 0 END))::BIGINT AS net_gst_owed_cents
FROM bas_quarters
WHERE bas_quarter IS NOT NULL
GROUP BY organization_id, bas_quarter
ORDER BY bas_quarter;

COMMENT ON VIEW v_gst_summary_by_quarter IS
  'Per-org GST netted by AU BAS quarter. positive net_gst_owed = pay ATO; negative = ATO owes refund. Period locking on bills/customer_invoices governs which quarters are still mutable.';

-- ----------------------------------------------------------------------------
-- F. v_organization_realtime_pnl — YTD across the whole org, tax set-aside
-- ----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_organization_realtime_pnl AS
SELECT
  o.id                                       AS organization_id,
  o.name                                     AS organization_name,
  o.settings,
  COALESCE(SUM(p.revenue_inc_gst_cents), 0)  AS revenue_inc_gst_cents,
  COALESCE(SUM(p.revenue_ex_gst_cents),  0)  AS revenue_ex_gst_cents,
  COALESCE(SUM(p.gst_collected_cents),   0)  AS gst_collected_cents,
  COALESCE(SUM(p.gst_input_credit_cents),0)  AS gst_input_credit_cents,
  (COALESCE(SUM(p.gst_collected_cents), 0)
   - COALESCE(SUM(p.gst_input_credit_cents), 0))::BIGINT
                                             AS gst_set_aside_cents,
  COALESCE(SUM(p.cost_bills_cents),    0)    AS cost_bills_cents,
  COALESCE(SUM(p.cost_wages_cents),    0)    AS cost_wages_cents,
  COALESCE(SUM(p.cost_overhead_cents), 0)    AS cost_overhead_cents,
  COALESCE(SUM(p.total_cost_cents),    0)    AS total_cost_cents,
  COALESCE(SUM(p.gross_profit_cents),  0)    AS gross_profit_cents,
  -- Tax set-aside: per ADR 0003, fixed pct from settings (default 25)
  ROUND(
    COALESCE(SUM(p.gross_profit_cents), 0)
    * COALESCE((o.settings ->> 'tax_set_aside_pct')::NUMERIC,
               (SELECT (value)::NUMERIC FROM system_defaults WHERE key='default_tax_set_aside_pct'))
    / 100
  )::BIGINT                                  AS tax_set_aside_cents,
  -- "What's really yours" = gross_profit - gst_set_aside - tax_set_aside
  (COALESCE(SUM(p.gross_profit_cents), 0)
    - (COALESCE(SUM(p.gst_collected_cents),0) - COALESCE(SUM(p.gst_input_credit_cents),0))
    - ROUND(
        COALESCE(SUM(p.gross_profit_cents), 0)
        * COALESCE((o.settings ->> 'tax_set_aside_pct')::NUMERIC,
                   (SELECT (value)::NUMERIC FROM system_defaults WHERE key='default_tax_set_aside_pct'))
        / 100
      )
  )::BIGINT                                  AS really_yours_cents
FROM organizations o
LEFT JOIN v_job_pnl p ON p.organization_id = o.id
WHERE o.deleted_at IS NULL
GROUP BY o.id, o.name, o.settings;

COMMENT ON VIEW v_organization_realtime_pnl IS
  'YTD across the whole org. The headline really_yours_cents is the punchline of the product: revenue - all costs - GST owed - income tax set-aside.';

-- ----------------------------------------------------------------------------
-- G. Allocate overhead trigger — when a wage_entry lands, allocate the days
-- daily overhead proportionally per ADR 0002.
--
-- Strategy: a separate function `recompute_overhead_for_date(org, date)`
-- is invoked by an AFTER trigger on wage_entries. The function clears
-- overhead_allocations for that org+date, then re-inserts based on hours
-- distribution. Idempotent.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION recompute_overhead_for_date(
  p_org_id UUID,
  p_date DATE
) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_daily_rate BIGINT;
  v_total_hours NUMERIC;
BEGIN
  -- Get applicable daily rate (most recent overhead_profile for the org with
  -- effective_from <= p_date)
  SELECT daily_rate_cents INTO v_daily_rate
    FROM overhead_profiles
    WHERE organization_id = p_org_id AND effective_from <= p_date
    ORDER BY effective_from DESC
    LIMIT 1;

  IF v_daily_rate IS NULL THEN
    -- No overhead profile configured; nothing to allocate.
    RETURN;
  END IF;

  SELECT COALESCE(SUM(hours), 0) INTO v_total_hours
    FROM wage_entries
    WHERE organization_id = p_org_id
      AND work_date = p_date
      AND deleted_at IS NULL;

  -- Wipe existing allocations for this org+date
  DELETE FROM overhead_allocations
    WHERE organization_id = p_org_id AND allocation_date = p_date;

  IF v_total_hours = 0 THEN
    -- No labour that day; allocate the whole daily overhead to the
    -- unallocated bucket (job_id = NULL row).
    INSERT INTO overhead_allocations (organization_id, job_id, allocation_date, amount_cents, hours_basis)
    VALUES (p_org_id, NULL, p_date, v_daily_rate, 0);
    RETURN;
  END IF;

  -- Allocate proportionally to hours per job
  INSERT INTO overhead_allocations (organization_id, job_id, allocation_date, amount_cents, hours_basis)
  SELECT
    p_org_id,
    we.job_id,
    p_date,
    ROUND(v_daily_rate * (SUM(we.hours) / v_total_hours))::BIGINT,
    SUM(we.hours)
  FROM wage_entries we
  WHERE we.organization_id = p_org_id
    AND we.work_date = p_date
    AND we.deleted_at IS NULL
    AND we.job_id IS NOT NULL
  GROUP BY we.job_id;
END;
$$;

CREATE OR REPLACE FUNCTION trg_recompute_overhead() RETURNS TRIGGER AS $$
BEGIN
  PERFORM recompute_overhead_for_date(
    COALESCE(NEW.organization_id, OLD.organization_id),
    COALESCE(NEW.work_date,       OLD.work_date)
  );
  RETURN NULL;  -- AFTER trigger
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_wage_entries_recompute_overhead
  AFTER INSERT OR UPDATE OR DELETE ON wage_entries
  FOR EACH ROW EXECUTE FUNCTION trg_recompute_overhead();

-- Same for overhead_profiles changes — reallocate every date the org has
-- wages logged for. Implemented as a coarser invalidation (touches all
-- distinct work_dates for the org). Acceptable for v1.

CREATE OR REPLACE FUNCTION trg_overhead_profile_changed() RETURNS TRIGGER AS $$
DECLARE
  v_org_id UUID;
  v_date DATE;
BEGIN
  v_org_id := COALESCE(NEW.organization_id, OLD.organization_id);
  FOR v_date IN
    SELECT DISTINCT work_date FROM wage_entries
    WHERE organization_id = v_org_id AND deleted_at IS NULL
  LOOP
    PERFORM recompute_overhead_for_date(v_org_id, v_date);
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_overhead_profiles_recompute
  AFTER INSERT OR UPDATE OR DELETE ON overhead_profiles
  FOR EACH ROW EXECUTE FUNCTION trg_overhead_profile_changed();

-- ----------------------------------------------------------------------------
-- H. Grant usage on views to authenticated/service_role
-- ----------------------------------------------------------------------------

GRANT SELECT ON v_job_costs, v_job_revenue, v_job_pnl,
                v_gst_summary_by_quarter, v_organization_realtime_pnl
  TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION compute_loaded_hourly_rate(UUID, DATE),
                          recompute_overhead_for_date(UUID, DATE)
  TO authenticated, service_role;
