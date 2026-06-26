-- 0140_cgt_discount.sql — SC-4.E.02 (Phase 4, CGT basic calc: 12-month discount)
--
-- Extends cgt_calc(org, fy_start_year) from SC-4.E.01 (0139) to apply the CGT
-- discount (ITAA 1997 Div 115) on top of the raw net capital gain. The raw
-- netting from 0139 is preserved verbatim; this slice adds the discount step
-- that runs AFTER capital losses are applied (ITAA s102-5 method statement).
--
-- DISCOUNT RATE — by the org's entity_type (business_profile, 0051; widened to
-- include 'smsf' in 0131):
--   company                                  -> 0%    (companies cannot claim
--                                                      the CGT discount, s115-10)
--   smsf (complying super fund)              -> 33⅓%  (discount = gain ÷ 3)
--   sole_trader / trust / partnership /      -> 50%   (individuals & trusts,
--   other / NULL                                       s115-100; discount = ÷ 2)
-- Partnerships are look-through (each partner applies their own discount); the
-- partnership-level figure here assumes individual partners (50%). NULL/other
-- default to 50% — the modal case for this app's SME clients — and entity_type
-- is surfaced in the payload so the human approver sees the assumption.
--
-- HOLDING PERIOD — s115-25: a gain is discountable only if the asset was held
-- for MORE than 12 months, counting from the day AFTER acquisition (the
-- acquisition day is excluded). So the disposal must fall strictly after
-- acquisition + 12 months:  disposal_date > (acquisition_date + 12 months).
--   acquired 2023-07-01, disposed 2024-07-01  -> exactly 12 months -> NO discount
--   acquired 2023-07-01, disposed 2024-07-02  -> 12 months + 1 day -> discount
-- Events with an unknown acquisition_date are treated as not held long enough
-- (no discount) — the conservative direction.
--
-- LOSS ORDERING (ITAA s102-5 + the s102-30 freedom to choose) — capital losses
-- (current-year then carried-forward) are applied to NON-discount gains FIRST,
-- only the remainder hitting discount-eligible gains. A loss saves 100c of tax
-- on a non-discount gain but only 50c on a discount gain, so offsetting the
-- non-discount gains first minimises the net capital gain. This is the only
-- legally-correct (and taxpayer-optimal) ordering once a discount exists; 0139
-- could pool losses indiscriminately precisely because there was no discount
-- yet. The pre-discount total (non-discount remaining + discount remaining) is
-- identical to 0139's net_capital_gain regardless of the split — the ordering
-- only changes how much of the remainder is discountable.
--
-- PAYLOAD: a superset of 0139's. net_capital_gain_cents now means the FINAL,
-- post-discount net capital gain (the assessable amount for the return);
-- net_capital_gain_before_discount_cents carries 0139's old value. The detail
-- array gains a per-event discount_eligible flag.
--
-- SECURITY INVOKER, STABLE, no writes — unchanged from 0139. The added read
-- (business_profile) is RLS-scoped to the caller's orgs just like cgt_events.
--
-- MIGRATION NUMBER: ledger planned 0131, but 0131 is taken
-- (0131_obligation_types_expand); reassigned to 0140 per the drift rule — the
-- sequential repo head is 0139_cgt_calc_base. Verified against live
-- (dxoikltymmknxqpkpyhi): cgt_events + cgt_calc both absent (0138/0139 committed
-- but not yet deployed — staged with this file for the rolled-back live test);
-- business_profile.entity_type live constraint already includes 'smsf'.

create or replace function public.cgt_calc(p_org uuid, p_fy_start_year integer)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fy_start        date    := make_date(p_fy_start_year, 7, 1);
  v_fy_end          date    := make_date(p_fy_start_year + 1, 6, 30);
  v_entity_type     text;                  -- business_profile.entity_type (may be null)
  v_gets_discount   boolean;               -- false only for companies (0% rate)
  v_cy_gains        bigint  := 0;          -- current-year raw capital gains (all)
  v_cy_losses       bigint  := 0;          -- current-year capital losses
  v_disc_gains      bigint  := 0;          -- current-year gains held > 12 months
  v_nondisc_gains   bigint;                -- current-year gains NOT held > 12 months
  v_cf_in           bigint  := 0;          -- carried-forward losses available into this FY
  v_loss_pool       bigint;                -- all losses available (current + carried)
  v_loss_left       bigint;                -- losses left after offsetting non-discount gains
  v_nondisc_after   bigint;                -- non-discount gains remaining after losses
  v_disc_after      bigint;                -- discount-eligible gains remaining after losses
  v_cf_applied      bigint;                -- carried-forward losses actually used this FY
  v_loss_cf         bigint;                -- net capital loss carried to the NEXT FY
  v_discount_cents  bigint;                -- total discount applied
  v_discount_rate   numeric;               -- entity discount rate, exact fraction: 0 | 1/3 | 1/2
  v_net_before      bigint;                -- net capital gain BEFORE discount (0139's value)
  v_net_after       bigint;                -- net capital gain AFTER discount (assessable)
  v_event_count     int     := 0;
  v_events          jsonb   := '[]'::jsonb;
  rec               record;
begin
  -- Entity type drives the discount rate (single source of truth): company 0%,
  -- complying super 33⅓% (× 1/3), individuals/trusts/partnership/other/NULL 50%
  -- (× 1/2). Held as an exact numeric fraction so the cents math below is exact.
  select entity_type into v_entity_type
  from business_profile
  where organization_id = p_org;
  v_discount_rate := case
                       when v_entity_type = 'company' then 0
                       when v_entity_type = 'smsf'    then 1::numeric / 3
                       else                                1::numeric / 2
                     end;
  v_gets_discount := v_discount_rate > 0;   -- false only for companies

  -- Roll the carry-forward forward through every PRIOR financial year (oldest
  -- first), grouping each year's events by its AU FY start year (July boundary).
  -- Identical to 0139 — losses pre-discount net the same regardless of holding.
  for rec in
    select
      case when extract(month from e.disposal_date) >= 7
           then extract(year from e.disposal_date)::int
           else extract(year from e.disposal_date)::int - 1 end as fy_year,
      sum(greatest(e.proceeds_cents - e.cost_base, 0))         as gains,
      sum(greatest(e.reduced_cost_base - e.proceeds_cents, 0)) as losses
    from (
      select
        disposal_date,
        proceeds_cents,
        ( acquisition_cost_cents + incidental_costs_cents + ownership_costs_cents
          + capital_improvement_cents + title_costs_cents )   as cost_base,
        ( acquisition_cost_cents + incidental_costs_cents
          + capital_improvement_cents + title_costs_cents )   as reduced_cost_base
      from cgt_events
      where organization_id = p_org
        and deleted_at is null
        and disposal_date < v_fy_start          -- prior FYs only
    ) e
    group by 1
    order by 1
  loop
    v_cf_in := greatest(0, v_cf_in + rec.losses - rec.gains);
  end loop;

  -- Current-year events: per-event gain/loss, discount-eligibility, the discount
  -- pool, and the detail array — one scan.
  with ev as (
    select
      id, asset_description, asset_type, event_type, acquisition_date, disposal_date,
      proceeds_cents,
      ( acquisition_cost_cents + incidental_costs_cents + ownership_costs_cents
        + capital_improvement_cents + title_costs_cents )     as cost_base_cents,
      ( acquisition_cost_cents + incidental_costs_cents
        + capital_improvement_cents + title_costs_cents )     as reduced_cost_base_cents
    from cgt_events
    where organization_id = p_org
      and deleted_at is null
      and disposal_date between v_fy_start and v_fy_end
  ),
  g as (
    select
      ev.*,
      greatest(ev.proceeds_cents - ev.cost_base_cents, 0)         as gain_cents,
      greatest(ev.reduced_cost_base_cents - ev.proceeds_cents, 0) as loss_cents,
      -- s115-25: held strictly more than 12 months (acquisition day excluded).
      ( ev.acquisition_date is not null
        and ev.disposal_date > (ev.acquisition_date + interval '12 months')::date
      ) as held_long_enough
    from ev
  )
  select
    coalesce(sum(g.gain_cents), 0),
    coalesce(sum(g.loss_cents), 0),
    coalesce(sum(g.gain_cents) filter (where g.held_long_enough), 0),
    count(*),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',                      g.id,
          'asset_description',       g.asset_description,
          'asset_type',              g.asset_type,
          'event_type',              g.event_type,
          'acquisition_date',        g.acquisition_date,
          'disposal_date',           g.disposal_date,
          'proceeds_cents',          g.proceeds_cents,
          'cost_base_cents',         g.cost_base_cents,
          'reduced_cost_base_cents', g.reduced_cost_base_cents,
          'gain_cents',              g.gain_cents,
          'loss_cents',              g.loss_cents,
          -- whether THIS event's gain qualifies for the discount (entity + holding)
          'discount_eligible',       (g.held_long_enough and g.gain_cents > 0 and v_gets_discount)
        ) order by g.disposal_date, g.id
      ),
      '[]'::jsonb
    )
  into v_cy_gains, v_cy_losses, v_disc_gains, v_event_count, v_events
  from g;

  v_nondisc_gains := v_cy_gains - v_disc_gains;

  -- Apply losses to NON-discount gains first, then to discount-eligible gains.
  v_loss_pool     := v_cy_losses + v_cf_in;
  v_nondisc_after := greatest(0, v_nondisc_gains - v_loss_pool);
  v_loss_left     := greatest(0, v_loss_pool - v_nondisc_gains);
  v_disc_after    := greatest(0, v_disc_gains - v_loss_left);

  -- Carry-forward usage + the loss carried to next FY (independent of the split,
  -- so identical to 0139).
  v_cf_applied := least(v_cf_in, greatest(0, v_cy_gains - v_cy_losses));
  v_loss_cf    := greatest(0, v_loss_pool - v_cy_gains);

  -- Discount on the discount-eligible gains remaining after losses, at the rate
  -- resolved above (company rate 0 → no discount, handled uniformly). Multiplying
  -- by the exact 1/3 fraction is cent-equal to ÷3 once rounded to the nearest cent.
  v_discount_cents := round(v_disc_after::numeric * v_discount_rate)::bigint;

  v_net_before := v_nondisc_after + v_disc_after;        -- == 0139's net_capital_gain
  v_net_after  := v_net_before - v_discount_cents;       -- assessable net capital gain

  return jsonb_build_object(
    'organization_id',                        p_org,
    'fy_start_year',                          p_fy_start_year,
    'period_start',                           v_fy_start,
    'period_end',                             v_fy_end,
    'entity_type',                            v_entity_type,
    'cgt_discount_rate',                      round(v_discount_rate, 6),
    'event_count',                            v_event_count,
    'current_year_capital_gains_cents',       v_cy_gains,
    'current_year_capital_losses_cents',      v_cy_losses,
    'carried_forward_losses_available_cents', v_cf_in,
    'carried_forward_losses_applied_cents',   v_cf_applied,
    'discountable_gain_cents',                v_disc_after,         -- discount-eligible gains left after losses
    'cgt_discount_cents',                     v_discount_cents,     -- discount applied
    'net_capital_gain_before_discount_cents', v_net_before,         -- 0139's old net_capital_gain
    'net_capital_gain_cents',                 v_net_after,          -- FINAL assessable net capital gain
    'net_capital_loss_carried_forward_cents', v_loss_cf,            -- carried into the next FY
    'events',                                 v_events
  );
end;
$$;

comment on function public.cgt_calc(uuid, integer) is
  'SC-4.E.02: net capital gain (jsonb) for an org + AU FY WITH the Div 115 '
  '12-month discount. Extends 0139: after netting current-year then '
  'carried-forward losses (losses offset non-discount gains first, ITAA s102-5), '
  'applies the discount to gains held > 12 months (acquisition day excluded) at '
  'the entity rate — company 0%, smsf 33⅓%, individuals/trusts/other 50% '
  '(business_profile.entity_type, 0051/0131). net_capital_gain_cents is now '
  'post-discount; net_capital_gain_before_discount_cents holds the raw value. '
  'SECURITY INVOKER — RLS scopes the caller. Small-business concessions: SC-4.F.';

revoke all on function public.cgt_calc(uuid, integer) from public, anon;
grant execute on function public.cgt_calc(uuid, integer) to authenticated;
