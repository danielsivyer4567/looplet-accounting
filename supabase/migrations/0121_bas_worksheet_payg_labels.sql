-- 0121_bas_worksheet_payg_labels.sql — SC-3.C.02 (Phase 3, BAS worksheet)
--
-- generate_bas_worksheet_payg(org, fy_start_year, quarter): the PAYG-withholding
-- side of the BAS worksheet, aggregated from pay_slips over the pay runs whose
-- pay_date falls in the AU FY quarter:
--   W1 total salary/wages        = SUM(pay_slips.gross_total_cents)
--   W2 PAYG withheld             = SUM(pay_slips.payg_tax_cents)
--   W4 no-ABN withholding        = 0 (not tracked — documented gap)
--   W5 total amounts withheld    = W2 + W3 + W4; W3 (other withholding) and W4 are
--                                  not tracked, so W5 collapses to W2
--   label 4 (BAS summary)        = W5
--
-- Quarter assignment is by pay_date (the PAYG-W reporting basis — withholding is
-- reported in the activity-statement period in which the payment was made), via
-- au_bas_quarter (the same quarter mapper v_bas_quarterly uses). Only finalised
-- pay runs count (status in 'approved','paid'); draft/cancelled/reversed are
-- excluded. The aggregate always yields exactly one row — zeros for an org with
-- no (matching) pay runs.
--
-- Independent of SC-3.C.01 (different source tables) — lands green on its own.
-- SECURITY INVOKER: pay_slips/pay_runs carry org-scoped RLS, so reading them as
-- the caller scopes rows to their orgs; a DEFINER fn would leak. No writes.
-- Composed into the full worksheet by generate_bas_worksheet (SC-3.C.03).
--
-- MIGRATION NUMBER: reassigned from the ledger's planned 0112 to 0121 per the
-- drift rule (0108–0115 legal-RAG; 0116–0120 SC-3.A/3.B/3.C.01). Verified free.

create or replace function public.generate_bas_worksheet_payg(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
returns table (
  w1_total_salary_wages_cents bigint,
  w2_payg_withheld_cents      bigint,
  w4_no_abn_withheld_cents    bigint,
  w5_total_withheld_cents     bigint,
  label_4_payg_withheld_cents bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(sum(ps.gross_total_cents), 0)::bigint,  -- W1
    coalesce(sum(ps.payg_tax_cents), 0)::bigint,     -- W2
    0::bigint,                                       -- W4 (no-ABN withholding not tracked — gap)
    coalesce(sum(ps.payg_tax_cents), 0)::bigint,     -- W5 = W2 + W3 + W4 (W3/W4 untracked = 0)
    coalesce(sum(ps.payg_tax_cents), 0)::bigint      -- label 4 (BAS summary) = W5
  from pay_slips ps
  join pay_runs pr on pr.id = ps.pay_run_id
  cross join lateral public.au_bas_quarter(pr.pay_date)
    q(fy_start_year, quarter_num, quarter_start, quarter_end, due_date)
  where ps.organization_id = p_org
    and pr.status in ('approved', 'paid')
    and q.fy_start_year = p_fy_start_year
    and q.quarter_num   = p_quarter;
$$;

comment on function public.generate_bas_worksheet_payg(uuid, integer, integer) is
  'BAS PAYG-withholding labels (W1, W2, W4, W5, 4) for an org + AU FY quarter, '
  'aggregated from pay_slips over finalised (approved/paid) pay runs whose pay_date '
  'falls in the quarter. W4=0 and W5=W2 — no-ABN/other withholding not tracked '
  '(documented gap). Always one row (zeros when no pay runs). SECURITY INVOKER → '
  'RLS-scoped. Composed by generate_bas_worksheet (SC-3.C.03).';

revoke all on function public.generate_bas_worksheet_payg(uuid, integer, integer) from public, anon;
grant execute on function public.generate_bas_worksheet_payg(uuid, integer, integer) to authenticated;
