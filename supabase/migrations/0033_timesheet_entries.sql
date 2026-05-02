-- 0033: Timesheet entries for job costing.
-- One row per employee × day × job (or per shift if multiple in a day).
-- Drives the cost_wages_cents column in v_job_pnl.

CREATE TABLE IF NOT EXISTS public.timesheet_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  work_date date NOT NULL,
  hours numeric(6,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  loaded_hourly_rate_cents bigint NOT NULL DEFAULT 0,
  total_cost_cents bigint NOT NULL DEFAULT 0,
  notes text,
  is_billable boolean NOT NULL DEFAULT true,
  approved_at timestamptz,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS timesheet_org_date_idx ON public.timesheet_entries (organization_id, work_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS timesheet_employee_idx ON public.timesheet_entries (employee_id, work_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS timesheet_job_idx ON public.timesheet_entries (job_id) WHERE deleted_at IS NULL AND job_id IS NOT NULL;

ALTER TABLE public.timesheet_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY timesheet_select ON public.timesheet_entries FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));
CREATE POLICY timesheet_insert ON public.timesheet_entries FOR INSERT TO authenticated
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
CREATE POLICY timesheet_update ON public.timesheet_entries FOR UPDATE TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));
CREATE POLICY timesheet_delete ON public.timesheet_entries FOR DELETE TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

CREATE OR REPLACE FUNCTION public.timesheet_recompute_cost()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.total_cost_cents := ROUND(NEW.hours * NEW.loaded_hourly_rate_cents);
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_timesheet_recompute_cost
  BEFORE INSERT OR UPDATE OF hours, loaded_hourly_rate_cents ON public.timesheet_entries
  FOR EACH ROW EXECUTE FUNCTION public.timesheet_recompute_cost();
