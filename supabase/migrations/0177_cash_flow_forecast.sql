-- 0177_cash_flow_forecast.sql - SC-6.F.01 (Phase 6, forecasting / vCFO model)
--
-- Planned as 0169, but 0169 is already SMSF return draft. Reassigned to 0177
-- per the drift rule: the current sequential repo head is 0176_advice_notes_rpcs
-- (0178/0179 are late hotfixes that sort after this backlog chain).
--
-- Adds a weekly cash-flow forecast view over the existing 0032
-- public.v_cash_flow_weekly shape:
--   - scheduled open invoice inflows and bill outflows from v_cash_flow_weekly
--   - recurring subscription outflows from confirmed subscriptions
--   - paid invoice/bill actuals for variance reporting
--
-- Also adds a compact budget-vs-actual weekly view from job budgets vs current
-- job P&L. External benchmark datasets named in the plan are explicitly out of
-- scope for this slice.

create or replace view public.v_cash_flow_forecast
with (security_invoker = true) as
with horizon_bounds as (
  select
    date_trunc('week', current_date)::date as horizon_start,
    (date_trunc('week', current_date)::date + interval '12 weeks')::date as horizon_end
),
scheduled_cash_flow as (
  select
    w.organization_id,
    w.week_start,
    sum(w.amount_cents) filter (where w.source_type = 'invoice')::bigint as scheduled_invoice_cents,
    sum(w.amount_cents) filter (where w.source_type = 'bill')::bigint as scheduled_bill_cents
  from public.v_cash_flow_weekly w
  cross join horizon_bounds hb
  where w.week_start between hb.horizon_start and hb.horizon_end
  group by w.organization_id, w.week_start
),
subscription_instances as (
  select
    s.organization_id,
    date_trunc('week', instance.expected_at)::date as week_start,
    -sum(s.amount_cents)::bigint as recurring_subscription_cents
  from public.subscriptions s
  cross join horizon_bounds hb
  cross join lateral generate_series(
    s.next_expected_at,
    hb.horizon_end,
    case s.cadence
      when 'weekly' then interval '1 week'
      when 'fortnightly' then interval '2 weeks'
      when 'monthly' then interval '1 month'
      when 'quarterly' then interval '3 months'
      when 'yearly' then interval '1 year'
      else interval '100 years'
    end
  ) as instance(expected_at)
  where s.status = 'confirmed'::public.subscription_status
    and s.is_personal = false
    and s.is_business = true
    and s.amount_cents is not null
    and s.amount_cents > 0
    and s.next_expected_at is not null
    and s.cadence <> 'irregular'::public.subscription_cadence
    and instance.expected_at::date between hb.horizon_start and hb.horizon_end
  group by s.organization_id, date_trunc('week', instance.expected_at)::date
),
actual_cash_flow as (
  select
    organization_id,
    week_start,
    sum(amount_cents)::bigint as actual_net_cents
  from (
    select
      i.organization_id,
      date_trunc('week', i.paid_at)::date as week_start,
      i.amount_paid_cents as amount_cents
    from public.invoices i
    cross join horizon_bounds hb
    where i.deleted_at is null
      and i.status = 'paid'::public.invoice_status
      and i.paid_at is not null
      and i.amount_paid_cents > 0
      and date_trunc('week', i.paid_at)::date between hb.horizon_start and hb.horizon_end

    union all

    select
      b.organization_id,
      date_trunc('week', b.paid_at)::date as week_start,
      -b.total_inc_gst_cents as amount_cents
    from public.bills b
    cross join horizon_bounds hb
    where b.deleted_at is null
      and b.status = 'paid'::public.bill_status
      and b.paid_at is not null
      and b.total_inc_gst_cents is not null
      and b.total_inc_gst_cents > 0
      and b.is_personal = false
      and date_trunc('week', b.paid_at)::date between hb.horizon_start and hb.horizon_end
  ) actuals
  group by organization_id, week_start
),
forecast_orgs as (
  select organization_id from scheduled_cash_flow
  union
  select organization_id from subscription_instances
  union
  select organization_id from actual_cash_flow
),
forecast_weeks as (
  select
    o.organization_id,
    week.week_start::date as week_start
  from forecast_orgs o
  cross join horizon_bounds hb
  cross join lateral generate_series(
    hb.horizon_start,
    hb.horizon_end,
    interval '1 week'
  ) as week(week_start)
)
select
  w.organization_id,
  w.week_start,
  coalesce(s.scheduled_invoice_cents, 0)::bigint as scheduled_invoice_cents,
  coalesce(s.scheduled_bill_cents, 0)::bigint as scheduled_bill_cents,
  coalesce(si.recurring_subscription_cents, 0)::bigint as recurring_subscription_cents,
  (
    coalesce(s.scheduled_invoice_cents, 0)
    + coalesce(s.scheduled_bill_cents, 0)
    + coalesce(si.recurring_subscription_cents, 0)
  )::bigint as forecast_net_cents,
  coalesce(a.actual_net_cents, 0)::bigint as actual_net_cents,
  (
    coalesce(s.scheduled_invoice_cents, 0)
    + coalesce(s.scheduled_bill_cents, 0)
    + coalesce(si.recurring_subscription_cents, 0)
    - coalesce(a.actual_net_cents, 0)
  )::bigint as variance_cents
from forecast_weeks w
left join scheduled_cash_flow s
  on s.organization_id = w.organization_id
 and s.week_start = w.week_start
left join subscription_instances si
  on si.organization_id = w.organization_id
 and si.week_start = w.week_start
left join actual_cash_flow a
  on a.organization_id = w.organization_id
 and a.week_start = w.week_start;

comment on view public.v_cash_flow_forecast is
  'SC-6.F.01: weekly cash-flow forecast over current week + 12 future weeks. '
  'Extends v_cash_flow_weekly with confirmed recurring subscription outflows and '
  'paid invoice/bill actuals. variance_cents = forecast_net_cents - actual_net_cents.';

create or replace view public.v_budget_vs_actual_weekly
with (security_invoker = true) as
select
  p.organization_id,
  date_trunc('week', coalesce(j.end_date, j.start_date, current_date))::date as week_start,
  sum(coalesce(p.budget_cents, 0))::bigint as budget_cents,
  sum(coalesce(p.gross_profit_cents, 0))::bigint as actual_cents,
  (
    sum(coalesce(p.gross_profit_cents, 0))
    - sum(coalesce(p.budget_cents, 0))
  )::bigint as variance_cents,
  count(*)::integer as job_count
from public.v_job_pnl p
join public.jobs j on j.id = p.job_id
where j.deleted_at is null
  and j.status <> 'cancelled'::public.job_status
group by
  p.organization_id,
  date_trunc('week', coalesce(j.end_date, j.start_date, current_date))::date;

comment on view public.v_budget_vs_actual_weekly is
  'SC-6.F.01: weekly job budget-vs-actual shape. budget_cents comes from jobs; '
  'actual_cents is v_job_pnl.gross_profit_cents; variance_cents = actual_cents - budget_cents.';

grant select on public.v_cash_flow_forecast to authenticated, service_role;
grant select on public.v_budget_vs_actual_weekly to authenticated, service_role;
