-- LODGE-01: use the file_prepared super batch status (added in 20261003170100).
--
-- 1. Batches that super-batch-send marked `sent` only produced a clearing-house file: transport_mode
--    'clearing_house_file' with live dispatch off. Nothing was sent to a fund or paid, so they are
--    relabelled file_prepared. A batch with any other transport keeps its status.
-- 2. generate_super_batch treats file_prepared like sent/confirmed: it will not rebuild a quarter
--    whose file may already be uploaded to a clearing house, which could pay employees twice.
--    Body otherwise identical to 0228_superstream_transport.sql.

UPDATE public.super_batches
   SET status = 'file_prepared'
 WHERE status = 'sent'
   AND transport_mode = 'clearing_house_file'
   AND COALESCE((transport_response ->> 'live_dispatch_enabled')::boolean, false) = false;

CREATE OR REPLACE FUNCTION public.generate_super_batch(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_batch_id uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.super_batches
    WHERE organization_id = p_org
      AND fy_start_year = p_fy_start_year
      AND quarter = p_quarter
      AND status IN ('file_prepared', 'sent', 'confirmed')
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'super batch for FY% Q% already has a prepared clearing-house file (or is sent/confirmed)',
      p_fy_start_year, p_quarter;
  END IF;

  DELETE FROM public.super_batches
  WHERE organization_id = p_org
    AND fy_start_year = p_fy_start_year
    AND quarter = p_quarter
    AND status IN ('draft', 'approved')
    AND deleted_at IS NULL;

  INSERT INTO public.super_batches (organization_id, fy_start_year, quarter, status, created_by)
  VALUES (p_org, p_fy_start_year, p_quarter, 'draft', auth.uid())
  RETURNING id INTO v_batch_id;

  WITH slip_rollup AS (
    SELECT
      ps.employee_id,
      e.full_name,
      SUM(ps.super_guarantee_cents)::bigint AS super_cents
    FROM public.pay_slips ps
    JOIN public.pay_runs pr ON pr.id = ps.pay_run_id
    JOIN public.employees e ON e.id = ps.employee_id
    CROSS JOIN LATERAL public.au_bas_quarter(pr.pay_date)
      q(fy_start_year, quarter_num, quarter_start, quarter_end, due_date)
    WHERE ps.organization_id = p_org
      AND pr.status IN ('approved', 'paid')
      AND q.fy_start_year = p_fy_start_year
      AND q.quarter_num = p_quarter
      AND ps.super_guarantee_cents > 0
    GROUP BY ps.employee_id, e.full_name
  ),
  ins AS (
    INSERT INTO public.super_batch_lines (
      batch_id,
      organization_id,
      employee_id,
      employee_name,
      super_cents,
      fund_name,
      fund_abn,
      fund_usi,
      member_number,
      payment_reference,
      validation_errors
    )
    SELECT
      v_batch_id,
      p_org,
      r.employee_id,
      r.full_name,
      r.super_cents,
      f.fund_name,
      f.fund_abn,
      f.fund_usi,
      f.member_number,
      f.payment_reference,
      (
        SELECT COALESCE(jsonb_agg(msg), '[]'::jsonb)
        FROM (
          SELECT 'missing default super fund account' AS msg WHERE f.id IS NULL
          UNION ALL SELECT 'missing fund USI' WHERE COALESCE(f.fund_usi, '') = ''
          UNION ALL SELECT 'missing member number' WHERE COALESCE(f.member_number, '') = ''
        ) errs
      )
    FROM slip_rollup r
    LEFT JOIN public.employee_super_fund_accounts f
      ON f.employee_id = r.employee_id
     AND f.organization_id = p_org
     AND f.is_default IS TRUE
    RETURNING super_cents
  )
  UPDATE public.super_batches b
     SET total_super_cents = COALESCE((SELECT SUM(super_cents) FROM ins), 0),
         line_count = (SELECT COUNT(*) FROM ins)
   WHERE b.id = v_batch_id;

  RETURN v_batch_id;
END;
$$;

COMMENT ON FUNCTION public.generate_super_batch(uuid, integer, integer) IS
  'Builds a fresh draft super_batch for an org+FY-quarter, enriching lines with employee default '
  'fund USI/member-number details and validation errors required for clearing-house export. '
  'Refuses once the quarter has a prepared clearing-house file, or is sent/confirmed.';

COMMENT ON TABLE public.super_batches IS
  'Quarterly super-guarantee batch per org+FY-quarter (status draft -> approved -> file_prepared -> '
  'sent -> confirmed). file_prepared: the clearing-house file was generated; nothing has been sent or '
  'paid by Looplet. Built by generate_super_batch from pay_slips SG.';
