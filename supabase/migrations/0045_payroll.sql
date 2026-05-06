-- ============================================================================
-- Migration: 0045_payroll
-- Project:   Looplet Accounting
-- Date:      2026-05-03
-- Purpose:   Full AU payroll: pay schedules, pay runs, payslips, leave balances.
--            Adds entry_type to timesheet_entries for payroll classification.
--            RLS: org members read; admin+ writes pay_runs/pay_slips; owner
--            finalises (status -> 'paid'). notify() used for finalisation.
--
-- Tables added:
--   pay_schedules    -- per-employee pay frequency + next period
--   pay_runs         -- batch of payslips for one period
--   pay_slips        -- one row per employee per pay run
--   leave_balances   -- annual / sick / LSL accruals + taken
--
-- Enums added:
--   pay_run_status   -- draft | approved | paid | cancelled | reversed
--
-- Columns added to existing tables:
--   timesheet_entries.entry_type
--     ('ordinary' | 'overtime' | 'annual_leave' | 'sick_leave' | 'public_holiday')
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Enums
-- ----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE pay_run_status AS ENUM ('draft', 'approved', 'paid', 'cancelled', 'reversed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 1. timesheet_entries.entry_type
-- ----------------------------------------------------------------------------

ALTER TABLE public.timesheet_entries
  ADD COLUMN IF NOT EXISTS entry_type text NOT NULL DEFAULT 'ordinary';

ALTER TABLE public.timesheet_entries
  DROP CONSTRAINT IF EXISTS timesheet_entries_entry_type_check;

ALTER TABLE public.timesheet_entries
  ADD CONSTRAINT timesheet_entries_entry_type_check
    CHECK (entry_type IN ('ordinary', 'overtime', 'annual_leave', 'sick_leave', 'public_holiday'));

CREATE INDEX IF NOT EXISTS timesheet_entries_entry_type_idx
  ON public.timesheet_entries (organization_id, employee_id, entry_type, work_date)
  WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- 2. pay_schedules
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pay_schedules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  frequency           text NOT NULL CHECK (frequency IN ('weekly', 'fortnightly', 'monthly')),
  next_period_start   date NOT NULL,
  next_period_end     date NOT NULL,
  next_pay_date       date NOT NULL,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pay_schedules_org_idx
  ON public.pay_schedules (organization_id, active);
CREATE INDEX IF NOT EXISTS pay_schedules_employee_idx
  ON public.pay_schedules (employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS pay_schedules_one_active_per_employee
  ON public.pay_schedules (employee_id) WHERE active = true;

-- ----------------------------------------------------------------------------
-- 3. pay_runs
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pay_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  pay_date            date NOT NULL,
  status              pay_run_status NOT NULL DEFAULT 'draft',
  total_gross_cents   bigint NOT NULL DEFAULT 0,
  total_tax_cents     bigint NOT NULL DEFAULT 0,
  total_super_cents   bigint NOT NULL DEFAULT 0,
  total_net_cents     bigint NOT NULL DEFAULT 0,
  approved_at         timestamptz,
  approved_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  paid_at             timestamptz,
  paid_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes               text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_runs_period_chk CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS pay_runs_org_idx
  ON public.pay_runs (organization_id, period_start DESC);
CREATE INDEX IF NOT EXISTS pay_runs_status_idx
  ON public.pay_runs (organization_id, status);

-- ----------------------------------------------------------------------------
-- 4. pay_slips
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pay_slips (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pay_run_id               uuid NOT NULL REFERENCES public.pay_runs(id) ON DELETE CASCADE,
  employee_id              uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  hours_ordinary           numeric(8,2) NOT NULL DEFAULT 0,
  hours_overtime           numeric(8,2) NOT NULL DEFAULT 0,
  hours_leave              numeric(8,2) NOT NULL DEFAULT 0,
  gross_ordinary_cents     bigint NOT NULL DEFAULT 0,
  gross_overtime_cents     bigint NOT NULL DEFAULT 0,
  gross_leave_cents        bigint NOT NULL DEFAULT 0,
  gross_total_cents        bigint NOT NULL DEFAULT 0,
  payg_tax_cents           bigint NOT NULL DEFAULT 0,
  super_guarantee_cents    bigint NOT NULL DEFAULT 0,
  super_rate_pct           numeric(5,2) NOT NULL DEFAULT 11.50,
  net_pay_cents            bigint NOT NULL,
  payment_method           text DEFAULT 'eft',
  payment_reference        text,
  ytd_gross_cents          bigint NOT NULL DEFAULT 0,
  ytd_tax_cents            bigint NOT NULL DEFAULT 0,
  ytd_super_cents          bigint NOT NULL DEFAULT 0,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_slips_run_employee_uniq UNIQUE (pay_run_id, employee_id)
);

CREATE INDEX IF NOT EXISTS pay_slips_org_idx
  ON public.pay_slips (organization_id);
CREATE INDEX IF NOT EXISTS pay_slips_run_idx
  ON public.pay_slips (pay_run_id);
CREATE INDEX IF NOT EXISTS pay_slips_employee_idx
  ON public.pay_slips (employee_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 5. leave_balances
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.leave_balances (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  leave_type          text NOT NULL CHECK (leave_type IN ('annual', 'sick', 'long_service')),
  hours_accrued       numeric(10,2) NOT NULL DEFAULT 0,
  hours_taken         numeric(10,2) NOT NULL DEFAULT 0,
  hours_balance       numeric(10,2) GENERATED ALWAYS AS (hours_accrued - hours_taken) STORED,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leave_balances_employee_type_uniq UNIQUE (employee_id, leave_type)
);

CREATE INDEX IF NOT EXISTS leave_balances_org_idx
  ON public.leave_balances (organization_id);

-- ----------------------------------------------------------------------------
-- 6. updated_at triggers
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.payroll_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pay_schedules_updated_at ON public.pay_schedules;
CREATE TRIGGER trg_pay_schedules_updated_at
  BEFORE UPDATE ON public.pay_schedules
  FOR EACH ROW EXECUTE FUNCTION public.payroll_set_updated_at();

DROP TRIGGER IF EXISTS trg_pay_runs_updated_at ON public.pay_runs;
CREATE TRIGGER trg_pay_runs_updated_at
  BEFORE UPDATE ON public.pay_runs
  FOR EACH ROW EXECUTE FUNCTION public.payroll_set_updated_at();

DROP TRIGGER IF EXISTS trg_leave_balances_updated_at ON public.leave_balances;
CREATE TRIGGER trg_leave_balances_updated_at
  BEFORE UPDATE ON public.leave_balances
  FOR EACH ROW EXECUTE FUNCTION public.payroll_set_updated_at();

-- ----------------------------------------------------------------------------
-- 7. RLS
-- ----------------------------------------------------------------------------

ALTER TABLE public.pay_schedules   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_slips       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_balances  ENABLE ROW LEVEL SECURITY;

-- pay_schedules: read all members; admin+ write
DROP POLICY IF EXISTS pay_schedules_select ON public.pay_schedules;
CREATE POLICY pay_schedules_select ON public.pay_schedules FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS pay_schedules_insert ON public.pay_schedules;
CREATE POLICY pay_schedules_insert ON public.pay_schedules FOR INSERT TO authenticated
  WITH CHECK (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND public.require_role(organization_id, 'admin'::org_role)
  );

DROP POLICY IF EXISTS pay_schedules_update ON public.pay_schedules;
CREATE POLICY pay_schedules_update ON public.pay_schedules FOR UPDATE TO authenticated
  USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND public.require_role(organization_id, 'admin'::org_role)
  );

DROP POLICY IF EXISTS pay_schedules_delete ON public.pay_schedules;
CREATE POLICY pay_schedules_delete ON public.pay_schedules FOR DELETE TO authenticated
  USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND public.require_role(organization_id, 'admin'::org_role)
  );

-- pay_runs: read all members; admin+ write; owner-only finalisation enforced
-- via RPC payroll_finalise_pay_run (SECURITY DEFINER) — clients can mark
-- approved/cancelled but not 'paid' directly.
DROP POLICY IF EXISTS pay_runs_select ON public.pay_runs;
CREATE POLICY pay_runs_select ON public.pay_runs FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS pay_runs_insert ON public.pay_runs;
CREATE POLICY pay_runs_insert ON public.pay_runs FOR INSERT TO authenticated
  WITH CHECK (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND public.require_role(organization_id, 'admin'::org_role)
  );

DROP POLICY IF EXISTS pay_runs_update ON public.pay_runs;
CREATE POLICY pay_runs_update ON public.pay_runs FOR UPDATE TO authenticated
  USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND public.require_role(organization_id, 'admin'::org_role)
  )
  WITH CHECK (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND public.require_role(organization_id, 'admin'::org_role)
    -- Block clients from setting status to 'paid' directly. Use RPC instead.
    AND status <> 'paid'
  );

-- pay_slips: read all members; admin+ insert (via edge fn);
-- update/delete locked once parent pay_run is paid.
DROP POLICY IF EXISTS pay_slips_select ON public.pay_slips;
CREATE POLICY pay_slips_select ON public.pay_slips FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS pay_slips_insert ON public.pay_slips;
CREATE POLICY pay_slips_insert ON public.pay_slips FOR INSERT TO authenticated
  WITH CHECK (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND public.require_role(organization_id, 'admin'::org_role)
  );

DROP POLICY IF EXISTS pay_slips_update ON public.pay_slips;
CREATE POLICY pay_slips_update ON public.pay_slips FOR UPDATE TO authenticated
  USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND public.require_role(organization_id, 'admin'::org_role)
    AND EXISTS (
      SELECT 1 FROM public.pay_runs r
      WHERE r.id = pay_slips.pay_run_id
        AND r.status IN ('draft', 'approved')
    )
  );

DROP POLICY IF EXISTS pay_slips_delete ON public.pay_slips;
CREATE POLICY pay_slips_delete ON public.pay_slips FOR DELETE TO authenticated
  USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND public.require_role(organization_id, 'admin'::org_role)
    AND EXISTS (
      SELECT 1 FROM public.pay_runs r
      WHERE r.id = pay_slips.pay_run_id
        AND r.status = 'draft'
    )
  );

-- leave_balances: read all members; admin+ write
DROP POLICY IF EXISTS leave_balances_select ON public.leave_balances;
CREATE POLICY leave_balances_select ON public.leave_balances FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS leave_balances_insert ON public.leave_balances;
CREATE POLICY leave_balances_insert ON public.leave_balances FOR INSERT TO authenticated
  WITH CHECK (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND public.require_role(organization_id, 'admin'::org_role)
  );

DROP POLICY IF EXISTS leave_balances_update ON public.leave_balances;
CREATE POLICY leave_balances_update ON public.leave_balances FOR UPDATE TO authenticated
  USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND public.require_role(organization_id, 'admin'::org_role)
  );

DROP POLICY IF EXISTS leave_balances_delete ON public.leave_balances;
CREATE POLICY leave_balances_delete ON public.leave_balances FOR DELETE TO authenticated
  USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND public.require_role(organization_id, 'admin'::org_role)
  );

-- ----------------------------------------------------------------------------
-- 8. Super calc helper
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.calc_super(
  p_gross_cents bigint,
  p_rate_pct    numeric DEFAULT NULL,
  p_org_id      uuid    DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_rate numeric;
BEGIN
  IF p_rate_pct IS NOT NULL THEN
    v_rate := p_rate_pct;
  ELSIF p_org_id IS NOT NULL THEN
    SELECT COALESCE((settings->>'super_rate_pct')::numeric, 11.5)
      INTO v_rate
      FROM public.organizations
     WHERE id = p_org_id;
    v_rate := COALESCE(v_rate, 11.5);
  ELSE
    v_rate := 11.5;
  END IF;

  RETURN ROUND(GREATEST(p_gross_cents, 0) * v_rate / 100.0)::bigint;
END $$;

GRANT EXECUTE ON FUNCTION public.calc_super(bigint, numeric, uuid) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 9. Owner-only RPC: payroll_finalise_pay_run
--    Sets status -> 'paid' (which the RLS UPDATE policy blocks for clients).
--    SECURITY DEFINER + role check -> only owner may finalise.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.payroll_finalise_pay_run(p_run_id uuid)
RETURNS pay_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run pay_runs;
BEGIN
  SELECT * INTO v_run FROM public.pay_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pay_run not found: %', p_run_id;
  END IF;

  IF NOT public.require_role(v_run.organization_id, 'owner'::org_role) THEN
    RAISE EXCEPTION 'only owner may finalise a pay run';
  END IF;

  IF v_run.status NOT IN ('draft', 'approved') THEN
    RAISE EXCEPTION 'cannot finalise a pay run in status %', v_run.status;
  END IF;

  UPDATE public.pay_runs
     SET status   = 'paid',
         paid_at  = now(),
         paid_by  = auth.uid(),
         updated_at = now()
   WHERE id = p_run_id
   RETURNING * INTO v_run;

  RETURN v_run;
END $$;

GRANT EXECUTE ON FUNCTION public.payroll_finalise_pay_run(uuid) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 10. Audit triggers (use existing v2 trigger fn)
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['pay_schedules', 'pay_runs', 'pay_slips', 'leave_balances'])
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%I_audit_v2 ON %I;', t, t
    );
    EXECUTE format(
      'CREATE TRIGGER trg_%I_audit_v2
       AFTER INSERT OR UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION audit_log_trigger_v2();', t, t
    );
  END LOOP;
END $$;

COMMIT;
