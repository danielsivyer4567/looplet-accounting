-- 0157_distribution_streaming.sql — SC-5.C.03 (Phase 5, Trusts — streaming overlay)
--
-- stream_trust_distribution(org, fy[, trust]) — the STREAMING OVERLAY on the distribution
-- optimiser core (SC-5.C.02). It re-characterises each beneficiary's allocated share into
-- the three income-class buckets trust_distributions (SC-5.A.03) persists — streamed net
-- capital gain (Subdiv 115-C), streamed franked distributions + their attached franking
-- credits (Subdiv 207-B), and the non-streamable remainder (ordinary + foreign) — choosing
-- WHICH beneficiary gets each streamable class so as to minimise total family tax, subject
-- to the deed's streaming_allowed flag (SC-5.A.02). ADVISORY ONLY — no writes; persistence
-- to draft trust_distributions is SC-5.C.04.
--
-- ── A REFINEMENT, NOT A SEPARATE ENGINE ────────────────────────────────────────
-- The core optimiser (SC-5.C.02) already decided how much TOTAL each beneficiary receives
-- (its greedy bracket-fill over one ordinary pool — the conservative baseline). This slice
-- keeps those per-beneficiary TOTALS fixed and only overlays the income-class CHARACTER of
-- each beneficiary's dollars. So:
--   * every beneficiary's allocation_cents here == the core's allocation_cents, and
--   * sum(allocations) + trustee_retained == net income, exactly as the core reported.
-- Keeping totals fixed is what makes this "a true refinement of the existing allocation,
-- not a separate engine" (the ledger) and independently assertable per income class. The
-- price is that streaming cannot shift MORE total to a discount-eligible beneficiary than
-- the core already gave them — that joint re-optimisation is deliberately out of scope and
-- documented in caveats.
--
-- ── INCOME CLASSES (read from SC-5.B.01) ───────────────────────────────────────
-- trust_net_income(org, fy).income_classes splits the s95 net income into:
--   ordinary_cents, net_capital_gain_cents, franked_distribution{cash, credits, class_total},
--   foreign_cents — the four summing to net income. The franked CLASS is grossed (cash +
--   franking credit); the s95 pool the core allocated is likewise grossed, so a beneficiary's
--   share of the franked class is the GROSSED amount, later split back into cash + credit.
--
-- ── STREAMING (deed streaming_allowed = true) ──────────────────────────────────
-- Two greedy water-fills over the fixed per-beneficiary budgets (the core allocations):
--   1. Net capital gain → ordered by EFFECTIVE post-discount rate ascending
--      (marginal_rate × (1 − CGT discount): individual/trust 50%, SMSF 33⅓%, company/charity
--      0%). A discount-eligible beneficiary's gain is taxed at half their rate, so it lands
--      below a company's full-rate gain — the gain streams to whoever bears the least tax on
--      it. Each beneficiary capped at their budget; pool capped to fit (see deduction-fit).
--   2. Franked distributions → ordered by marginal_rate ascending, filling each beneficiary's
--      budget REMAINING after its capital-gain stream. Net tax on a franked dollar is
--      grossed × (rate − 30%) — negative (a refund of excess credits) below 30% — so the
--      lowest-rate beneficiary is the best home. The attached franking credit FOLLOWS the
--      franked dividend proportionally (credit_i / franked_i == trust credit / trust franked).
-- The leftover budget after both streams is the beneficiary's ordinary + foreign share.
--
-- ── NO STREAMING (deed streaming_allowed = false, the conservative default) ─────
-- A beneficiary presently entitled to a share of trust income takes that share of EVERY
-- class proportionately (the default flow-through; no specific entitlement). Each
-- beneficiary's capital-gain / franked / credit / other are their budget-proportionate
-- slices. Computed by cumulative-floor so the class sums are exact to the cent and never
-- exceed a beneficiary's budget (other stays ≥ 0).
--
-- ── EXACT, NON-NEGATIVE, CHECK-CLEAN COMPONENTS ────────────────────────────────
-- trust_distributions enforces amount = capital_gain + franked_dividend + other (franking
-- credit rides alongside, excluded) and all components ≥ 0. This overlay constructs the
-- components so BOTH always hold, so SC-5.C.04 can persist them unchanged:
--   other_cents  := budget − capital_gain − franked_GROSSED   (residual, ≥ 0 by construction)
--   amount_cents := budget − franking_credit                  (= cap + franked_cash + other)
-- The water-fill (streaming) caps each stream at the remaining budget; the cumulative-floor
-- (proportional) keeps each beneficiary's combined stream ≤ budget — so other never goes
-- negative either way.
--
-- ── DEDUCTION-FIT (the trust_net_income reconciles=false edge) ──────────────────
-- In a franked-distribution-heavy trust, general deductions can exceed ordinary income so the
-- residual ordinary class is negative (trust_net_income flags reconciles=false). The streamed
-- classes (ncg + franked) would then exceed the distributable budgets. We absorb the excess
-- deduction by scaling ncg and the franked class proportionally down to the room left after
-- the non-negative ordinary + foreign — so the streamed pools fit the budgets and the four
-- class shares still sum to net income. classes_reduced flags it; the reconciles flag from
-- SC-5.B.01 is passed through. (In the normal year the scale factor is 1 — a no-op.)
--
-- ── REUSE ──────────────────────────────────────────────────────────────────────
-- Core totals + trust resolution + deed deny/allow + trustee residual ← optimise_trust_
-- distribution (SC-5.C.02): called once; its trust_id resolves the trust (and raises the
-- same multi-active-trust error), so none of that logic is duplicated here. Per-beneficiary
-- marginal_rate ← distribution_inputs (SC-5.C.01). Income classes ← trust_net_income
-- (SC-5.B.01). streaming_allowed ← trust_deed (SC-5.A.02). All SECURITY INVOKER + STABLE,
-- so every read is RLS-scoped to the caller; a foreign org degrades to an empty proposal.
-- No writes — the proposal is cheap to recompute and independently checkable.
--
-- MIGRATION NUMBER: the ledger Files line planned 0148, long taken (book_to_tax). Reassigned
-- to 0157 per the drift rule — the sequential repo head is 0156_distribution_optimiser
-- (0178/0179 are late hotfixes that sort after). Verified live (dxoikltymmknxqpkpyhi,
-- read-only): stream_trust_distribution ABSENT and the whole 0151–0156 trust chain
-- (optimise_trust_distribution, trust_net_income, distribution_inputs, trust_deed,
-- trust_distributions, resident_marginal_rates) committed-but-NOT-deployed (deploys
-- together) — no drift.

create or replace function public.stream_trust_distribution(
    p_org uuid, p_fy_start_year integer, p_trust uuid default null)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fy_start          date := make_date(p_fy_start_year, 7, 1);
  v_fy_end            date := make_date(p_fy_start_year + 1, 6, 30);
  v_core              jsonb;     -- optimise_trust_distribution (SC-5.C.02) output
  v_di                jsonb;     -- distribution_inputs (SC-5.C.01) output
  v_tni               jsonb;     -- trust_net_income (SC-5.B.01) output
  v_trust             uuid;
  v_streaming_allowed boolean;
  v_has_deed          boolean;
  v_reconciles        boolean;
  -- income classes (grossed) + s95 total
  v_net_income        bigint;
  v_ncg               bigint;    -- net capital gain (post trust-level discount)
  v_franked_cash      bigint;    -- franked dividend cash
  v_franking_cr       bigint;    -- attached franking credit (gross-up)
  v_franked_class     bigint;    -- franked grossed = cash + credit
  v_foreign           bigint;
  v_ordinary          bigint;
  -- deduction-fitted streamable pools (== the class amounts in a normal/reconciling year)
  v_room              bigint;
  v_factor            numeric;
  v_ncg_eff           bigint;
  v_franked_eff       bigint;    -- grossed
  v_pool_streamed     bigint;    -- v_ncg_eff + v_franked_eff
  v_trustee_retained  bigint;    -- core's residual the eligible set could not absorb (s99A)
  v_result            jsonb;
begin
  -- 1. Core allocation (SC-5.C.02). Delegating trust resolution to the core means the
  --    multi-active-trust / no-trust errors raise there once, not duplicated here.
  v_core             := optimise_trust_distribution(p_org, p_fy_start_year, p_trust);
  v_trust            := (v_core ->> 'trust_id')::uuid;
  v_trustee_retained := coalesce((v_core #>> '{totals,trustee_retained_cents}')::bigint, 0);

  -- 2. Per-beneficiary marginal rates (for the streaming priority orderings).
  v_di := distribution_inputs(p_org, v_trust, p_fy_start_year);

  -- 3. Income-class split (SC-5.B.01). The franked class is grossed (cash + credit).
  v_tni           := trust_net_income(p_org, p_fy_start_year);
  v_net_income    := coalesce((v_tni ->> 'net_income_cents')::bigint, 0);
  v_ncg           := coalesce((v_tni #>> '{income_classes,net_capital_gain_cents}')::bigint, 0);
  v_franked_cash  := coalesce((v_tni #>> '{income_classes,franked_distribution,cash_dividends_cents}')::bigint, 0);
  v_franking_cr   := coalesce((v_tni #>> '{income_classes,franked_distribution,franking_credits_cents}')::bigint, 0);
  v_foreign       := coalesce((v_tni #>> '{income_classes,foreign_cents}')::bigint, 0);
  v_ordinary      := coalesce((v_tni #>> '{income_classes,ordinary_cents}')::bigint, 0);
  v_reconciles    := coalesce((v_tni #>> '{income_classes,reconciles}')::boolean, true);
  v_franked_class := v_franked_cash + v_franking_cr;

  -- 4. Deed streaming permission (conservative default false: no row / no deed → no streaming).
  select streaming_allowed into v_streaming_allowed
  from trust_deed where trust_id = v_trust and deleted_at is null;
  v_has_deed          := found;
  v_streaming_allowed := coalesce(v_streaming_allowed, false);

  -- 5. Deduction-fit: scale the streamed pools to the room left after the non-negative
  --    ordinary + foreign, so a deduction-heavy (reconciles=false) trust still fits the
  --    distributable budgets. In a normal year v_factor = 1 (no-op).
  v_room := greatest(0, v_net_income - greatest(0, v_ordinary) - greatest(0, v_foreign));
  if (v_ncg + v_franked_class) > v_room and (v_ncg + v_franked_class) > 0 then
    v_factor := v_room::numeric / (v_ncg + v_franked_class);
  else
    v_factor := 1;
  end if;
  v_ncg_eff       := floor(v_ncg * v_factor)::bigint;
  v_franked_eff   := floor(v_franked_class * v_factor)::bigint;
  v_pool_streamed := v_ncg_eff + v_franked_eff;

  with
  -- Per-beneficiary: the core's fixed total (budget) + entity kind + marginal rate + the
  -- effective post-discount capital-gains rate that orders the CGT stream.
  ben as (
    select
      (c ->> 'beneficiary_id')::uuid                       as beneficiary_id,
      c ->> 'name'                                         as name,
      c ->> 'entity_kind'                                  as entity_kind,
      coalesce((c ->> 'allocation_cents')::bigint, 0)      as budget,
      coalesce((c ->> 'eligible')::boolean, false)         as eligible,
      c ->> 'exclusion_reason'                             as exclusion_reason,
      c ->> 'marginal_basis'                               as marginal_basis,
      coalesce(dd.marginal_rate, 0)                        as marginal_rate,
      -- CGT discount by entity kind (Div 115): individual/trust 50%, complying SMSF 33⅓%,
      -- company/charity none. Trust/partnership are pass-through with budget 0, so their
      -- discount is moot (they never receive a streamed gain). This is the BENEFICIARY-level
      -- mirror of cgt_calc's (0140) ORG-level discount: cgt_calc keys the trust's own discount
      -- on business_profile.entity_type before the gain flows into trust_net_income; this keys
      -- the discount the STREAMED-TO beneficiary would apply, on trust_beneficiaries.beneficiary_type
      -- (a different vocabulary). Immutable per-entity policy constant, used once — kept inline
      -- (documented-intentional, like 0155's resident-scale dup), not a shared helper.
      case c ->> 'entity_kind'
        when 'individual' then 0.5
        when 'trust'      then 0.5
        when 'smsf'       then (1.0 / 3.0)
        else 0
      end                                                  as cgt_discount
    from jsonb_array_elements(coalesce(v_core -> 'allocations', '[]'::jsonb)) as c
    left join lateral (
      select nullif(e ->> 'marginal_rate', '')::numeric as marginal_rate
      from jsonb_array_elements(coalesce(v_di -> 'beneficiaries', '[]'::jsonb)) as e
      where (e ->> 'beneficiary_id')::uuid = (c ->> 'beneficiary_id')::uuid
    ) dd on true
  ),
  benx as (
    select b.*, b.marginal_rate * (1 - b.cgt_discount) as eff_cg_rate
    from ben b
  ),

  -- ── STREAMING MODE (deed streaming_allowed) — two greedy water-fills ──────────
  -- Capital gain: order by effective post-discount rate; each beneficiary capped at budget.
  ma_cg_rank as (
    select beneficiary_id, budget,
      sum(budget) over (order by eff_cg_rate, beneficiary_id
        rows between unbounded preceding and current row) as cum
    from benx
    where v_streaming_allowed and budget > 0
  ),
  ma_cg as (
    select beneficiary_id, budget,
      greatest(0, least(budget, v_ncg_eff - (cum - budget))) as cg_assigned
    from ma_cg_rank
  ),
  -- Franked (grossed): order by marginal rate; fill the budget left after the CGT stream.
  ma_fr_rank as (
    select c.beneficiary_id, (c.budget - c.cg_assigned) as remaining,
      sum(c.budget - c.cg_assigned) over (order by b.marginal_rate, c.beneficiary_id
        rows between unbounded preceding and current row) as cum_rem
    from ma_cg c join benx b using (beneficiary_id)
  ),
  ma as (
    select c.beneficiary_id, c.cg_assigned,
      greatest(0, least(f.remaining, v_franked_eff - (f.cum_rem - f.remaining))) as franked_grossed
    from ma_cg c join ma_fr_rank f using (beneficiary_id)
  ),

  -- ── NO-STREAMING MODE — budget-proportionate via cumulative floor ─────────────
  -- Combined streamed share first (floor of pool_streamed × cum_budget/net_income): exact
  -- column sum AND ≤ budget per beneficiary, so the residual `other` stays non-negative.
  mb_cum as (
    select beneficiary_id, budget,
      sum(budget) over (order by beneficiary_id
        rows between unbounded preceding and current row)                 as cum_b
    from benx
    where (not v_streaming_allowed) and budget > 0
  ),
  mb_streamed as (
    select beneficiary_id,
      floor(v_pool_streamed::numeric * cum_b           / nullif(v_net_income, 0))::bigint as s_cum,
      floor(v_pool_streamed::numeric * (cum_b - budget) / nullif(v_net_income, 0))::bigint as s_cum_prev
    from mb_cum
  ),
  mb_cg as (
    -- Capital gain = cumulative floor over the ncg ratio (basis = the stream prefix), so the
    -- column sums to v_ncg_eff exactly. coalesce 0 for the no-streamable-income case
    -- (v_pool_streamed = 0 makes the divide null).
    select beneficiary_id,
      (s_cum - s_cum_prev) as streamed,
      coalesce(
        floor(v_ncg_eff::numeric * s_cum      / nullif(v_pool_streamed, 0))::bigint
        - floor(v_ncg_eff::numeric * s_cum_prev / nullif(v_pool_streamed, 0))::bigint, 0) as cg_assigned
    from mb_streamed
  ),
  mb as (
    -- Franked grossed = the rest of the combined stream (its column sums to v_franked_eff).
    select beneficiary_id, cg_assigned, (streamed - cg_assigned) as franked_grossed
    from mb_cg
  ),

  -- One assignment set (exactly one mode is non-empty per call).
  streamed_alloc as (
    select beneficiary_id, cg_assigned, franked_grossed from ma
    union all
    select beneficiary_id, cg_assigned, franked_grossed from mb
  ),
  -- Franking credit follows the franked dividend proportionally (credit_i / franked_i ==
  -- trust credit / trust franked class), by cumulative floor so the credits sum exactly.
  fr_credit as (
    select beneficiary_id, cg_assigned, franked_grossed,
      sum(franked_grossed) over (order by beneficiary_id
        rows between unbounded preceding and current row) as cum_fr
    from streamed_alloc
  ),
  credit_alloc as (
    select beneficiary_id, cg_assigned, franked_grossed,
      -- coalesce 0 for the no-franked-income case (v_franked_class = 0 makes the divide null).
      coalesce(
        floor(v_franking_cr::numeric * cum_fr / nullif(v_franked_class, 0))::bigint
        - floor(v_franking_cr::numeric * (cum_fr - franked_grossed) / nullif(v_franked_class, 0))::bigint, 0)
        as franking_credit
    from fr_credit
  ),
  -- Final per-beneficiary components. other = budget − cg − franked_grossed (≥ 0);
  -- amount = budget − credit = cg + franked_cash + other (the trust_distributions CHECK).
  final as (
    select
      b.beneficiary_id, b.name, b.entity_kind, b.budget, b.eligible,
      b.exclusion_reason, b.marginal_basis,
      coalesce(ca.cg_assigned, 0)                                          as capital_gain_cents,
      coalesce(ca.franked_grossed, 0) - coalesce(ca.franking_credit, 0)    as franked_dividend_cents,
      coalesce(ca.franking_credit, 0)                                      as franking_credits_cents,
      b.budget - coalesce(ca.cg_assigned, 0) - coalesce(ca.franked_grossed, 0) as other_cents,
      b.budget - coalesce(ca.franking_credit, 0)                           as amount_cents
    from benx b
    left join credit_alloc ca using (beneficiary_id)
  ),
  tot as (
    select
      coalesce(sum(capital_gain_cents), 0)     as cg_total,
      coalesce(sum(franked_dividend_cents), 0) as franked_cash_total,
      coalesce(sum(franking_credits_cents), 0) as credit_total,
      coalesce(sum(other_cents), 0)            as other_total,
      coalesce(sum(amount_cents), 0)           as amount_total
    from final
  )
  select jsonb_build_object(
    'organization_id', p_org,
    'trust_id',        v_trust,
    'fy_start_year',   p_fy_start_year,
    'period_start',    v_fy_start,
    'period_end',      v_fy_end,
    'method', case when v_streaming_allowed
                   then 'specific_streaming' else 'proportional_no_streaming' end,
    'streaming_allowed', v_streaming_allowed,
    'net_income_cents',  v_net_income,
    -- The income-class split this overlay distributed (deduction-fitted pools).
    'income_classes', jsonb_build_object(
      'ordinary_cents',          greatest(0, v_ordinary),
      'net_capital_gain_cents',  v_ncg,
      'franked_distribution', jsonb_build_object(
        'cash_dividends_cents',   v_franked_cash,
        'franking_credits_cents', v_franking_cr,
        'class_total_cents',      v_franked_class
      ),
      'foreign_cents',           v_foreign,
      'streamable_capital_gain_cents', v_ncg_eff,
      'streamable_franked_class_cents', v_franked_eff,
      -- Deduction-heavy trust: streamed classes scaled to fit the distributable budgets.
      'classes_reduced',         (v_factor < 1),
      -- Passed through from SC-5.B.01: false when the simple class split is not a valid
      -- non-negative partition of net income (current-year loss or negative ordinary).
      'reconciles',              v_reconciles
    ),
    'streamed', coalesce((
      select jsonb_agg(jsonb_build_object(
        'beneficiary_id',         beneficiary_id,
        'name',                   name,
        'entity_kind',            entity_kind,
        'eligible',               eligible,
        'exclusion_reason',       exclusion_reason,
        'marginal_basis',         marginal_basis,
        'amount_cents',           amount_cents,
        'capital_gain_cents',     capital_gain_cents,
        'franked_dividend_cents', franked_dividend_cents,
        'franking_credits_cents', franking_credits_cents,
        'other_cents',            other_cents
      ) order by name) from final), '[]'::jsonb),
    'totals', jsonb_build_object(
      'net_income_cents',              v_net_income,
      'distributed_amount_cents',      t.amount_total,
      'streamed_capital_gain_cents',   t.cg_total,
      'streamed_franked_dividend_cents', t.franked_cash_total,
      'streamed_franking_credits_cents', t.credit_total,
      'other_cents',                   t.other_total,
      -- Trustee-retained residual is unchanged from the core (this overlay never shifts
      -- totals): net income the eligible set could not absorb (s99A).
      'trustee_retained_cents',        v_trustee_retained,
      -- The streamed class shares reconcile to the (deduction-fitted) class pools, and the
      -- distributed corpus + trustee residual + (notional) franking credits == grossed net income.
      'capital_gain_reconciles',       (t.cg_total = v_ncg_eff),
      'franked_class_reconciles',      ((t.franked_cash_total + t.credit_total) = v_franked_eff),
      'grossed_reconciles',
        ((t.amount_total + v_trustee_retained + t.credit_total) = v_net_income)
    ),
    'deed', jsonb_build_object(
      'active_deed',       v_has_deed,
      'streaming_allowed', v_streaming_allowed
    ),
    -- Carry the core's deed-power detail (deny/allow lists) + tax comparison unchanged.
    'optimiser', v_core -> 'totals',
    'caveats', jsonb_build_array(
      'Streaming overlay keeps each beneficiary''s TOTAL allocation fixed at the core optimiser''s figure (SC-5.C.02) and only re-characterises the income class of those dollars. It does not shift more total to a discount-eligible beneficiary than the core already allocated — that joint re-optimisation is out of scope; review the proposal if a larger streamed gain is wanted.',
      'With deed streaming_allowed = true, net capital gain is streamed to the lowest effective post-discount rate (marginal_rate × (1 − CGT discount): individual/trust 50%, SMSF 33⅓%, company/charity 0%) and franked distributions to the lowest marginal rate, each capped by the beneficiary''s allocation; the franking credit follows the franked dividend proportionally. A tax-exempt charity (0%) or low-rate beneficiary will attract the streamed classes — exclude them via the deed if unintended.',
      'With deed streaming_allowed = false (the conservative default when no deed is recorded), every beneficiary takes a budget-proportionate share of each class (the default flow-through; no specific entitlement). The franking credit still follows the franked dividend proportionally.',
      'CGT character flows to the beneficiary; their OWN CGT discount / capital losses are resolved in their return and are not applied here (net_capital_gain_cents is the post-trust-level-discount figure from SC-4.H cgt_calc). The 33⅓% SMSF vs 50% individual ordering reflects the streamed-gain tax, not the beneficiary''s final position.',
      'Deduction-heavy trust (trust_net_income reconciles = false / negative ordinary class): the streamed net-capital-gain and franked pools are scaled proportionally to fit the distributable budgets (classes_reduced = true), a conservative allocation of the excess deduction across the streamed classes; review where the deed dictates a specific deduction order.',
      'Advisory only. amount_cents = capital_gain + franked_dividend + other and all components are non-negative by construction (trust_distributions CHECK); franking_credits_cents rides alongside as the attached offset. Persistence to draft trust_distributions is SC-5.C.04; finalisation is gated by approvals (SC-5.D).'
    ),
    'note', 'Streaming overlay (SC-5.C.03) on the distribution optimiser core (SC-5.C.02): re-characterises each beneficiary''s fixed allocation into streamed net capital gain (Subdiv 115-C), streamed franked distributions + attached franking credits (Subdiv 207-B), and the ordinary/foreign remainder, subject to the deed streaming_allowed flag — minimising total family tax by streaming each class to the beneficiary who bears the least tax on it. Reads the income-class split from trust_net_income (SC-5.B.01). Advisory; SECURITY INVOKER scopes the caller via RLS; no writes.'
  )
  into v_result
  from tot t;

  return v_result;
end;
$$;

comment on function public.stream_trust_distribution(uuid, integer, uuid) is
  'SC-5.C.03: streaming overlay (jsonb) on optimise_trust_distribution (SC-5.C.02). Keeps each '
  'beneficiary''s total allocation fixed and re-characterises it into streamed net capital gain '
  '(Subdiv 115-C, to the lowest effective post-discount rate), streamed franked distributions + '
  'attached franking credits (Subdiv 207-B, to the lowest marginal rate, credit following the '
  'dividend), and the ordinary/foreign remainder — subject to trust_deed.streaming_allowed '
  '(false → budget-proportionate flow-through). Reads the income-class split from trust_net_income '
  '(SC-5.B.01). Components are CHECK-clean for trust_distributions (SC-5.A.03). Advisory only; '
  'SECURITY INVOKER — RLS scopes the caller; no writes. Persistence is SC-5.C.04.';

revoke all on function public.stream_trust_distribution(uuid, integer, uuid) from public, anon;
grant execute on function public.stream_trust_distribution(uuid, integer, uuid) to authenticated;
