-- 0120_bas_worksheet_gst_labels.sql — SC-3.C.01 (Phase 3, BAS worksheet)
--
-- generate_bas_worksheet_gst(org, fy_start_year, quarter): the GST side of the
-- BAS worksheet, derived from v_bas_quarterly (0032/0080) for one AU FY quarter:
--   G1  total sales INCLUDING GST   = sales_ex_gst + gst_collected
--   G10 capital purchases           = 0 (see gap note below)
--   G11 non-capital purchases (inc GST) = purchases_ex_gst + gst_paid
--   1A  GST on sales                = gst_collected
--   1B  GST on purchases            = gst_paid
--
-- GAP (documented, not invented): v_bas_quarterly has NO capital vs non-capital
-- split, so G10 is reported as 0 and the full purchases figure falls to G11. A
-- capital flag on bills (feeding a G10 split) is a later refinement.
--
-- Always returns exactly one row — zeros when the quarter has no activity (a
-- LEFT JOIN off a single-row base), so callers get a complete label set. Quarter
-- boundaries / due dates (incl. Q2 Oct–Dec → 28 Feb) come from au_bas_quarter via
-- v_bas_quarterly; this fn reads them, it does not recompute.
--
-- SECURITY INVOKER (default, explicit): v_bas_quarterly is itself security_invoker,
-- so its RLS scopes every row to the caller's orgs; a DEFINER fn would bypass that
-- and leak. No writes. Composed into the full worksheet by generate_bas_worksheet
-- (SC-3.C.03) alongside the PAYG labels (SC-3.C.02).
--
-- MIGRATION NUMBER: reassigned from the ledger's planned 0111 to 0120 per the
-- drift rule (0108–0115 legal-RAG; 0116–0119 SC-3.A/3.B). Verified 0120 free.

create or replace function public.generate_bas_worksheet_gst(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
returns table (
  g1_total_sales_cents            bigint,
  g10_capital_purchases_cents     bigint,
  g11_noncapital_purchases_cents  bigint,
  label_1a_gst_on_sales_cents     bigint,
  label_1b_gst_on_purchases_cents bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(bq.sales_ex_gst_cents + bq.gst_collected_cents, 0)::bigint,        -- G1
    0::bigint,                                                                   -- G10 (no capital split — gap)
    coalesce(bq.purchases_ex_gst_cents + bq.gst_paid_cents, 0)::bigint,         -- G11
    coalesce(bq.gst_collected_cents, 0)::bigint,                                -- 1A
    coalesce(bq.gst_paid_cents, 0)::bigint                                      -- 1B
  from (select 1) base
  left join v_bas_quarterly bq
    on bq.organization_id = p_org
   and bq.fy_start_year   = p_fy_start_year
   and bq.quarter_num     = p_quarter;
$$;

comment on function public.generate_bas_worksheet_gst(uuid, integer, integer) is
  'BAS GST labels (G1, G10, G11, 1A, 1B) for an org + AU FY quarter from '
  'v_bas_quarterly. Always one row (zeros when no activity). G10=0 — no capital '
  'split in v_bas_quarterly (documented gap). SECURITY INVOKER → RLS-scoped. '
  'Composed by generate_bas_worksheet (SC-3.C.03).';

-- Supabase default privileges grant EXECUTE on new functions to anon + authenticated;
-- revoke the broad grants and keep only authenticated (invoker + RLS already make
-- anon harmless, but least-privilege matches the stricter sibling fns, e.g. 0059).
revoke all on function public.generate_bas_worksheet_gst(uuid, integer, integer) from public, anon;
grant execute on function public.generate_bas_worksheet_gst(uuid, integer, integer) to authenticated;
