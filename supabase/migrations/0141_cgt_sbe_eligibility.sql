-- 0141_cgt_sbe_eligibility.sql — SC-4.F.01 (Phase 4, CGT small-business concessions)
--
-- cgt_sbe_eligible(org, fy_start_year) — the GATE for the Subdiv 152-A "basic
-- conditions" that every small-business CGT concession (15-year exemption, 50%
-- active-asset reduction, retirement exemption, rollover — SC-4.F.02/4.F.03)
-- depends on. This slice computes ONLY the gate (pass/fail with reasons); no
-- concession amounts yet, so it compiles and tests green standalone.
--
-- BASIC CONDITIONS (ITAA 1997 s152-10(1)):
--   (a)+(b) a CGT event happens to a CGT asset and, apart from the concessions,
--           it would have produced a capital GAIN;
--   (c)     the SIZE condition — at least ONE of:
--             * CGT small-business entity: aggregated turnover < $2,000,000, OR
--             * the maximum-net-asset-value (MNAV) test: net value of CGT assets
--               of the entity (and connected entities/affiliates) <= $6,000,000;
--   (d)     the CGT asset satisfies the ACTIVE-ASSET test (s152-35/s152-40).
-- This function reports each of (a)/(b), (c) and (d) as a structured pass/fail
-- with human-readable reasons, and an overall `eligible` = all three hold.
--
-- SIZE CONDITION is an OR: turnover OR MNAV. We surface both sub-tests so the
-- human approver sees which limb carried it.
--   * TURNOVER — sourced (in priority) from the declared aggregated turnover on
--     business_profile (estimated_annual_turnover_cents, else the
--     aggregated_turnover_bracket band, both from 0051), falling back to the FY's
--     book revenue from the GL when nothing is declared. The book proxy is the
--     org's OWN ordinary income and does NOT aggregate connected entities /
--     affiliates (s328-115) — disclosed in caveats.
--   * MNAV — net value of assets = total_assets - total_liabilities from the
--     statutory Balance Sheet (generate_statutory_statements, 0134). That is BOOK
--     net assets (cumulative as-at), not the strict s152-20 figure (market value,
--     aggregation of connected entities, and the dwelling/personal-use-asset
--     exclusions) — disclosed in caveats.
--
-- ACTIVE-ASSET test (gate level): classify each current-FY GAIN event by its
-- cgt_events.asset_type (via cgt_calc's per-event output, SC-4.E):
--     business_asset                       -> active
--     collectable, personal_use            -> not active (s152-40(4) excludes them)
--     share, real_property, crypto, other  -> needs manual review (a share can be
--                                             active under the 80%-lookthrough test;
--                                             real property is active unless its main
--                                             use is to derive rent — neither is
--                                             determinable from asset_type alone)
-- The gate PASSES when at least one gain event is clearly active; assets marked
-- needs_review are surfaced (not silently passed). The s152-35 time test (active
-- for >= half the ownership period / 7.5 years) is NOT computed here — caveated.
--
-- REUSE: leans entirely on existing functions — cgt_calc(org,fy) (0139/0140) for
-- the per-event gains + asset_type, and generate_statutory_statements(org,fy)
-- (0134) for the Balance Sheet — so the gain definition and the BS stay single-
-- sourced. SECURITY INVOKER, STABLE, read-only: every read (business_profile,
-- the GL, and the two callee functions, also INVOKER) is RLS-scoped to the caller.
--
-- MIGRATION NUMBER: the ledger planned 0132, but 0132 is taken
-- (0132_eofy_readiness); reassigned to 0141 per the drift rule — the sequential
-- repo head is 0140_cgt_discount (0178/0179 are late hotfixes). Verified against
-- live (dxoikltymmknxqpkpyhi): generate_statutory_statements / v_trial_balance /
-- business_profile / get_accessible_org_ids are live; cgt_events + cgt_calc are
-- committed but not yet deployed (0138/0139/0140) — staged with this file for the
-- rolled-back live test. business_profile carries both estimated_annual_turnover_cents
-- and the aggregated_turnover_bracket band.

-- Shared helper: money-in-cents -> plain AUD amount string (thousands separators,
-- 2 decimals, no $ sign), e.g. 200000000 -> '2,000,000.00'. Pulled out of the
-- gate's reason strings (used 5×) and reusable by the sibling CGT/return reason
-- builders (SC-4.F.02/4.F.03, SC-4.G). No existing currency formatter in the schema.
create or replace function public.format_aud_cents(p_cents bigint)
  returns text
  language sql
  immutable
  set search_path = public
as $$
  select trim(to_char(p_cents / 100.0, 'FM999,999,999,990.00'));
$$;

comment on function public.format_aud_cents(bigint) is
  'Format a money-in-cents bigint as a plain AUD amount string (thousands '
  'separators, 2 decimals, no $ sign), e.g. 200000000 -> ''2,000,000.00''. Shared '
  'helper for human-readable reason/explanation strings.';

revoke all on function public.format_aud_cents(bigint) from public, anon;
grant execute on function public.format_aud_cents(bigint) to authenticated;

create or replace function public.cgt_sbe_eligible(p_org uuid, p_fy_start_year integer)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  c_turnover_threshold constant bigint := 200000000;   -- $2,000,000 (CGT SBE turnover limit)
  c_mnav_threshold     constant bigint := 600000000;    -- $6,000,000 (maximum net asset value)

  v_fy_start        date := make_date(p_fy_start_year, 7, 1);
  v_fy_end          date := make_date(p_fy_start_year + 1, 6, 30);

  v_entity_type     text;
  v_bracket         text;
  v_turnover_cents  bigint;          -- declared estimate, or book proxy, or null (bracket-only)
  v_turnover_source text;            -- 'declared_estimate' | 'declared_bracket' | 'book_proxy' | 'unknown'
  v_turnover_passed boolean;         -- always resolved: declared estimate / bracket / book proxy all decide
  v_turnover_desc   text;            -- human description used in reasons

  -- MNAV (from the statutory Balance Sheet)
  v_stmt            jsonb;
  v_total_assets    bigint;
  v_total_liab      bigint;
  v_net_assets      bigint;
  v_mnav_passed     boolean;

  v_size_passed     boolean;

  -- CGT events / active-asset test (from cgt_calc)
  v_calc            jsonb;
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
  -- ── Entity + declared turnover ─────────────────────────────────────────────
  select entity_type, aggregated_turnover_bracket, estimated_annual_turnover_cents
    into v_entity_type, v_bracket, v_turnover_cents
  from business_profile
  where organization_id = p_org;

  if v_turnover_cents is not null then
    -- Declared precise estimate wins (it "refines bracket" per 0051).
    v_turnover_source := 'declared_estimate';
    v_turnover_passed := v_turnover_cents < c_turnover_threshold;
  elsif v_bracket = 'under_2m' then
    v_turnover_source := 'declared_bracket';
    v_turnover_passed := true;
  elsif v_bracket in ('under_10m', 'under_50m', 'over_50m') then
    v_turnover_source := 'declared_bracket';
    v_turnover_passed := false;
  else
    -- Nothing declared (null / 'unknown'): fall back to the FY book revenue —
    -- net movement on income accounts (credit-normal) over the FY, posted only.
    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0)
      into v_turnover_cents
    from journal_lines jl
    join journal_entries je   on je.id = jl.journal_entry_id
    join chart_of_accounts coa on coa.id = jl.account_id
    where je.organization_id = p_org
      and je.status = 'posted'
      and je.entry_date between v_fy_start and v_fy_end
      and coa.account_type = 'income';
    v_turnover_source := 'book_proxy';
    v_turnover_passed := v_turnover_cents < c_turnover_threshold;
  end if;

  v_turnover_desc := case
    when v_turnover_source = 'declared_bracket'
      then format('declared turnover bracket %s', coalesce(v_bracket, 'unknown'))
    when v_turnover_source = 'book_proxy'
      then format('$%s (book revenue proxy)', format_aud_cents(v_turnover_cents))
    else format('$%s', format_aud_cents(v_turnover_cents))
  end;

  -- ── MNAV from the statutory Balance Sheet ──────────────────────────────────
  v_stmt         := generate_statutory_statements(p_org, p_fy_start_year);
  v_total_assets := coalesce((v_stmt -> 'balance_sheet' ->> 'total_assets_cents')::bigint, 0);
  v_total_liab   := coalesce((v_stmt -> 'balance_sheet' ->> 'total_liabilities_cents')::bigint, 0);
  v_net_assets   := v_total_assets - v_total_liab;
  v_mnav_passed  := v_net_assets <= c_mnav_threshold;

  v_size_passed := coalesce(v_turnover_passed, false) or v_mnav_passed;

  -- ── CGT events: gains + active-asset classification (single source: cgt_calc) ─
  v_calc   := cgt_calc(p_org, p_fy_start_year);
  v_events := coalesce(v_calc -> 'events', '[]'::jsonb);

  select
    count(*) filter (where (e.v ->> 'gain_cents')::bigint > 0),
    coalesce(sum((e.v ->> 'gain_cents')::bigint) filter (where (e.v ->> 'gain_cents')::bigint > 0), 0),
    count(*) filter (where (e.v ->> 'gain_cents')::bigint > 0
                       and e.v ->> 'asset_type' = 'business_asset'),
    count(*) filter (where (e.v ->> 'gain_cents')::bigint > 0
                       and e.v ->> 'asset_type' in ('collectable', 'personal_use')),
    count(*) filter (where (e.v ->> 'gain_cents')::bigint > 0
                       and coalesce(e.v ->> 'asset_type', 'other')
                           not in ('business_asset', 'collectable', 'personal_use')),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',                e.v -> 'id',
          'asset_description', e.v ->> 'asset_description',
          'asset_type',        e.v ->> 'asset_type',
          'gain_cents',        (e.v ->> 'gain_cents')::bigint,
          'active_status',     case
                                 when e.v ->> 'asset_type' = 'business_asset' then 'active'
                                 when e.v ->> 'asset_type' in ('collectable', 'personal_use') then 'not_active'
                                 else 'needs_review'
                               end
        ) order by e.v ->> 'disposal_date', e.v ->> 'id'
      ) filter (where (e.v ->> 'gain_cents')::bigint > 0),
      '[]'::jsonb
    )
  into v_gain_count, v_gross_gain, v_active_count, v_notactive_count, v_review_count, v_active_assets
  from jsonb_array_elements(v_events) as e(v);

  v_gain_present  := v_gain_count > 0;
  v_active_passed := v_active_count > 0;

  v_eligible := v_gain_present and v_size_passed and v_active_passed;

  -- ── Human-readable reasons ─────────────────────────────────────────────────
  v_cgt_event_reason := case
    when v_gain_present then
      format('%s CGT event(s) with a capital gain in this FY (gross gain $%s).',
             v_gain_count, format_aud_cents(v_gross_gain))
    else
      'No CGT event resulting in a capital gain in this FY — the small-business concessions do not apply.'
  end;

  v_size_reason := case
    when v_size_passed and coalesce(v_turnover_passed, false) then
      format('Size condition met: aggregated turnover %s is under the $2,000,000 CGT small-business-entity threshold.',
             v_turnover_desc)
    when v_size_passed then
      format('Size condition met: maximum net asset value $%s is within the $6,000,000 limit.',
             format_aud_cents(v_net_assets))
    else
      format('Size condition NOT met: turnover %s is not under $2,000,000 and net assets $%s exceed the $6,000,000 limit.',
             v_turnover_desc, format_aud_cents(v_net_assets))
  end;

  v_active_reason := case
    when v_active_passed then
      format('Active-asset test met: %s active asset(s) disposed.', v_active_count)
        || case when v_review_count > 0
                then format(' (%s asset(s) need manual active-asset review.)', v_review_count)
                else '' end
    when not v_gain_present then
      'Active-asset test not applicable: no CGT gain events this FY.'
    when v_review_count > 0 then
      format('Active-asset test needs review: %s disposed asset(s) require manual active-asset assessment; none are clearly active.',
             v_review_count)
    else
      'Active-asset test NOT met: the disposed asset(s) are not active assets (collectables / personal-use).'
  end;

  v_reasons := jsonb_build_array(
    v_cgt_event_reason,
    v_size_reason,
    v_active_reason,
    format('Overall: this org %s the small-business CGT concession basic conditions for FY%s–%s.',
           case when v_eligible then 'MEETS' else 'does NOT meet' end,
           p_fy_start_year, p_fy_start_year + 1)
  );

  return jsonb_build_object(
    'organization_id', p_org,
    'fy_start_year',   p_fy_start_year,
    'period_start',    v_fy_start,
    'period_end',      v_fy_end,
    'entity_type',     v_entity_type,
    'eligible',        v_eligible,
    'turnover_test', jsonb_build_object(
      'passed',                   v_turnover_passed,
      'threshold_cents',          c_turnover_threshold,
      'aggregated_turnover_cents', v_turnover_cents,
      'turnover_bracket',         v_bracket,
      'source',                   v_turnover_source,
      'reason',                   v_turnover_desc
    ),
    'mnav_test', jsonb_build_object(
      'passed',                  v_mnav_passed,
      'threshold_cents',         c_mnav_threshold,
      'net_asset_value_cents',   v_net_assets,
      'total_assets_cents',      v_total_assets,
      'total_liabilities_cents', v_total_liab,
      'basis',                   'book_net_assets_unaggregated'
    ),
    'size_condition', jsonb_build_object(
      'passed', v_size_passed,
      'reason', v_size_reason
    ),
    'cgt_event_with_gain', jsonb_build_object(
      'passed',                v_gain_present,
      'gain_event_count',      v_gain_count,
      'total_gross_gain_cents', v_gross_gain,
      'reason',                v_cgt_event_reason
    ),
    'active_asset_test', jsonb_build_object(
      'passed',                   v_active_passed,
      'active_event_count',       v_active_count,
      'needs_review_count',       v_review_count,
      'not_active_event_count',   v_notactive_count,
      'reason',                   v_active_reason
    ),
    'active_assets', v_active_assets,
    'reasons',       v_reasons,
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
  'SC-4.F.01: small-business CGT concession GATE (Subdiv 152-A basic conditions) '
  'for an org + AU FY, as jsonb pass/fail-with-reasons. Tests: a CGT event with a '
  'gain (via cgt_calc), the SIZE condition (turnover < $2m from business_profile or '
  'book revenue, OR MNAV <= $6m from generate_statutory_statements), and the '
  'active-asset test (by cgt_events.asset_type). No concession amounts — those are '
  'SC-4.F.02/4.F.03. SECURITY INVOKER — RLS scopes the caller. See caveats[] for the '
  'aggregation / market-value / s152-35-time-test limitations.';

revoke all on function public.cgt_sbe_eligible(uuid, integer) from public, anon;
grant execute on function public.cgt_sbe_eligible(uuid, integer) to authenticated;
