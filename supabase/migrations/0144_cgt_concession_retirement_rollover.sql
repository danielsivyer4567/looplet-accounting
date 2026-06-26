-- 0144_cgt_concession_retirement_rollover.sql — SC-4.F.03 (Phase 4, CGT small-business concessions)
--
-- The LAST two small-business CGT concessions, extending cgt_calc (0142) in ITAA
-- order AFTER the 50% active-asset reduction:
--   * Subdiv 152-D — small-business RETIREMENT EXEMPTION: a $500,000 LIFETIME-capped
--     exemption (s152-320), elected by the taxpayer (s152-305), of the active-asset
--     gain remaining after the discount and the 50% reduction. The cap is tracked
--     in the ledger from 0143 (this slice's first migration) and read via
--     cgt_retirement_cap_remaining().
--   * Subdiv 152-E — small-business (replacement-asset) ROLL-OVER: defers (disregards
--     now) all or part of the remaining gain (s152-415), NO dollar cap. NOTE: this
--     is the s152-E replacement-asset roll-over (reinvest to defer), NOT the
--     Subdiv 328-G small-business RESTRUCTURE roll-over — different relief entirely.
--
-- ── ELECTED, not automatic ────────────────────────────────────────────────────
-- Both are CHOICES the taxpayer makes (unlike the auto 50% reduction). Each is
-- recorded per disposal as an explicit cents amount on cgt_events:
--     retirement_exemption_elected_cents  — amount to apply under Subdiv 152-D
--     small_business_rollover_cents       — amount to defer under Subdiv 152-E
-- defaulting to 0 so neither ever applies on assumed facts (matches the SC-4.F.02
-- fifteen_year_condition_met stance). The calc SUMS the elections over the active
-- gain events and applies them against the active pool — never auto-maximising.
--
-- ── MATH (extends 0142's 4-bucket waterfall; active pool only) ────────────────
-- Subdiv 152-D/E relief is available ONLY for active-asset gains that passed the
-- basic-conditions gate. The pool they draw from is the active gain left after the
-- Div 115 discount and the Subdiv 152-C 50% reduction:
--     v_a_final = v_a_postdisc - v_reduction_cents      (active, post-discount, post-50%)
-- Standard order, retirement first then rollover on the remainder:
--     retirement_applied = least(elected_retirement, cap_remaining, v_a_final)
--     rollover_applied   = least(elected_rollover, v_a_final - retirement_applied)
--     net_capital_gain   = v_net_after - retirement_applied - rollover_applied
-- The non-active buckets in v_net_after are untouched (Subdiv 152 never reaches
-- them), and retirement_applied + rollover_applied <= v_a_final, so the final net
-- can never go negative. All integer cents — the reported figures tie out exactly.
--
-- net_capital_gain_cents is now the FINAL post-ALL-concessions assessable amount
-- (the figure SC-4.G/4.H read); the prior value (post-discount/reduction, pre-D/E)
-- is preserved as net_capital_gain_before_sbe_concessions_cents.
--
-- ── CAVEATS surfaced to the approver (sbe_concession_caveats) ─────────────────
-- The engine deliberately does NOT assert these — a human verifies them:
--   * Under-55 stakeholders must contribute the exempt amount to a complying super
--     fund/RSA for the retirement exemption to hold (s152-305); not modelled here.
--   * The $500k cap is per CGT concession STAKEHOLDER; this calc tracks it at the
--     org level (one $500k — conservative, may under-claim for multi-stakeholder
--     entities). See 0143.
--   * The taxpayer may elect OUT of the 50% reduction (s152-220) to apply D/E to a
--     larger base, and may order D and E freely; this calc applies the STANDARD
--     order (reduction, then retirement, then rollover). Optimising the order is the
--     advisory engine's job (Phase-6 SC-6.E).
--   * A rolled-over gain crystallises later via CGT event J5/J6/J2 if no/insufficient
--     replacement asset is acquired in the replacement period — a FUTURE event
--     recorded as a fresh cgt_events row, not part of this current-year deferral.
--
-- MIGRATION NUMBER: ledger planned 0134, taken (0134_*); reassigned to 0144 per the
-- drift rule — repo head is 0143_cgt_retirement_cap_tracking (this slice's first
-- migration). SECURITY INVOKER, STABLE, read-only throughout. Verified live
-- (dxoikltymmknxqpkpyhi): business_profile/get_accessible_org_ids present; cgt_events,
-- cgt_calc, cgt_retirement_cap_remaining are committed-but-not-deployed
-- (0138/0142/0143), staged with this file for the rolled-back live test.

-- ── 1. Per-event election inputs (default 0 — never auto-applied) ──────────────
alter table public.cgt_events
  add column retirement_exemption_elected_cents bigint not null default 0
    check (retirement_exemption_elected_cents >= 0),
  add column small_business_rollover_cents bigint not null default 0
    check (small_business_rollover_cents >= 0);

comment on column public.cgt_events.retirement_exemption_elected_cents is
  'SC-4.F.03: amount of this disposal''s gain the taxpayer elects to exempt under '
  'the small-business retirement exemption (Subdiv 152-D), money-in-cents. Summed '
  'over the active gain events by cgt_calc and applied against the active pool, '
  'capped at the $500k lifetime limit (cgt_retirement_cap_remaining). Default 0 — '
  'the elected figure (s152-305) is never auto-applied.';
comment on column public.cgt_events.small_business_rollover_cents is
  'SC-4.F.03: amount of this disposal''s gain the taxpayer elects to DEFER under the '
  'small-business replacement-asset roll-over (Subdiv 152-E, s152-415), money-in-'
  'cents. No dollar cap; requires a replacement active asset within the replacement '
  'period (asserted by the approver). Default 0. NOT the Subdiv 328-G restructure '
  'roll-over.';

-- ── 2. cgt_calc: + Subdiv 152-D retirement exemption & 152-E roll-over ─────────
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
  v_entity_type     text;
  v_discount_rate   numeric;                 -- 0 | 1/3 | 1/2 (company | smsf | else)
  v_size            jsonb;
  v_size_passed     boolean;
  v_cf_in           bigint  := 0;            -- carried-forward losses into this FY
  -- current-FY scan outputs (buckets are already GATE-EFFECTIVE):
  v_cy_gains        bigint;
  v_cy_losses       bigint;
  v_na_nd           bigint;                  -- non-active, non-discount  gross gain
  v_na_d            bigint;                  -- non-active, discount      gross gain
  v_a_nd            bigint;                  -- active,     non-discount  gross gain
  v_a_d             bigint;                  -- active,     discount      gross gain
  v_exempt          bigint;                  -- 15-year-exempt gross gain (disregarded)
  v_has_active_gain boolean;
  v_event_count     int;
  v_elected_retire  bigint;                  -- Σ elected retirement exemption (active gains)
  v_elected_roll    bigint;                  -- Σ elected roll-over deferral   (active gains)
  v_events          jsonb;
  -- loss waterfall remainders:
  v_loss_pool       bigint;
  v_rem             bigint;
  v_na_nd_rem       bigint;
  v_na_d_rem        bigint;
  v_a_nd_rem        bigint;
  v_a_d_rem         bigint;
  v_nonexempt_gross bigint;
  v_loss_cf         bigint;
  v_cf_applied      bigint;
  -- discount + 50% reduction (integer cents):
  v_disc_na_d       bigint;
  v_disc_a_d        bigint;
  v_discount_cents  bigint;
  v_a_postdisc      bigint;
  v_reduction_cents bigint;
  v_before_discount bigint;
  v_net_after       bigint;                  -- post-discount/reduction, pre Subdiv 152-D/E
  -- Subdiv 152-D retirement exemption + Subdiv 152-E roll-over:
  v_a_final         bigint;                  -- active gain remaining = the D/E pool
  v_cap_remaining   bigint;                  -- $500k lifetime cap before this FY
  v_retire_applied  bigint;
  v_roll_applied    bigint;
  v_net_final       bigint;                  -- FINAL post-ALL-concessions assessable
  rec               record;
begin
  -- Entity discount rate (single source of truth) + the size limb of the gate.
  select entity_type into v_entity_type from business_profile where organization_id = p_org;
  v_discount_rate := case
                       when v_entity_type = 'company' then 0
                       when v_entity_type = 'smsf'    then 1::numeric / 3
                       else                                1::numeric / 2
                     end;
  v_size        := cgt_sbe_size_eligible(p_org, p_fy_start_year);
  v_size_passed := (v_size ->> 'passed')::boolean;

  -- Carry-forward: roll losses forward through every PRIOR FY (oldest first).
  -- Unchanged from 0142 — pre-discount netting is concession-independent.
  for rec in
    select
      case when extract(month from e.disposal_date) >= 7
           then extract(year from e.disposal_date)::int
           else extract(year from e.disposal_date)::int - 1 end as fy_year,
      sum(greatest(e.proceeds_cents - e.cost_base, 0))         as gains,
      sum(greatest(e.reduced_cost_base - e.proceeds_cents, 0)) as losses
    from (
      select disposal_date, proceeds_cents,
        ( acquisition_cost_cents + incidental_costs_cents + ownership_costs_cents
          + capital_improvement_cents + title_costs_cents )   as cost_base,
        ( acquisition_cost_cents + incidental_costs_cents
          + capital_improvement_cents + title_costs_cents )   as reduced_cost_base
      from cgt_events
      where organization_id = p_org and deleted_at is null and disposal_date < v_fy_start
    ) e
    group by 1 order by 1
  loop
    v_cf_in := greatest(0, v_cf_in + rec.losses - rec.gains);
  end loop;

  -- Current-FY events: one scan. The gate is uniform across rows
  -- (size_passed AND there is a business_asset gain), so a window bool_or gives
  -- it per row; buckets, elected D/E amounts and the event detail are gate-effective.
  with ev as (
    select id, asset_description, asset_type, event_type, acquisition_date, disposal_date,
      proceeds_cents,
      ( acquisition_cost_cents + incidental_costs_cents + ownership_costs_cents
        + capital_improvement_cents + title_costs_cents )     as cost_base,
      ( acquisition_cost_cents + incidental_costs_cents
        + capital_improvement_cents + title_costs_cents )     as reduced_cost_base,
      coalesce(fifteen_year_condition_met, false)             as fy15_met,
      retirement_exemption_elected_cents                      as elected_retire,
      small_business_rollover_cents                           as elected_roll
    from cgt_events
    where organization_id = p_org and deleted_at is null
      and disposal_date between v_fy_start and v_fy_end
  ),
  calc as (
    select ev.*,
      greatest(ev.proceeds_cents - ev.cost_base, 0)         as gain,
      greatest(ev.reduced_cost_base - ev.proceeds_cents, 0) as loss,
      (ev.asset_type = 'business_asset')                    as active,
      ( ev.acquisition_date is not null
        and ev.disposal_date > (ev.acquisition_date + interval '12 months')::date ) as held,
      ( ev.acquisition_date is not null
        and ev.disposal_date >= (ev.acquisition_date + interval '15 years')::date ) as owned_15yr
    from ev
  ),
  gated as (
    select c.*, (v_size_passed and bool_or(c.active and c.gain > 0) over ()) as gate
    from calc c
  ),
  fin as (
    select g.*,
      (g.gate and g.active) as eff_active,
      (g.gate and g.active and g.owned_15yr and g.fy15_met and g.gain > 0) as is_exempt
    from gated g
  )
  select
    coalesce(sum(gain), 0),
    coalesce(sum(loss), 0),
    coalesce(sum(gain) filter (where not is_exempt and not eff_active and not held), 0),
    coalesce(sum(gain) filter (where not is_exempt and not eff_active and     held), 0),
    coalesce(sum(gain) filter (where not is_exempt and     eff_active and not held), 0),
    coalesce(sum(gain) filter (where not is_exempt and     eff_active and     held), 0),
    coalesce(sum(gain) filter (where is_exempt), 0),
    coalesce(bool_or(eff_active and gain > 0), false),
    count(*),
    -- elected D/E amounts only count where Subdiv 152 can actually apply (active,
    -- gated, gain>0); elections on non-active / non-gain rows are ignored.
    coalesce(sum(elected_retire) filter (where eff_active and gain > 0), 0),
    coalesce(sum(elected_roll)   filter (where eff_active and gain > 0), 0),
    coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'asset_description', asset_description, 'asset_type', asset_type,
      'event_type', event_type, 'acquisition_date', acquisition_date, 'disposal_date', disposal_date,
      'proceeds_cents', proceeds_cents, 'cost_base_cents', cost_base,
      'reduced_cost_base_cents', reduced_cost_base, 'gain_cents', gain, 'loss_cents', loss,
      'discount_eligible', (held and gain > 0 and v_discount_rate > 0),
      'retirement_exemption_elected_cents', elected_retire,
      'small_business_rollover_elected_cents', elected_roll,
      'concession_status', case
        when is_exempt                       then 'fifteen_year_exempt'
        when eff_active and gain > 0         then 'active_asset_reduction'
        when held and gain > 0 and v_discount_rate > 0 then 'discount_only'
        else 'none' end
    ) order by disposal_date, id), '[]'::jsonb)
  into v_cy_gains, v_cy_losses, v_na_nd, v_na_d, v_a_nd, v_a_d, v_exempt,
       v_has_active_gain, v_event_count, v_elected_retire, v_elected_roll, v_events
  from fin;

  -- Apply losses to the non-exempt buckets, highest-taxed first.
  v_loss_pool := v_cy_losses + v_cf_in;
  v_rem := v_loss_pool;
  v_na_nd_rem := greatest(0, v_na_nd - v_rem); v_rem := greatest(0, v_rem - v_na_nd);
  v_na_d_rem  := greatest(0, v_na_d  - v_rem); v_rem := greatest(0, v_rem - v_na_d);
  v_a_nd_rem  := greatest(0, v_a_nd  - v_rem); v_rem := greatest(0, v_rem - v_a_nd);
  v_a_d_rem   := greatest(0, v_a_d   - v_rem); v_rem := greatest(0, v_rem - v_a_d);
  v_loss_cf   := v_rem;                          -- losses left (exempt gains absorb none)
  v_nonexempt_gross := v_na_nd + v_na_d + v_a_nd + v_a_d;
  v_cf_applied := least(v_cf_in, greatest(0, v_nonexempt_gross - v_cy_losses));

  -- Discount (Div 115) then 50% active-asset reduction (Subdiv 152-C), integer
  -- cents so the reported figures tie out exactly.
  v_disc_na_d      := round(v_na_d_rem * v_discount_rate)::bigint;
  v_disc_a_d       := round(v_a_d_rem  * v_discount_rate)::bigint;
  v_discount_cents := v_disc_na_d + v_disc_a_d;
  v_a_postdisc     := v_a_nd_rem + (v_a_d_rem - v_disc_a_d);   -- active gain after discount
  v_reduction_cents := round(v_a_postdisc::numeric / 2)::bigint;
  v_before_discount := v_na_nd_rem + v_na_d_rem + v_a_nd_rem + v_a_d_rem;
  v_net_after := v_na_nd_rem + (v_na_d_rem - v_disc_na_d) + (v_a_postdisc - v_reduction_cents);

  -- Subdiv 152-D retirement exemption then Subdiv 152-E roll-over (gated, LAST in
  -- ITAA order). Both draw only from the active pool left after discount + 50%
  -- reduction; the non-active portion of v_net_after is never touched. Retirement
  -- first (capped at the $500k lifetime limit, the elected sum and the pool), then
  -- the roll-over defers as much of the remainder as elected. Sums of both are
  -- bounded by v_a_final, so v_net_final >= the non-active remainder >= 0.
  v_a_final        := greatest(0, v_a_postdisc - v_reduction_cents);
  v_cap_remaining  := cgt_retirement_cap_remaining(p_org, p_fy_start_year);
  v_retire_applied := least(v_elected_retire, v_cap_remaining, v_a_final);
  v_roll_applied   := least(v_elected_roll, greatest(0, v_a_final - v_retire_applied));
  v_net_final      := v_net_after - v_retire_applied - v_roll_applied;

  return jsonb_build_object(
    'organization_id',                        p_org,
    'fy_start_year',                          p_fy_start_year,
    'period_start',                           v_fy_start,
    'period_end',                             v_fy_end,
    'entity_type',                            v_entity_type,
    'cgt_discount_rate',                      round(v_discount_rate, 6),
    'sbe_eligible',                           (v_size_passed and v_has_active_gain),
    'size_condition',                         v_size,
    'event_count',                            v_event_count,
    'current_year_capital_gains_cents',       v_cy_gains,
    'current_year_capital_losses_cents',      v_cy_losses,
    'carried_forward_losses_available_cents', v_cf_in,
    'carried_forward_losses_applied_cents',   v_cf_applied,
    'discountable_gain_cents',                v_na_d_rem + v_a_d_rem,    -- discount-eligible after losses
    'cgt_discount_cents',                     v_discount_cents,
    'active_asset_reduction_cents',           v_reduction_cents,         -- Subdiv 152-C
    'fifteen_year_exemption_cents',           v_exempt,                  -- Subdiv 152-B (full disregard)
    'retirement_exemption_elected_cents',     v_elected_retire,          -- Subdiv 152-D, as elected
    'retirement_exemption_cap_remaining_cents', v_cap_remaining,         -- $500k lifetime, before this FY
    'retirement_exemption_applied_cents',     v_retire_applied,          -- after cap + pool clamp
    'small_business_rollover_elected_cents',  v_elected_roll,            -- Subdiv 152-E, as elected
    'small_business_rollover_deferred_cents', v_roll_applied,            -- after pool clamp (no cap)
    'sbe_election_clamped',                   (v_retire_applied < v_elected_retire
                                               or v_roll_applied < v_elected_roll),  -- an elected D/E amount exceeded the cap or the active pool and was clamped — the approver should reconcile elected vs applied
    'net_capital_gain_before_discount_cents', v_before_discount,         -- post-loss, pre-concession (exempt removed)
    'net_capital_gain_before_sbe_concessions_cents', v_net_after,        -- post-discount/reduction, pre 152-D/E
    'net_capital_gain_cents',                 v_net_final,               -- FINAL post-ALL-concessions assessable
    'net_capital_loss_carried_forward_cents', v_loss_cf,
    'sbe_concession_caveats',                 jsonb_build_array(
      'Retirement exemption: an under-55 CGT concession stakeholder must contribute the exempt amount to a complying super fund / RSA for it to hold (s152-305) — not modelled; verify before relying on it.',
      'The $500,000 retirement-exemption cap is per CGT concession stakeholder (s152-320); this calc tracks it at the org level (a single $500k — conservative, may under-claim for multi-stakeholder entities).',
      'The taxpayer may elect out of the 50% active-asset reduction (s152-220) and may order the retirement exemption and roll-over freely; this calc applies the standard order (reduction, then retirement, then roll-over).',
      'A rolled-over gain crystallises later via CGT event J5/J6/J2 if no/insufficient replacement active asset is acquired in the replacement period — recorded then as a fresh CGT event, not here.'
    ),
    'events',                                 v_events
  );
end;
$$;

comment on function public.cgt_calc(uuid, integer) is
  'SC-4.F.03: net capital gain (jsonb) for an org + AU FY — raw netting (0139), the '
  'Div 115 12-month discount (0140), the Subdiv 152-B 15-year exemption + 152-C 50% '
  'active-asset reduction (0142), and now the Subdiv 152-D retirement exemption '
  '($500k lifetime cap via cgt_retirement_cap_remaining) + Subdiv 152-E replacement-'
  'asset roll-over — both elected per event, applied to the active pool after the '
  'reduction, in standard ITAA order. net_capital_gain_cents is the final post-ALL-'
  'concessions assessable amount. SECURITY INVOKER.';

revoke all on function public.cgt_calc(uuid, integer) from public, anon;
grant execute on function public.cgt_calc(uuid, integer) to authenticated;
