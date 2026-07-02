-- 20260702103000_bas_g10_capital_split.sql
--
-- Replace the original BAS GST worksheet function's documented G10 gap.
--
-- 0120 reported G10 as zero because v_bas_quarterly had no capital/non-capital
-- purchase split. Since 0116/0117 already introduced expected GST treatment at
-- supplier/account level, this function now resolves capital purchases from bill
-- line classification while preserving the existing BAS bill scope:
--   * allocation-aware bill amounts from v_bill_effective_allocations
--   * business, probable bills only
--   * AU BAS quarter from au_bas_quarter(b.invoice_date)
--   * RLS-scoped SECURITY INVOKER reads
--
-- Line-level classification uses chart_of_accounts.expected_gst_treatment first,
-- then suppliers.expected_gst_treatment. If a bill has no line totals, the
-- supplier-level treatment classifies the whole allocated bill as a fallback.

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
  with sales as (
    select
      coalesce(bq.sales_ex_gst_cents + bq.gst_collected_cents, 0)::bigint as g1_total_sales_cents,
      coalesce(bq.gst_collected_cents, 0)::bigint as label_1a_gst_on_sales_cents
    from public.v_bas_quarterly bq
    where bq.organization_id = p_org
      and bq.fy_start_year = p_fy_start_year
      and bq.quarter_num = p_quarter
  ),
  purchase_scope as (
    select
      bea.bill_id,
      bea.organization_id,
      b.organization_id as bill_owner_org_id,
      b.supplier_id,
      s.expected_gst_treatment as supplier_expected_gst_treatment,
      bea.effective_total_inc_gst_cents,
      bea.effective_gst_cents
    from public.v_bill_effective_allocations bea
    join public.bills b on b.id = bea.bill_id
    left join public.suppliers s
      on s.id = b.supplier_id
     and s.organization_id = b.organization_id
    cross join lateral public.au_bas_quarter(b.invoice_date) q
    where bea.organization_id = p_org
      and q.fy_start_year = p_fy_start_year
      and q.quarter_num = p_quarter
      and b.deleted_at is null
      and b.is_personal = false
      and b.is_probable_bill = true
      and b.invoice_date is not null
  ),
  line_rollup as (
    select
      ps.bill_id,
      ps.organization_id,
      coalesce(sum(bli.total_cents), 0)::numeric as line_total_cents,
      coalesce(sum(bli.gst_cents), 0)::numeric as line_gst_cents,
      coalesce(sum(bli.total_cents) filter (
        where coalesce(coa.expected_gst_treatment, ps.supplier_expected_gst_treatment) = 'GST_ON_CAPITAL'
      ), 0)::numeric as capital_line_total_cents,
      coalesce(sum(bli.gst_cents) filter (
        where coalesce(coa.expected_gst_treatment, ps.supplier_expected_gst_treatment) = 'GST_ON_CAPITAL'
      ), 0)::numeric as capital_line_gst_cents
    from purchase_scope ps
    left join public.bill_line_items bli
      on bli.bill_id = ps.bill_id
    left join public.chart_of_accounts coa
      on coa.organization_id = bli.organization_id
     and coa.code = bli.account_code
    group by ps.bill_id, ps.organization_id
  ),
  classified_purchases as (
    select
      ps.effective_total_inc_gst_cents,
      ps.effective_gst_cents,
      case
        when lr.line_total_cents > 0 then
          round(
            ps.effective_total_inc_gst_cents::numeric
            * lr.capital_line_total_cents
            / lr.line_total_cents
          )::bigint
        when ps.supplier_expected_gst_treatment = 'GST_ON_CAPITAL' then
          ps.effective_total_inc_gst_cents
        else
          0::bigint
      end as capital_purchases_cents
    from purchase_scope ps
    left join line_rollup lr
      on lr.bill_id = ps.bill_id
     and lr.organization_id = ps.organization_id
  ),
  purchases as (
    select
      coalesce(sum(c.capital_purchases_cents), 0)::bigint as g10_capital_purchases_cents,
      coalesce(sum(c.effective_total_inc_gst_cents - c.capital_purchases_cents), 0)::bigint
        as g11_noncapital_purchases_cents,
      coalesce(sum(c.effective_gst_cents), 0)::bigint as label_1b_gst_on_purchases_cents
    from classified_purchases c
  )
  select
    coalesce(s.g1_total_sales_cents, 0)::bigint,
    coalesce(p.g10_capital_purchases_cents, 0)::bigint,
    coalesce(p.g11_noncapital_purchases_cents, 0)::bigint,
    coalesce(s.label_1a_gst_on_sales_cents, 0)::bigint,
    coalesce(p.label_1b_gst_on_purchases_cents, 0)::bigint
  from (select 1) base
  left join sales s on true
  left join purchases p on true;
$$;

comment on function public.generate_bas_worksheet_gst(uuid, integer, integer) is
  'BAS GST labels (G1, G10, G11, 1A, 1B) for an org + AU FY quarter. Sales/GST '
  'collected come from v_bas_quarterly. Purchases/GST paid keep the allocation-aware '
  'v_bill_effective_allocations scope, with G10 split from GST_ON_CAPITAL account '
  'or supplier treatment and all remaining purchases flowing to G11. SECURITY '
  'INVOKER -> RLS-scoped. Composed by generate_bas_worksheet (SC-3.C.03).';

revoke all on function public.generate_bas_worksheet_gst(uuid, integer, integer) from public, anon;
grant execute on function public.generate_bas_worksheet_gst(uuid, integer, integer) to authenticated;
