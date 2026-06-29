-- 0122_bas_worksheet.sql — SC-3.C.03 (Phase 3, BAS worksheet)
--
-- generate_bas_worksheet(org, fy_start_year, quarter): the full BAS worksheet as
-- one structured JSONB payload, composing the GST labels (generate_bas_worksheet_gst,
-- SC-3.C.01) and the PAYG-withholding labels (generate_bas_worksheet_payg, SC-3.C.02)
-- plus the summary:
--   payg_instalment (T7/5A/5B) — ONLY when business_profile.is_paygi_registered;
--     the instalment AMOUNT is ATO-notified and has no source in the schema yet, so
--     these are 0 placeholders (the labels appear so the shape is lodge-ready; a real
--     T7 source is a later fill-in). Omitted entirely (null) when not registered.
--   summary.9_net_amount_cents — net amount payable (+ve = owe the ATO) =
--     (1A + 4 + 5A) - (1B + 5B). With 5A/5B = 0, this is 1A - 1B + 4.
--
-- This payload is the lodgement input for Phase 7 (SC-7.D.01). Period metadata
-- (quarter_start/end/due_date) comes from v_bas_quarterly and is populated when the
-- quarter has activity; a nil-activity quarter yields null period metadata + zero
-- labels (a "nil BAS" period mapper from (fy,quarter) is a later refinement).
--
-- SECURITY INVOKER: composes invoker fns/views, so RLS scopes everything to the
-- caller's orgs. No writes. Blocked-on (now satisfied): SC-3.C.01 + SC-3.C.02.
--
-- MIGRATION NUMBER: reassigned from the ledger's planned 0113 to 0122 per the drift
-- rule (0108–0115 legal-RAG; 0116–0121 SC-3.A/3.B/3.C.01/3.C.02). Verified free.

create or replace function public.generate_bas_worksheet(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'organization_id', p_org,
    'fy_start_year',   p_fy_start_year,
    'quarter',         p_quarter,
    'quarter_start',   period.quarter_start,
    'quarter_end',     period.quarter_end,
    'due_date',        period.due_date,
    'gst', jsonb_build_object(
      'G1',  gst.g1_total_sales_cents,
      'G10', gst.g10_capital_purchases_cents,
      'G11', gst.g11_noncapital_purchases_cents,
      '1A',  gst.label_1a_gst_on_sales_cents,
      '1B',  gst.label_1b_gst_on_purchases_cents
    ),
    'payg_withholding', jsonb_build_object(
      'W1', payg.w1_total_salary_wages_cents,
      'W2', payg.w2_payg_withheld_cents,
      'W4', payg.w4_no_abn_withheld_cents,
      'W5', payg.w5_total_withheld_cents,
      '4',  payg.label_4_payg_withheld_cents
    ),
    'payg_instalment',
      case when (
             select coalesce(bool_or(is_paygi_registered), false)
             from public.business_profile
             where organization_id = p_org
           )
           then jsonb_build_object('T7', 0, '5A', 0, '5B', 0)
           else null end,
    'summary', jsonb_build_object(
      '9_net_amount_cents',
        gst.label_1a_gst_on_sales_cents
        - gst.label_1b_gst_on_purchases_cents
        + payg.label_4_payg_withheld_cents
    )
  )
  from public.generate_bas_worksheet_gst(p_org, p_fy_start_year, p_quarter) gst
  cross join public.generate_bas_worksheet_payg(p_org, p_fy_start_year, p_quarter) payg
  left join lateral (
    select quarter_start, quarter_end, due_date
    from public.v_bas_quarterly
    where organization_id = p_org
      and fy_start_year = p_fy_start_year
      and quarter_num = p_quarter
    limit 1
  ) period on true;
$$;

comment on function public.generate_bas_worksheet(uuid, integer, integer) is
  'Full BAS worksheet as JSONB for an org + AU FY quarter — composes the GST labels '
  '(SC-3.C.01) + PAYG-W labels (SC-3.C.02) + PAYG-instalment (only when paygi '
  'registered; 0 placeholders, no amount source yet) + summary label 9 (= 1A-1B+4). '
  'Lodgement input for Phase 7. SECURITY INVOKER → RLS-scoped.';

revoke all on function public.generate_bas_worksheet(uuid, integer, integer) from public, anon;
grant execute on function public.generate_bas_worksheet(uuid, integer, integer) to authenticated;
