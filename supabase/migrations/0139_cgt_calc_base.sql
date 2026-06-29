-- 0139_cgt_calc_base.sql — SC-4.E.01 (Phase 4, CGT basic calc)
--
-- cgt_calc(org, fy_start_year) — the NET CAPITAL GAIN for a financial year, RAW:
-- no 12-month discount and no small-business concessions (those are SC-4.E.02 /
-- SC-4.F, which extend this function). Pure netting per ITAA 1997 s102-5, the part
-- that runs BEFORE any discount:
--
--   1. Per CGT event in the FY (cgt_events, 0138) compute the raw gain/loss:
--        cost base         = sum of the five s110-25 elements
--        reduced cost base = cost base MINUS element 3 (non-capital ownership
--                            costs — s110-55 excludes it from the reduced base)
--        gain = max(0, proceeds − cost base)
--        loss = max(0, reduced cost base − proceeds)
--      Proceeds landing between the reduced and the full cost base give neither a
--      gain nor a loss (the s100-45 "no gain / no loss" zone) — both maxes floor
--      to 0 there.
--   2. Net current-year gains against current-year losses, then against the
--      carried-forward net capital losses from prior years. Capital losses are
--      applied BEFORE any discount (ITAA s102-5 ordering); that ordering boundary
--      is exactly where this slice stops — the discount lands in SC-4.E.02.
--
-- CARRIED-FORWARD LOSSES are derived from cgt_events itself (there is no separate
-- carry-forward ledger table, and none is needed: capital losses never expire and
-- carry no discount, so the running carry-forward is fully reproducible from the
-- raw events). For each prior FY Y the carry recurrence is
--        cf_Y = max(0, cf_{Y-1} + losses_Y − gains_Y)
-- — prior carry plus this year's losses, less this year's gains, floored at 0
-- (carried losses only ever reduce gains to zero; the remainder carries again).
-- Walking that from the earliest event FY up to fy−1 yields the losses available
-- INTO the requested FY. Because losses do not expire and there is no discount at
-- this stage, the order of application (current-year vs carried) does not change
-- any total, so a single pooled carry is exact.
--
-- SECURITY INVOKER: the only read is cgt_events, RLS-scoped to the caller's orgs
-- (0138), so a foreign org sees no events and a zero result rather than leaking;
-- a service_role backend bypasses RLS. STABLE, no writes — cheap to recompute.
-- Matches the eofy_readiness(org, fy) convention (0132).
--
-- MIGRATION NUMBER: the ledger planned 0130, but 0130 is taken
-- (0130_obligation_types_states); reassigned to 0139 per the drift rule — the
-- sequential repo head is 0138_cgt_events (0178/0179 are late hotfixes). Verified
-- against live (dxoikltymmknxqpkpyhi): cgt_calc absent; cgt_events ships in 0138
-- (committed, not yet deployed — staged with 0138 for the rolled-back live test).

create or replace function public.cgt_calc(p_org uuid, p_fy_start_year integer)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fy_start        date   := make_date(p_fy_start_year, 7, 1);
  v_fy_end          date   := make_date(p_fy_start_year + 1, 6, 30);
  v_cy_gains        bigint := 0;   -- current-year raw capital gains
  v_cy_losses       bigint := 0;   -- current-year capital losses
  v_cf_in           bigint := 0;   -- carried-forward net capital losses available into this FY
  v_cf_applied      bigint;        -- carried-forward losses actually used this FY
  v_net_gain        bigint;        -- net capital gain BEFORE discount/concessions
  v_loss_cf         bigint;        -- net capital loss carried to the NEXT FY
  v_event_count     int    := 0;
  v_events          jsonb  := '[]'::jsonb;
  rec               record;
begin
  -- Roll the carry-forward forward through every PRIOR financial year (oldest
  -- first), grouping each year's events by its AU FY start year (July boundary).
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

  -- Current-year events: per-event gain/loss totals + the detail array, one scan.
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
      greatest(ev.reduced_cost_base_cents - ev.proceeds_cents, 0) as loss_cents
    from ev
  )
  select
    coalesce(sum(g.gain_cents), 0),
    coalesce(sum(g.loss_cents), 0),
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
          'loss_cents',              g.loss_cents
        ) order by g.disposal_date, g.id
      ),
      '[]'::jsonb
    )
  into v_cy_gains, v_cy_losses, v_event_count, v_events
  from g;

  -- Net: current-year losses first, then carried-forward losses (ITAA ordering).
  -- Order does not affect the pre-discount totals, but applying current-year
  -- losses first matches s102-5 and keeps carried losses available longest.
  -- Each output is a direct closed form over the three accumulated totals.
  v_cf_applied := least(v_cf_in, greatest(0, v_cy_gains - v_cy_losses));   -- cf losses hit gains left after CY losses
  v_net_gain   := greatest(0, v_cy_gains - v_cy_losses - v_cf_in);         -- pre-discount net capital gain
  v_loss_cf    := greatest(0, v_cf_in + v_cy_losses - v_cy_gains);         -- net capital loss carried to next FY

  return jsonb_build_object(
    'organization_id',                        p_org,
    'fy_start_year',                          p_fy_start_year,
    'period_start',                           v_fy_start,
    'period_end',                             v_fy_end,
    'event_count',                            v_event_count,
    'current_year_capital_gains_cents',       v_cy_gains,
    'current_year_capital_losses_cents',      v_cy_losses,
    'carried_forward_losses_available_cents', v_cf_in,
    'carried_forward_losses_applied_cents',   v_cf_applied,
    'net_capital_gain_cents',                 v_net_gain,            -- pre-discount; SC-4.E.02 applies the discount to this
    'net_capital_loss_carried_forward_cents', v_loss_cf,            -- carried into the next FY
    'events',                                 v_events
  );
end;
$$;

comment on function public.cgt_calc(uuid, integer) is
  'SC-4.E.01: RAW net capital gain (jsonb) for an org + AU FY (no discount, no '
  'concessions). Per cgt_events (0138): gain = max(0, proceeds − cost base), '
  'loss = max(0, reduced cost base − proceeds); nets current-year then '
  'carried-forward capital losses (ITAA s102-5 ordering, before discount). '
  'Carry-forward derived from prior-year events (cf_Y = max(0, cf_{Y-1}+losses−gains)). '
  'SECURITY INVOKER — RLS scopes the caller. Extended by SC-4.E.02 (discount).';

revoke all on function public.cgt_calc(uuid, integer) from public, anon;
grant execute on function public.cgt_calc(uuid, integer) to authenticated;
