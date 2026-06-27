-- 0156_distribution_optimiser.sql — SC-5.C.02 (Phase 5, Trusts — distribution optimiser core)
--
-- optimise_trust_distribution(org, fy[, trust]) — the MILESTONE CORE of the distribution
-- engine. It allocates a trust's s95 net income (SC-5.B.01) across the trust's eligible
-- beneficiaries to MINIMISE TOTAL FAMILY INCOME TAX, subject to the deed's distribution
-- powers (SC-5.A.02), and returns a proposed allocation. ADVISORY ONLY — no writes; the
-- persist-to-draft step is SC-5.C.04 and finalisation is gated by approvals (SC-5.D.02).
--
-- ── NO STREAMING (this slice) ──────────────────────────────────────────────────
-- The whole s95 net income is treated as ONE ordinary pool. Net capital gains, franked
-- distributions and their franking credits are NOT separately streamed here — that is the
-- SC-5.C.03 overlay, kept a separate slice so this core stays green and independently
-- assertable. Treating the pool as ordinary is the conservative baseline: streaming can
-- only reduce tax further (CGT discount, franking offsets), never increase it.
--
-- ── ALGORITHM: greedy bracket-fill (water-filling) ─────────────────────────────
-- To minimise total family tax you allocate each dollar to the eligible beneficiary with
-- the LOWEST marginal rate on their next dollar — i.e. fill the cheapest tax brackets
-- across all beneficiaries first. Implemented set-based, not dollar-by-dollar:
--
--   1. For every eligible, allocatable beneficiary build ordered fill SEGMENTS
--      (rate, capacity_cents):
--        * loss shelter   — rate 0, capacity = prior_year_losses_cents (income up to the
--          beneficiary's carry-forward losses bears no tax). Applies to every kind.
--        * individual     — the resident marginal brackets (0156's resident_marginal_rates)
--          ABOVE the beneficiary's existing other assessable income: bracket [lo, hi) gives
--          capacity = hi − max(lo, other_income); the open top bracket absorbs the pool.
--        * company/SMSF/charity — one flat segment (30% / 15% / 0%) of pool capacity.
--        * penalised minor — the Div 6AA bands (div6aa_minor_rates): $0–$416 nil, then 66%,
--          then 45%. The 66% band is the highest rate in the whole system, so the greedy
--          naturally caps a penalised minor near the $416 nil band.
--   2. Order ALL segments by rate ascending and water-fill: each segment's allocation =
--      clamp(capacity, 0, pool − cumulative_capacity_before_it). A window prefix-sum does
--      this in one pass. Any pool that no eligible beneficiary can absorb is reported as
--      trustee_retained_cents (assessed to the trustee under s99A at the top rate).
--
-- Greedy-by-marginal-rate is the global tax MINIMUM for the convex, piecewise-linear case
-- (each beneficiary's tax is non-decreasing and convex in their allocation), so the result
-- is provably ≤ any other allocation of the same pool over the same eligible set — including
-- the equal-split baseline the output reports for comparison. The one non-convexity is the
-- Div 6AA "$1,308+ taxes the WHOLE amount at 45%" jump, approximated here as a marginal 45%
-- band; in practice a penalised minor is filled only to ~$416 so the approximation almost
-- never bites. Documented in caveats — hence "bracket-fill heuristic", not "MILP".
--
-- ── DEED POWERS (SC-5.A.02 trust_deed.parsed_terms) ────────────────────────────
-- A beneficiary is eligible UNLESS the active deed's parsed_terms excludes them. Convention:
--   parsed_terms.excluded_beneficiary_ids : jsonb array of beneficiary UUIDs → receive 0.
--   parsed_terms.eligible_beneficiary_ids : OPTIONAL jsonb array → an allow-list; if present
--                                           and non-empty, ONLY those beneficiaries may
--                                           receive (a deed naming a closed class).
-- Pass-through beneficiaries (trust/partnership/other — distribution_inputs marginal_rate
-- null) are not allocated by the core optimiser: distributing to them just pushes the tax
-- question down a level the optimiser cannot see through, so they receive 0 and are surfaced
-- with exclusion_reason 'pass_through_entity'.
--
-- ── REUSE ──────────────────────────────────────────────────────────────────────
-- Pool        ← trust_net_income(org, fy).net_income_cents (SC-5.B.01, = book_to_tax taxable).
-- Per-benef   ← distribution_inputs(org, trust, fy).beneficiaries (SC-5.C.01 — entity kind,
--               other income, losses, Div 6AA penalty flag, marginal basis).
-- Brackets    ← resident_marginal_rates / div6aa_minor_rates (the 0155 reference tables) read
--               directly for the bracket boundaries (the fill needs band edges, not just a rate);
--               the resident_tax_on_amount helper (below) centralises the scale tax lookup, and
--               the company/SMSF/charity flat rates are consumed from distribution_inputs, not
--               re-hardcoded.
-- SECURITY INVOKER + STABLE — every read (trust_net_income, distribution_inputs, the trust/
-- deed tables) is RLS-scoped to the caller, so a foreign org degrades to an empty proposal
-- rather than leaking. No writes; the proposal is cheap to recompute and independently checkable.
--
-- MIGRATION NUMBER: the ledger Files line planned 0147, long taken (Phase 4 consumed 0142–0150;
-- the trust chain 0151–0155). Reassigned to 0156 per the drift rule — the sequential repo head
-- is 0155_distribution_inputs (0178/0179 are late hotfixes that sort after). Verified live
-- (dxoikltymmknxqpkpyhi, read-only): optimise_trust_distribution ABSENT and the whole 0151–0155
-- trust chain (trusts, trust_beneficiaries, trust_deed, trust_net_income, distribution_inputs,
-- resident_marginal_rates, div6aa_minor_rates) committed-but-NOT-deployed (deploys together) —
-- no drift; live migration head 20260626131805 is a late hotfix.

-- ── Resident-scale income tax on a given taxable income (FY-effective) ──────────
-- A single home for the resident bracket lookup — base_tax + rate × (income − bracket
-- floor) over resident_marginal_rates (0155). The optimiser calls it twice per scale
-- beneficiary as tax(other + allocation) − tax(other); 0150's inline copy of the scale
-- can later point here too (the duplication 0155's header flagged). Whole cents (round);
-- reads the global select-true rate table — SECURITY INVOKER, no writes.
create or replace function public.resident_tax_on_amount(
    p_income_cents bigint, p_fy_start_year integer)
  returns bigint
  language sql
  stable
  security invoker
  set search_path = public
as $$
  select coalesce(round(rr.base_tax_cents + rr.rate * (greatest(p_income_cents, 0) - rr.lower_cents)), 0)::bigint
    from resident_marginal_rates rr
   where rr.effective_from <= make_date(p_fy_start_year + 1, 6, 30)
     and (rr.effective_to is null or make_date(p_fy_start_year + 1, 6, 30) < rr.effective_to)
     and rr.lower_cents <= greatest(p_income_cents, 0)
   order by rr.lower_cents desc
   limit 1;
$$;

comment on function public.resident_tax_on_amount(bigint, integer) is
  'SC-5.C.02 helper: resident individual income tax (whole cents) on a taxable income for an '
  'AU FY, from the resident_marginal_rates scale (0155). base_tax + rate × (income − floor). '
  'Used by optimise_trust_distribution for marginal tax(other+alloc) − tax(other); the '
  'canonical home 0150 compute_tax_payable''s inline scale can later point at. STABLE, no writes.';

revoke all on function public.resident_tax_on_amount(bigint, integer) from public, anon;
grant execute on function public.resident_tax_on_amount(bigint, integer) to authenticated;

create or replace function public.optimise_trust_distribution(
    p_org uuid, p_fy_start_year integer, p_trust uuid default null)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fy_start     date    := make_date(p_fy_start_year, 7, 1);
  v_fy_end       date    := make_date(p_fy_start_year + 1, 6, 30);  -- effective-date probe
  v_trust        uuid    := p_trust;
  v_trust_count  integer;
  v_pool         bigint;
  v_di           jsonb;
  v_deed         jsonb;                  -- active deed parsed_terms (or '{}')
  v_has_deed     boolean;
  v_excluded     uuid[]  := '{}'::uuid[];  -- deed deny-list
  v_eligible_ids uuid[];                   -- deed allow-list (null = absent → all eligible)
  v_has_allow    boolean;
  v_result       jsonb;
begin
  -- 1. Resolve the trust. Explicit p_trust wins (validated to the org); otherwise the org's
  --    single active trust. The s95 pool is an org-GL figure (one set of books = one trust),
  --    so a >1-trust org is genuinely ambiguous — refuse rather than guess.
  if v_trust is not null then
    perform 1 from trusts
      where id = v_trust and organization_id = p_org and deleted_at is null;
    if not found then
      raise exception 'optimise_trust_distribution: trust % is not an active trust of org %',
        v_trust, p_org;
    end if;
  else
    select count(*) into v_trust_count
    from trusts where organization_id = p_org and deleted_at is null;
    if v_trust_count = 0 then
      raise exception 'optimise_trust_distribution: org % has no active trust', p_org;
    elsif v_trust_count > 1 then
      raise exception
        'optimise_trust_distribution: org % has % active trusts; pass p_trust to disambiguate',
        p_org, v_trust_count;
    end if;
    select id into v_trust
    from trusts where organization_id = p_org and deleted_at is null;
  end if;

  -- 2. The pool to allocate = the trust's s95 net income (nil in a loss year).
  v_pool := coalesce((trust_net_income(p_org, p_fy_start_year) ->> 'net_income_cents')::bigint, 0);

  -- 3. Per-beneficiary tax inputs (reuse SC-5.C.01).
  v_di := distribution_inputs(p_org, v_trust, p_fy_start_year);

  -- 4. Active deed powers: deny-list + optional allow-list from parsed_terms.
  select parsed_terms into v_deed
  from trust_deed where trust_id = v_trust and deleted_at is null;
  v_has_deed := found;
  v_deed     := coalesce(v_deed, '{}'::jsonb);

  if jsonb_typeof(v_deed -> 'excluded_beneficiary_ids') = 'array' then
    select coalesce(array_agg(value::uuid), '{}'::uuid[]) into v_excluded
    from jsonb_array_elements_text(v_deed -> 'excluded_beneficiary_ids');
  end if;

  -- coalesce to false: with no deed / no key, jsonb_typeof(null) = 'array' is NULL, and an
  -- unguarded NULL here would poison deed_ok → allocatable via three-valued logic (every
  -- beneficiary would read as not-allocatable and nothing would be distributed).
  v_has_allow := coalesce(
                   jsonb_typeof(v_deed -> 'eligible_beneficiary_ids') = 'array'
                   and jsonb_array_length(v_deed -> 'eligible_beneficiary_ids') > 0,
                 false);
  if v_has_allow then
    select array_agg(value::uuid) into v_eligible_ids
    from jsonb_array_elements_text(v_deed -> 'eligible_beneficiary_ids');
  end if;

  -- 5. The allocation + tax comparison, fully set-based.
  with
  -- Per-beneficiary facts from distribution_inputs + deed eligibility + segment kind.
  ben as (
    select
      (e ->> 'beneficiary_id')::uuid                                as beneficiary_id,
      e ->> 'name'                                                  as name,
      e ->> 'entity_kind'                                           as entity_kind,
      coalesce((e ->> 'other_assessable_income_cents')::bigint, 0)  as other_income,
      coalesce((e ->> 'prior_year_losses_cents')::bigint, 0)        as losses,
      coalesce((e ->> 'div6aa_penalty_applies')::boolean, false)    as penalty,
      e ->> 'marginal_basis'                                        as marginal_basis,
      -- The per-beneficiary marginal rate distribution_inputs already derived (SC-5.C.01):
      -- for flat entities it IS the flat rate (company 0.30 / SMSF 0.15 / charity 0.00), so
      -- the optimiser consumes it rather than re-hardcoding the same constants.
      nullif(e ->> 'marginal_rate', '')::numeric                    as di_rate
    from jsonb_array_elements(coalesce(v_di -> 'beneficiaries', '[]'::jsonb)) as e
  ),
  ben2 as (
    select b.*,
      -- How this beneficiary's tax scales with their allocation.
      case
        when b.penalty                     then 'minor_penalty'
        when b.entity_kind = 'individual'  then 'scale'
        when b.entity_kind in ('company', 'smsf', 'charity') then 'flat'
        else 'pass_through'    -- trust/partnership/other: marginal_rate unknown → not allocated
      end as rate_kind,
      -- Flat-rate kinds reuse the rate distribution_inputs already derived (company 0.30 /
      -- SMSF 0.15 / charity 0.00) — single source of truth with SC-5.C.01.
      case when b.entity_kind in ('company', 'smsf', 'charity') then b.di_rate end as flat_rate,
      -- Deed powers: not on the deny-list AND (no allow-list OR on it).
      (b.beneficiary_id <> all (v_excluded)
       and (not v_has_allow or b.beneficiary_id = any (v_eligible_ids))) as deed_ok
    from ben b
  ),
  ben3 as (
    select *,
      (deed_ok and rate_kind <> 'pass_through') as allocatable,
      case
        when not deed_ok                then 'deed_excluded'
        when rate_kind = 'pass_through' then 'pass_through_entity'
        else null
      end as exclusion_reason
    from ben2
  ),
  -- Fill segments (rate, capacity) per allocatable beneficiary.
  segs as (
    -- loss shelter (rate 0) — every allocatable kind
    select beneficiary_id, 0::numeric as rate, losses as capacity, 0 as seg_order
    from ben3 where allocatable and losses > 0
    union all
    -- resident scale brackets above the beneficiary's existing other income
    select b.beneficiary_id, r.rate,
      case when r.upper_cents is null then v_pool
           else greatest(0, r.upper_cents - greatest(r.lower_cents, b.other_income)) end,
      1
    from ben3 b
    join resident_marginal_rates r
      on r.effective_from <= v_fy_end and (r.effective_to is null or v_fy_end < r.effective_to)
    where b.allocatable and b.rate_kind = 'scale'
      and (r.upper_cents is null or r.upper_cents > b.other_income)
    union all
    -- flat entities (company / SMSF / charity): one pool-wide segment
    select beneficiary_id, flat_rate, v_pool, 1
    from ben3 where allocatable and rate_kind = 'flat'
    union all
    -- penalised minor: Div 6AA bands
    select b.beneficiary_id, d.rate,
      case when d.upper_cents is null then v_pool
           else greatest(0, d.upper_cents - d.lower_cents) end,
      1
    from ben3 b
    join div6aa_minor_rates d
      on d.effective_from <= v_fy_end and (d.effective_to is null or v_fy_end < d.effective_to)
    where b.allocatable and b.rate_kind = 'minor_penalty'
  ),
  -- Water-fill: order by rate, give each segment the pool left after all cheaper segments.
  ranked as (
    select s.*,
      sum(s.capacity) over (
        order by s.rate, s.beneficiary_id, s.seg_order
        rows between unbounded preceding and current row) as cum_incl
    from segs s
  ),
  filled as (
    select beneficiary_id,
      greatest(0, least(capacity, v_pool - (cum_incl - capacity))) as alloc
    from ranked
  ),
  alloc_by_ben as (
    select beneficiary_id, sum(alloc)::bigint as allocation_cents
    from filled group by beneficiary_id
  ),
  -- Equal-split baseline over the SAME eligible set (exact-sum: spread the cents remainder).
  elig_count as (select count(*)::bigint as n from ben3 where allocatable),
  equal as (
    select b.beneficiary_id,
      (v_pool / ec.n)
        + case when row_number() over (order by b.beneficiary_id) <= (v_pool % ec.n)
               then 1 else 0 end as allocation_cents
    from ben3 b cross join elig_count ec
    where b.allocatable and ec.n > 0
  ),
  -- Incremental tax on the distribution (tax(other+alloc) − tax(other)) for both scenarios.
  scen as (
    select beneficiary_id, 'optimised'::text as scenario, allocation_cents from alloc_by_ben
    union all
    select beneficiary_id, 'equal',             allocation_cents from equal
  ),
  taxed as (
    select s.scenario, s.beneficiary_id, s.allocation_cents,
      greatest(0, s.allocation_cents - b.losses) as taxable_cents,
      case b.rate_kind
        when 'scale' then
          -- Marginal tax on the distribution: tax(other + allocation) − tax(other).
          resident_tax_on_amount(b.other_income + greatest(0, s.allocation_cents - b.losses), p_fy_start_year)
          - resident_tax_on_amount(b.other_income, p_fy_start_year)
        when 'flat' then b.flat_rate * greatest(0, s.allocation_cents - b.losses)
        when 'minor_penalty' then
          (select case when dd.applies_to_whole
                       then dd.rate * greatest(0, s.allocation_cents - b.losses)
                       else dd.rate * (greatest(0, s.allocation_cents - b.losses) - dd.lower_cents) end
             from div6aa_minor_rates dd
            where dd.effective_from <= v_fy_end and (dd.effective_to is null or v_fy_end < dd.effective_to)
              and dd.lower_cents <= greatest(0, s.allocation_cents - b.losses)
            order by dd.lower_cents desc limit 1)
        else 0
      end as incr_tax
    from scen s join ben3 b using (beneficiary_id)
  ),
  tax_tot as (
    select scenario, round(sum(incr_tax))::bigint as tax_cents
    from taxed group by scenario
  ),
  -- Per-beneficiary optimised detail for the output array.
  detail as (
    select b.beneficiary_id, b.name, b.entity_kind, b.allocatable, b.exclusion_reason,
      b.marginal_basis,
      coalesce(a.allocation_cents, 0)         as allocation_cents,
      coalesce(t.taxable_cents, 0)            as taxable_cents,
      coalesce(round(t.incr_tax)::bigint, 0)  as incremental_tax_cents
    from ben3 b
    left join alloc_by_ben a using (beneficiary_id)
    left join taxed t on t.beneficiary_id = b.beneficiary_id and t.scenario = 'optimised'
  ),
  agg as (
    select
      coalesce((select sum(allocation_cents)::bigint from alloc_by_ben), 0) as allocated,
      coalesce((select tax_cents from tax_tot where scenario = 'optimised'), 0) as opt_tax,
      coalesce((select tax_cents from tax_tot where scenario = 'equal'), 0)     as eq_tax
  )
  select jsonb_build_object(
    'organization_id', p_org,
    'trust_id',        v_trust,
    'fy_start_year',   p_fy_start_year,
    'period_start',    v_fy_start,
    'period_end',      v_fy_end,
    'method',          'bracket_fill_greedy_no_streaming',
    'net_income_cents', v_pool,
    'allocations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'beneficiary_id',        beneficiary_id,
        'name',                  name,
        'entity_kind',           entity_kind,
        'eligible',              allocatable,
        'exclusion_reason',      exclusion_reason,
        'marginal_basis',        marginal_basis,
        'allocation_cents',      allocation_cents,
        'taxable_cents',         taxable_cents,
        'incremental_tax_cents', incremental_tax_cents
      ) order by name) from detail), '[]'::jsonb),
    'totals', jsonb_build_object(
      'net_income_cents',        v_pool,
      'allocated_cents',         a.allocated,
      -- Pool no eligible beneficiary could absorb → assessed to the trustee (s99A, top rate).
      'trustee_retained_cents',  v_pool - a.allocated,
      'fully_distributed',       (v_pool - a.allocated = 0),
      'optimised_tax_cents',     a.opt_tax,
      'equal_split_tax_cents',   a.eq_tax,
      'tax_saving_cents',        a.eq_tax - a.opt_tax,
      -- The greedy fill is provably no worse than equal split over the same eligible set.
      'beats_equal_split',       (a.opt_tax <= a.eq_tax)
    ),
    'deed', jsonb_build_object(
      'active_deed',              v_has_deed,
      'excluded_beneficiary_ids', coalesce(v_deed -> 'excluded_beneficiary_ids', '[]'::jsonb),
      'eligible_beneficiary_ids',
        case when v_has_allow then v_deed -> 'eligible_beneficiary_ids' else null end
    ),
    'caveats', jsonb_build_array(
      'No streaming: the entire s95 net income is treated as one ordinary pool. Net capital gains, franked distributions and their franking credits are not separately streamed (SC-5.C.03 overlay), so CGT-discount and franking-offset benefits are not reflected — this is the conservative baseline (streaming can only reduce tax further).',
      'Greedy bracket-fill: each dollar is allocated to the eligible beneficiary with the lowest marginal rate (resident scale / Div 6AA / company 30% / SMSF 15% / charity 0%), filling cheap brackets first. This is the tax minimum for the convex piecewise-linear case; the Div 6AA "$1,308+ taxes the whole amount at 45%" jump is approximated as a marginal 45% band, so a penalised minor''s allocation above ~$416 is a heuristic edge.',
      'Deed powers: a beneficiary is eligible unless listed in parsed_terms.excluded_beneficiary_ids; if parsed_terms.eligible_beneficiary_ids is present and non-empty it is an allow-list (only those may receive). Pass-through beneficiaries (trust/partnership/other, marginal_rate null) are not allocated by the core optimiser and receive 0 (exclusion_reason pass_through_entity).',
      'Tax-exempt charity (0%) and SMSF (15%) beneficiaries minimise tax trivially; exclude them via the deed terms if the family does not intend to distribute there. The optimiser minimises tax over the eligible set AS GIVEN and the proposal must be reviewed.',
      'other_assessable_income / prior_year_losses are the curated distribution_inputs facts (a beneficiary with no profile defaults to 0/0/resident). incremental_tax_cents is the tax on the distribution only — tax(other_income + allocation) − tax(other_income); the beneficiary''s tax on their other income is constant across proposals and excluded.',
      'Pool that no eligible beneficiary can absorb is reported as trustee_retained_cents (assessed to the trustee under ITAA-1936 s99A at the top rate); fully_distributed=false flags it. Allocations + trustee_retained always equal net_income_cents by construction.'
    ),
    'note', 'Greedy bracket-fill allocation of a trust''s s95 net income (SC-5.B.01) across eligible beneficiaries to minimise total family income tax, subject to deed powers (SC-5.A.02). No streaming — the whole pool is treated as ordinary income; the capital-gain/franked-dividend streaming overlay is SC-5.C.03 and persistence to draft is SC-5.C.04. Advisory only; SECURITY INVOKER scopes the caller via RLS; no writes.'
  )
  into v_result
  from agg a;

  return v_result;
end;
$$;

comment on function public.optimise_trust_distribution(uuid, integer, uuid) is
  'SC-5.C.02: greedy bracket-fill optimiser (jsonb) that allocates a trust''s s95 net income '
  '(trust_net_income, SC-5.B.01) across eligible beneficiaries (distribution_inputs, SC-5.C.01) '
  'to minimise total family income tax, subject to deed powers (trust_deed.parsed_terms — '
  'excluded_beneficiary_ids deny-list / eligible_beneficiary_ids allow-list). No streaming '
  '(SC-5.C.03 overlay): the pool is treated as ordinary income. Reports the optimised vs '
  'equal-split tax and any trustee-retained residual. p_trust defaults to the org''s single '
  'active trust. Advisory only; SECURITY INVOKER — RLS scopes the caller; no writes.';

revoke all on function public.optimise_trust_distribution(uuid, integer, uuid) from public, anon;
grant execute on function public.optimise_trust_distribution(uuid, integer, uuid) to authenticated;
