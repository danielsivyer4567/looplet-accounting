-- 20260702104500_bas_worksheet_deterministic_period.sql
--
-- Replace generate_bas_worksheet's period metadata lookup.
--
-- 0122 pulled quarter_start / quarter_end / due_date from v_bas_quarterly. That
-- view carries period metadata only from invoice-side rows, so a nil BAS or a
-- bills-only quarter can produce a complete money-label payload with null period
-- dates. The worksheet is the lodgement-prep artifact, so period metadata must be
-- deterministic from the requested AU FY + BAS quarter, not dependent on activity.

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
  with requested_anchor as (
    select case p_quarter
      when 1 then make_date(p_fy_start_year, 7, 1)
      when 2 then make_date(p_fy_start_year, 10, 1)
      when 3 then make_date(p_fy_start_year + 1, 1, 1)
      when 4 then make_date(p_fy_start_year + 1, 4, 1)
      else null::date
    end as anchor_date
  ),
  requested_period as (
    select
      q.quarter_start,
      q.quarter_end,
      q.due_date
    from requested_anchor a
    left join lateral public.au_bas_quarter(a.anchor_date) q on a.anchor_date is not null
  ),
  paygi as (
    select coalesce(bool_or(bp.is_paygi_registered), false) as is_registered
    from public.business_profile bp
    where bp.organization_id = p_org
  ),
  gst_control_accounts as (
    select
      (
        select sa.account_id
          from public.system_accounts sa
         where sa.organization_id = p_org
           and sa.role = 'gst_collected'
           and sa.deleted_at is null
         limit 1
      ) as gst_collected_account_id,
      (
        select sa.account_id
          from public.system_accounts sa
         where sa.organization_id = p_org
           and sa.role = 'gst_paid'
           and sa.deleted_at is null
         limit 1
      ) as gst_paid_account_id
  ),
  gl_control_totals as (
    select
      coalesce(sum(
        case when jl.account_id = gca.gst_collected_account_id
          then jl.credit_cents - jl.debit_cents
          else 0
        end
      ), 0)::bigint as posted_1a_gst_collected_cents,
      coalesce(sum(
        case when jl.account_id = gca.gst_paid_account_id
          then jl.debit_cents - jl.credit_cents
          else 0
        end
      ), 0)::bigint as posted_1b_gst_paid_cents
    from requested_period period
    cross join gst_control_accounts gca
    left join public.journal_entries je
      on je.organization_id = p_org
     and je.status = 'posted'
     and je.entry_date >= period.quarter_start
     and je.entry_date <= period.quarter_end
    left join public.journal_lines jl
      on jl.journal_entry_id = je.id
     and jl.account_id in (
       gca.gst_collected_account_id,
       gca.gst_paid_account_id
     )
  )
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
    'gl_reconciliation', jsonb_build_object(
      'basis', 'posted_journal_lines_by_gst_system_accounts',
      'gst_collected_account_id', controls.gst_collected_account_id,
      'gst_paid_account_id', controls.gst_paid_account_id,
      'posted_1a_gst_collected_cents', gl.posted_1a_gst_collected_cents,
      'posted_1b_gst_paid_cents', gl.posted_1b_gst_paid_cents,
      'label_1a_delta_cents',
        gst.label_1a_gst_on_sales_cents - gl.posted_1a_gst_collected_cents,
      'label_1b_delta_cents',
        gst.label_1b_gst_on_purchases_cents - gl.posted_1b_gst_paid_cents,
      'reconciles',
        gst.label_1a_gst_on_sales_cents = gl.posted_1a_gst_collected_cents
        and gst.label_1b_gst_on_purchases_cents = gl.posted_1b_gst_paid_cents
    ),
    'payg_withholding', jsonb_build_object(
      'W1', payg.w1_total_salary_wages_cents,
      'W2', payg.w2_payg_withheld_cents,
      'W4', payg.w4_no_abn_withheld_cents,
      'W5', payg.w5_total_withheld_cents,
      '4',  payg.label_4_payg_withheld_cents
    ),
    'payg_instalment',
      case when paygi.is_registered
           then jsonb_build_object('T7', 0, '5A', 0, '5B', 0)
           else null end,
    'summary', jsonb_build_object(
      '9_net_amount_cents',
        gst.label_1a_gst_on_sales_cents
        - gst.label_1b_gst_on_purchases_cents
        + payg.label_4_payg_withheld_cents
    )
  )
  from requested_period period
  cross join public.generate_bas_worksheet_gst(p_org, p_fy_start_year, p_quarter) gst
  cross join public.generate_bas_worksheet_payg(p_org, p_fy_start_year, p_quarter) payg
  cross join paygi
  cross join gst_control_accounts controls
  cross join gl_control_totals gl;
$$;

comment on function public.generate_bas_worksheet(uuid, integer, integer) is
  'Full BAS worksheet as JSONB for an org + AU FY quarter. Period dates are '
  'deterministic from the requested FY/quarter via au_bas_quarter, so nil and '
  'bills-only quarters still carry quarter_start, quarter_end, and due_date. '
  'Composes GST labels, posted-GL GST control reconciliation, PAYG-W labels, '
  'optional placeholder PAYG-I labels, and summary label 9 (= 1A-1B+4). '
  'Lodgement input for Phase 7. SECURITY INVOKER -> RLS-scoped.';

revoke all on function public.generate_bas_worksheet(uuid, integer, integer) from public, anon;
grant execute on function public.generate_bas_worksheet(uuid, integer, integer) to authenticated;
