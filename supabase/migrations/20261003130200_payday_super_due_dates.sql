-- ============================================================================
-- Migration: 20261003130200_payday_super_due_dates
-- Purpose:   Super guarantee due date for each pay run: Payday Super for pay
--            dates from 1 July 2026, the quarterly rule before then.
--
-- Law (Federal Register of Legislation):
--   - Treasury Laws Amendment (Payday Superannuation) Act 2025 (No. 57, 2025),
--     assented 6 November 2025, commences 1 July 2026. Sch 1 item 182: the new
--     rules apply to a QE day (a day qualifying earnings are paid) on or after
--     1 July 2026; the old rules continue for quarters ending before that day.
--     https://www.legislation.gov.au/C2025A00057/asmade
--   - SGAA 1992 as in force from 1 July 2026, s 6 and s 18C: a contribution
--     counts for a QE day when the fund receives it within the "usual period",
--     which ends on the 7th business day after the QE day; the "extended usual
--     period" (20th business day) applies to the first contribution to a fund
--     for a new employee (s 18C(2) item 1). "Business day" excludes Saturdays,
--     Sundays and days that are public holidays for the whole of any State, the
--     ACT or the NT.
--     https://www.legislation.gov.au/C2004A04402/2026-07-01/2026-07-01/text/original/epub/OEBPS/document_1/document_1.html
--   - SGAA 1992 before 1 July 2026, s 23(6): a contribution counts for a
--     quarter if made within 28 days after the end of the quarter.
--     https://www.legislation.gov.au/C2004A04402/2025-07-01/2025-07-01/text/original/epub/OEBPS/document_1/document_1.html
--
-- Public holidays: super_non_business_days lists whole-of-State/Territory public
-- holidays. It starts EMPTY (this migration does not guess holiday dates), so
-- until someone fills it the Payday Super date skips weekends only. That date is
-- never later than the legal one, only earlier when a holiday falls in the window.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.super_non_business_days (
  day          date PRIMARY KEY,
  description  text NOT NULL CHECK (length(btrim(description)) > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.super_non_business_days IS
  'Days that are a public holiday for the whole of any State, the ACT or the NT (SGAA 1992 s 6 "business day"), used '
  'for Payday Super due dates. Empty until populated from official sources; maintained by the service role.';

ALTER TABLE public.super_non_business_days ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS super_non_business_days_read ON public.super_non_business_days;
CREATE POLICY super_non_business_days_read ON public.super_non_business_days
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.super_non_business_days FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.super_non_business_days TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.super_non_business_days TO service_role;

-- When the fund must have received the super guarantee for wages paid on p_pay_date.
--   rule 'payday_super': pay dates from 1 July 2026; the 7th business day after the pay date (the 20th when
--                        p_first_contribution, i.e. a new employee's first contribution to a fund).
--   rule 'quarterly':    earlier pay dates; 28 days after the end of the quarter containing the pay date.
CREATE OR REPLACE FUNCTION public.super_guarantee_due(
  p_pay_date            date,
  p_first_contribution  boolean DEFAULT false
)
RETURNS TABLE (rule text, due_date date)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_business_days integer;
  v_counted integer := 0;
  v_day date;
BEGIN
  IF p_pay_date IS NULL THEN
    RAISE EXCEPTION 'super_guarantee_due: a pay date is required' USING ERRCODE = '22004';
  END IF;

  IF p_pay_date < DATE '2026-07-01' THEN
    rule := 'quarterly';
    due_date := (date_trunc('quarter', p_pay_date)::date + interval '3 months' - interval '1 day')::date + 28;
    RETURN NEXT;
    RETURN;
  END IF;

  v_business_days := CASE WHEN p_first_contribution THEN 20 ELSE 7 END;
  v_day := p_pay_date;
  WHILE v_counted < v_business_days LOOP
    v_day := v_day + 1;
    IF EXTRACT(ISODOW FROM v_day) < 6
       AND NOT EXISTS (SELECT 1 FROM public.super_non_business_days h WHERE h.day = v_day) THEN
      v_counted := v_counted + 1;
    END IF;
  END LOOP;
  rule := 'payday_super';
  due_date := v_day;
  RETURN NEXT;
END $$;

COMMENT ON FUNCTION public.super_guarantee_due(date, boolean) IS
  'Super guarantee due date for wages paid on p_pay_date: Payday Super (7th business day after, 20th for a new '
  'employee''s first contribution to a fund) from 1 July 2026; 28 days after the quarter end before then.';

REVOKE ALL ON FUNCTION public.super_guarantee_due(date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.super_guarantee_due(date, boolean) TO authenticated, service_role;

-- Per pay run, under the caller's own RLS on pay_runs.
CREATE OR REPLACE VIEW public.v_pay_run_super_due
WITH (security_invoker = true) AS
SELECT pr.id              AS pay_run_id,
       pr.organization_id,
       pr.pay_date,
       d.rule             AS super_due_rule,
       d.due_date         AS super_due_date
  FROM public.pay_runs pr
  CROSS JOIN LATERAL public.super_guarantee_due(pr.pay_date) d;

COMMENT ON VIEW public.v_pay_run_super_due IS
  'Super guarantee due date per pay run (super_guarantee_due on the pay date). security_invoker: pay_runs RLS applies.';

REVOKE ALL ON public.v_pay_run_super_due FROM PUBLIC, anon;
GRANT SELECT ON public.v_pay_run_super_due TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
