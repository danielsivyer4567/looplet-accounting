-- 0142_cgt_concession_15yr_50pct.sql — SC-4.F.02 (Phase 4, CGT small-business concessions)
--
-- Extends the CGT engine with the first two Subdiv 152 concessions — the 15-year
-- exemption (Subdiv 152-B, FULL disregard) and the 50% active-asset reduction
-- (Subdiv 152-C) — applied in ITAA order AFTER the Div 115 discount, and ONLY
-- when the Subdiv 152-A basic conditions (SC-4.F.01) are satisfied. The
-- retirement exemption + small-business rollover are the next slice (SC-4.F.03).
--
-- ── DEPENDENCY SHAPE (no circular calls) ──────────────────────────────────────
-- cgt_sbe_eligible (0141) already calls cgt_calc for its per-event gains, so
-- cgt_calc must NOT call cgt_sbe_eligible. We factor the size limb of the gate
-- (turnover < $2m OR MNAV <= $6m) into a leaf helper, cgt_sbe_size_eligible,
-- that reads only business_profile / the GL / generate_statutory_statements:
--     cgt_sbe_size_eligible   (leaf)
--          ▲            ▲
--          │            │
--       cgt_calc   ──►  (returns size_condition in its payload)
--          ▲
--          │
--    cgt_sbe_eligible  (now a thin presenter over cgt_calc — reads the gate +
--                       events it returns, builds the human reasons/caveats)
-- cgt_calc gates the concessions on  size_passed AND it has a business_asset gain
-- (== the basic-conditions gate for concession purposes). cgt_sbe_eligible's
-- public output shape is UNCHANGED (regression-checked against the SC-4.F.01
-- fixtures) — the turnover/MNAV computation just moved into the shared helper so
-- it is no longer duplicated and generate_statutory_statements runs once.
--
-- ── CONCESSION MATH (4-bucket aggregate, extends 0140's 2-bucket waterfall) ────
-- Non-exempt current-year GAINS are bucketed by (active?, discount-eligible?):
--   na_nd  non-active, not held >12mo   taxed 100%
--   na_d   non-active, held >12mo       taxed (1 - d)
--   a_nd   active,     not held >12mo   taxed 50%            (active reduction)
--   a_d    active,     held >12mo       taxed (1 - d) * 50%  (discount then reduction)
-- where d = the entity CGT discount rate (company 0, smsf 1/3, else 1/2; 0140).
-- ACTIVE here means asset_type = 'business_asset' ONLY — the unambiguously active
-- class. real_property / shares / crypto / other are treated as NON-active for
-- the auto-applied reduction (they need the manual active-asset assessment the
-- gate flags as needs_review); this is the safe prep-and-approve direction.
--
-- 15-YEAR EXEMPTION (s152-105/110): a gain is FULLY disregarded when the gate
-- passes AND the asset is active AND it was owned for >= 15 years (disposal_date
-- >= acquisition_date + 15y, derived) AND the non-derivable personal condition is
-- asserted (cgt_events.fifteen_year_condition_met: significant individual 55+ and
-- the event is in connection with retirement, OR permanently incapacitated —
-- default false, so the exemption never auto-applies on assumed facts). Exempt
-- gains are removed BEFORE losses (a disregarded gain absorbs no loss).
--
-- LOSS ORDERING (s102-5 step 2-3, then s102-30 freedom): capital losses (current
-- then carried-forward) are applied to the non-exempt buckets HIGHEST-taxED-FIRST
-- — na_nd, then na_d, then a_nd, then a_d — so each loss dollar removes the most
-- assessable gain. This is the taxpayer-favourable default for the common
-- individual/trust case (d = 1/2, where na_d and a_nd tie at 50%); company/smsf
-- (different d) may warrant review and the human approver can re-allocate.
-- Discount + reduction are then applied to the post-loss bucket remainders, in
-- integer cents (discount rounded per bucket, reduction rounded once) so the
-- reported figures tie out exactly: net = before_discount - discount - reduction.
--
-- net_capital_gain_cents is now the FINAL post-concession assessable amount (the
-- figure the return builder, SC-4.G/4.H, will read). The payload gains
-- sbe_eligible, size_condition, fifteen_year_exemption_cents and
-- active_asset_reduction_cents, and each event carries a descriptive
-- concession_status. SECURITY INVOKER, STABLE, read-only throughout.
--
-- MIGRATION NUMBER: ledger planned 0133, taken (0133_eofy_checks); reassigned to
-- 0142 per the drift rule — repo head is 0141_cgt_sbe_eligibility. Verified live
-- (dxoikltymmknxqpkpyhi): business_profile.entity_type CHECK already includes
-- 'smsf'; generate_statutory_statements / get_accessible_org_ids live; cgt_events
-- + cgt_calc + cgt_sbe_eligible committed-but-not-deployed (0138-0141), staged
-- with this file for the rolled-back live test.

-- ── 1. Per-event 15-year personal-condition flag (non-derivable; default false) ─
alter table public.cgt_events
  add column fifteen_year_condition_met boolean not null default false;

comment on column public.cgt_events.fifteen_year_condition_met is
  'SC-4.F.02: asserts the non-derivable 15-year-exemption personal condition — a '
  'significant individual aged 55+ and the CGT event is in connection with their '
  'retirement, OR they are permanently incapacitated (s152-105/110). Default false '
  'so the full-disregard exemption never applies on assumed facts; the 15-year '
  'ownership period itself is derived from acquisition_date/disposal_date.';

-- ── 2. Leaf helper: the SIZE limb of the Subdiv 152-A basic conditions ─────────
-- turnover < $2m  OR  maximum net asset value <= $6m. Lifted verbatim from the
-- SC-4.F.01 gate so cgt_calc and cgt_sbe_eligible share ONE implementation.
create or replace function public.cgt_sbe_size_eligible(p_org uuid, p_fy_start_year integer)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  c_turnover_threshold constant bigint := 200000000;   -- $2,000,000
  c_mnav_threshold     constant bigint := 600000000;    -- $6,000,000
  v_fy_start        date := make_date(p_fy_start_year, 7, 1);
  v_fy_end          date := make_date(p_fy_start_year + 1, 6, 30);
  v_bracket         text;
  v_turnover_cents  bigint;
  v_turnover_source text;
  v_turnover_passed boolean;
  v_turnover_desc   text;
  v_stmt            jsonb;
  v_total_assets    bigint;
  v_total_liab      bigint;
  v_net_assets      bigint;
  v_mnav_passed     boolean;
begin
  select aggregated_turnover_bracket, estimated_annual_turnover_cents
    into v_bracket, v_turnover_cents
  from business_profile where organization_id = p_org;

  if v_turnover_cents is not null then
    v_turnover_source := 'declared_estimate';
    v_turnover_passed := v_turnover_cents < c_turnover_threshold;
  elsif v_bracket = 'under_2m' then
    v_turnover_source := 'declared_bracket'; v_turnover_passed := true;
  elsif v_bracket in ('under_10m', 'under_50m', 'over_50m') then
    v_turnover_source := 'declared_bracket'; v_turnover_passed := false;
  else
    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_turnover_cents
    from journal_lines jl
    join journal_entries je   on je.id = jl.journal_entry_id
    join chart_of_accounts coa on coa.id = jl.account_id
    where je.organization_id = p_org and je.status = 'posted'
      and je.entry_date between v_fy_start and v_fy_end and coa.account_type = 'income';
    v_turnover_source := 'book_proxy';
    v_turnover_passed := v_turnover_cents < c_turnover_threshold;
  end if;

  v_turnover_desc := case
    when v_turnover_source = 'declared_bracket' then format('declared turnover bracket %s', coalesce(v_bracket, 'unknown'))
    when v_turnover_source = 'book_proxy' then format('$%s (book revenue proxy)', format_aud_cents(v_turnover_cents))
    else format('$%s', format_aud_cents(v_turnover_cents))
  end;

  v_stmt         := generate_statutory_statements(p_org, p_fy_start_year);
  v_total_assets := coalesce((v_stmt -> 'balance_sheet' ->> 'total_assets_cents')::bigint, 0);
  v_total_liab   := coalesce((v_stmt -> 'balance_sheet' ->> 'total_liabilities_cents')::bigint, 0);
  v_net_assets   := v_total_assets - v_total_liab;
  v_mnav_passed  := v_net_assets <= c_mnav_threshold;

  return jsonb_build_object(
    'passed', coalesce(v_turnover_passed, false) or v_mnav_passed,
    'turnover_test', jsonb_build_object(
      'passed', v_turnover_passed, 'threshold_cents', c_turnover_threshold,
      'aggregated_turnover_cents', v_turnover_cents, 'turnover_bracket', v_bracket,
      'source', v_turnover_source, 'reason', v_turnover_desc),
    'mnav_test', jsonb_build_object(
      'passed', v_mnav_passed, 'threshold_cents', c_mnav_threshold,
      'net_asset_value_cents', v_net_assets, 'total_assets_cents', v_total_assets,
      'total_liabilities_cents', v_total_liab, 'basis', 'book_net_assets_unaggregated')
  );
end;
$$;

comment on function public.cgt_sbe_size_eligible(uuid, integer) is
  'SC-4.F.02: the SIZE limb of the Subdiv 152-A basic conditions (turnover < $2m '
  'from business_profile/book revenue, OR MNAV <= $6m from the statutory balance '
  'sheet) as jsonb {passed, turnover_test, mnav_test}. Leaf helper shared by '
  'cgt_calc (concession gating) and cgt_sbe_eligible (the gate presenter). '
  'SECURITY INVOKER — RLS scopes the caller.';

revoke all on function public.cgt_sbe_size_eligible(uuid, integer) from public, anon;
grant execute on function public.cgt_sbe_size_eligible(uuid, integer) to authenticated;

-- ── 3. cgt_calc: discount (0140) + Subdiv 152 concessions, gated ───────────────
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
  -- concessions (integer cents):
  v_disc_na_d       bigint;
  v_disc_a_d        bigint;
  v_discount_cents  bigint;
  v_a_postdisc      bigint;
  v_reduction_cents bigint;
  v_before_discount bigint;
  v_net_after       bigint;
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
  -- Unchanged from 0140/0139 — pre-discount netting is concession-independent.
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
  -- it per row; buckets and the event detail are then gate-effective.
  with ev as (
    select id, asset_description, asset_type, event_type, acquisition_date, disposal_date,
      proceeds_cents,
      ( acquisition_cost_cents + incidental_costs_cents + ownership_costs_cents
        + capital_improvement_cents + title_costs_cents )     as cost_base,
      ( acquisition_cost_cents + incidental_costs_cents
        + capital_improvement_cents + title_costs_cents )     as reduced_cost_base,
      coalesce(fifteen_year_condition_met, false)             as fy15_met
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
    coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'asset_description', asset_description, 'asset_type', asset_type,
      'event_type', event_type, 'acquisition_date', acquisition_date, 'disposal_date', disposal_date,
      'proceeds_cents', proceeds_cents, 'cost_base_cents', cost_base,
      'reduced_cost_base_cents', reduced_cost_base, 'gain_cents', gain, 'loss_cents', loss,
      'discount_eligible', (held and gain > 0 and v_discount_rate > 0),
      'concession_status', case
        when is_exempt                       then 'fifteen_year_exempt'
        when eff_active and gain > 0         then 'active_asset_reduction'
        when held and gain > 0 and v_discount_rate > 0 then 'discount_only'
        else 'none' end
    ) order by disposal_date, id), '[]'::jsonb)
  into v_cy_gains, v_cy_losses, v_na_nd, v_na_d, v_a_nd, v_a_d, v_exempt,
       v_has_active_gain, v_event_count, v_events
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
    'net_capital_gain_before_discount_cents', v_before_discount,         -- post-loss, pre-concession (exempt removed)
    'net_capital_gain_cents',                 v_net_after,               -- FINAL post-concession assessable
    'net_capital_loss_carried_forward_cents', v_loss_cf,
    'events',                                 v_events
  );
end;
$$;

comment on function public.cgt_calc(uuid, integer) is
  'SC-4.F.02: net capital gain (jsonb) for an org + AU FY — raw netting (0139), '
  'the Div 115 12-month discount (0140) AND the Subdiv 152 concessions: the '
  '15-year exemption (full disregard, gated + cgt_events.fifteen_year_condition_met) '
  'and the 50% active-asset reduction, applied after the discount and only when the '
  'basic conditions hold (size limb via cgt_sbe_size_eligible + a business_asset '
  'gain). net_capital_gain_cents is the final post-concession assessable amount. '
  'SECURITY INVOKER. Retirement exemption + rollover: SC-4.F.03.';

revoke all on function public.cgt_calc(uuid, integer) from public, anon;
grant execute on function public.cgt_calc(uuid, integer) to authenticated;

-- ── 4. cgt_sbe_eligible: thin presenter over cgt_calc (de-duped gate) ──────────
create or replace function public.cgt_sbe_eligible(p_org uuid, p_fy_start_year integer)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fy_start        date := make_date(p_fy_start_year, 7, 1);
  v_fy_end          date := make_date(p_fy_start_year + 1, 6, 30);
  v_calc            jsonb;
  v_entity_type     text;
  v_size            jsonb;
  v_size_passed     boolean;
  v_turnover_passed boolean;
  v_turnover_desc   text;
  v_net_assets      bigint;
  v_events          jsonb;
  v_gain_count      int;
  v_gross_gain      bigint;
  v_active_count    int;
  v_notactive_count int;
  v_review_count    int;
  v_active_assets   jsonb;
  v_gain_present    boolean;
  v_active_passed   boolean;
  v_eligible        boolean;
  v_cgt_event_reason text;
  v_size_reason      text;
  v_active_reason    text;
  v_reasons          jsonb;
begin
  v_calc        := cgt_calc(p_org, p_fy_start_year);
  v_entity_type := v_calc ->> 'entity_type';
  v_size        := v_calc -> 'size_condition';
  v_size_passed := (v_size ->> 'passed')::boolean;
  v_turnover_passed := (v_size -> 'turnover_test' ->> 'passed')::boolean;
  v_turnover_desc   := v_size -> 'turnover_test' ->> 'reason';
  v_net_assets      := coalesce((v_size -> 'mnav_test' ->> 'net_asset_value_cents')::bigint, 0);
  v_events          := coalesce(v_calc -> 'events', '[]'::jsonb);

  -- Active-asset test (gate level): classify each current-FY GAIN event.
  select
    count(*) filter (where (e.v ->> 'gain_cents')::bigint > 0),
    coalesce(sum((e.v ->> 'gain_cents')::bigint) filter (where (e.v ->> 'gain_cents')::bigint > 0), 0),
    count(*) filter (where (e.v ->> 'gain_cents')::bigint > 0 and e.v ->> 'asset_type' = 'business_asset'),
    count(*) filter (where (e.v ->> 'gain_cents')::bigint > 0 and e.v ->> 'asset_type' in ('collectable', 'personal_use')),
    count(*) filter (where (e.v ->> 'gain_cents')::bigint > 0 and coalesce(e.v ->> 'asset_type', 'other') not in ('business_asset', 'collectable', 'personal_use')),
    coalesce(jsonb_agg(jsonb_build_object(
      'id', e.v -> 'id', 'asset_description', e.v ->> 'asset_description', 'asset_type', e.v ->> 'asset_type',
      'gain_cents', (e.v ->> 'gain_cents')::bigint,
      'active_status', case when e.v ->> 'asset_type' = 'business_asset' then 'active'
                           when e.v ->> 'asset_type' in ('collectable', 'personal_use') then 'not_active'
                           else 'needs_review' end
    ) order by e.v ->> 'disposal_date', e.v ->> 'id') filter (where (e.v ->> 'gain_cents')::bigint > 0), '[]'::jsonb)
  into v_gain_count, v_gross_gain, v_active_count, v_notactive_count, v_review_count, v_active_assets
  from jsonb_array_elements(v_events) as e(v);

  v_gain_present  := v_gain_count > 0;
  v_active_passed := v_active_count > 0;
  v_eligible := v_gain_present and v_size_passed and v_active_passed;

  v_cgt_event_reason := case
    when v_gain_present then format('%s CGT event(s) with a capital gain in this FY (gross gain $%s).', v_gain_count, format_aud_cents(v_gross_gain))
    else 'No CGT event resulting in a capital gain in this FY — the small-business concessions do not apply.'
  end;
  v_size_reason := case
    when v_size_passed and coalesce(v_turnover_passed, false) then format('Size condition met: aggregated turnover %s is under the $2,000,000 CGT small-business-entity threshold.', v_turnover_desc)
    when v_size_passed then format('Size condition met: maximum net asset value $%s is within the $6,000,000 limit.', format_aud_cents(v_net_assets))
    else format('Size condition NOT met: turnover %s is not under $2,000,000 and net assets $%s exceed the $6,000,000 limit.', v_turnover_desc, format_aud_cents(v_net_assets))
  end;
  v_active_reason := case
    when v_active_passed then format('Active-asset test met: %s active asset(s) disposed.', v_active_count) || case when v_review_count > 0 then format(' (%s asset(s) need manual active-asset review.)', v_review_count) else '' end
    when not v_gain_present then 'Active-asset test not applicable: no CGT gain events this FY.'
    when v_review_count > 0 then format('Active-asset test needs review: %s disposed asset(s) require manual active-asset assessment; none are clearly active.', v_review_count)
    else 'Active-asset test NOT met: the disposed asset(s) are not active assets (collectables / personal-use).'
  end;
  v_reasons := jsonb_build_array(v_cgt_event_reason, v_size_reason, v_active_reason,
    format('Overall: this org %s the small-business CGT concession basic conditions for FY%s–%s.', case when v_eligible then 'MEETS' else 'does NOT meet' end, p_fy_start_year, p_fy_start_year + 1));

  return jsonb_build_object(
    'organization_id', p_org, 'fy_start_year', p_fy_start_year, 'period_start', v_fy_start, 'period_end', v_fy_end,
    'entity_type', v_entity_type, 'eligible', v_eligible,
    'turnover_test', v_size -> 'turnover_test',
    'mnav_test', v_size -> 'mnav_test',
    'size_condition', jsonb_build_object('passed', v_size_passed, 'reason', v_size_reason),
    'cgt_event_with_gain', jsonb_build_object('passed', v_gain_present, 'gain_event_count', v_gain_count, 'total_gross_gain_cents', v_gross_gain, 'reason', v_cgt_event_reason),
    'active_asset_test', jsonb_build_object('passed', v_active_passed, 'active_event_count', v_active_count, 'needs_review_count', v_review_count, 'not_active_event_count', v_notactive_count, 'reason', v_active_reason),
    'active_assets', v_active_assets, 'reasons', v_reasons,
    'caveats', jsonb_build_array(
      'MNAV uses BOOK net assets (assets - liabilities) as-at, not the strict s152-20 figure: it does not use market values, does not aggregate connected entities / affiliates, and does not apply the dwelling / personal-use-asset exclusions.',
      'Aggregated turnover is the declared figure on the business profile (or, when undeclared, the org''s own book revenue) and does NOT aggregate connected entities / affiliates (s328-115).',
      'The active-asset test here classifies by asset_type only. The s152-35 time test (active for at least half the ownership period, or 7.5 years) is not computed, and assets marked needs_review (shares, real property, crypto, other) require manual assessment.',
      'Additional conditions for shares / interests in a trust (s152-10(2)) and the partner / passively-held-asset rules are not assessed by this gate.'
    )
  );
end;
$$;

comment on function public.cgt_sbe_eligible(uuid, integer) is
  'SC-4.F.01/4.F.02: small-business CGT concession GATE (Subdiv 152-A basic '
  'conditions) for an org + AU FY, as jsonb pass/fail-with-reasons. Thin presenter '
  'over cgt_calc — reads its size_condition (turnover/MNAV via cgt_sbe_size_eligible) '
  'and per-event gains, adds the active-asset classification and human reasons. '
  'SECURITY INVOKER — RLS scopes the caller. Concession AMOUNTS are in cgt_calc.';

revoke all on function public.cgt_sbe_eligible(uuid, integer) from public, anon;
grant execute on function public.cgt_sbe_eligible(uuid, integer) to authenticated;
