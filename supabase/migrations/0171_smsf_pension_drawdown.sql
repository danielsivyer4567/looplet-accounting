-- 0171_smsf_pension_drawdown.sql — SC-5.L.02 (Phase 5, SMSF — minimum pension drawdown)
--
-- Two things:
--   1. smsf_min_drawdown_rates — the ATO standard minimum-pension age-band drawdown rates as
--      GLOBAL reference data (the 0155/0160 pattern: RLS select-true, writes revoked). Seeded
--      with the standard (non-COVID-relief) percentages by age band.
--   2. smsf_pension_drawdown(org, fy[, fund]) — per pension, computes the REQUIRED minimum annual
--      drawdown (the member's age-band % × the pension's commencement value) and flags a pension
--      whose recorded drawdown rate (smsf_pensions.min_drawdown_percent) is BELOW the required
--      band. Read-only flagging; feeds the SMSF UI dashboard.
--
-- ── MINIMUM DRAWDOWN (SIS reg 1.06, schedule 7) ────────────────────────────────
-- An account-based pension (and a retirement-phase TRIS) must pay at least a minimum each year,
-- a percentage of the 1-July account balance that increases with the member's age:
--   under 65: 4%, 65-74: 5%, 75-79: 6%, 80-84: 7%, 85-89: 9%, 90-94: 11%, 95+: 14%.
-- The age is the member's age at the start of the income year (1 July). Required minimum =
-- band % × the account balance (we use commencement_value_cents as the balance proxy — the
-- 1-July balance is the precise base; a later refinement reads the rolled-forward balance from
-- SC-5.I.01).
--
-- ── UNDER-DRAWN FLAG (what we can assert without actual-payment tracking) ───────
-- Actual pension payments are NOT tracked in the schema yet, so we cannot compare actual vs
-- required directly. What we CAN flag: a pension whose RECORDED min_drawdown_percent (set on the
-- smsf_pensions row, 0163) is BELOW the age-band required minimum — i.e. the pension is set up to
-- under-draw. `under_minimum` flags that. Once actual payments are tracked, the monitor compares
-- actual cents vs required cents; documented in caveats. TRIS in accumulation phase has a 4% min
-- and a 10% MAXIMUM (the max is not modelled here).
--
-- SECURITY INVOKER + STABLE — reads (smsf_pensions/members + the world-readable rate table)
-- RLS-scoped to the caller; foreign org/fund yields empty. No writes. revoke public/anon + grant
-- authenticated (the trust-chain RPC posture, 0154-0164-0170).
--
-- MIGRATION NUMBER: the ledger Files line planned 0163, long taken. Reassigned to 0171 per the
-- drift rule — the sequential repo head is 0170_smsf_caps (0178/0179 are late hotfixes that sort
-- after). Verified live (read-only): smsf_pension_drawdown + smsf_min_drawdown_rates ABSENT (no
-- drift); the SMSF 0162-0170 chain is repo-only (deploys together).

-- ── 1. ATO minimum-pension age-band drawdown rates (global reference) ───────────
create table public.smsf_min_drawdown_rates (
  id           uuid primary key default gen_random_uuid(),
  -- Inclusive age band [age_from, age_to]; age_to null = open-ended (95+).
  age_from     int  not null check (age_from >= 0),
  age_to       int  check (age_to is null or age_to >= age_from),
  -- Standard minimum drawdown rate as a percentage (e.g. 4.00, 5.00 ... 14.00).
  rate_percent numeric(5, 2) not null check (rate_percent >= 0 and rate_percent <= 100),
  notes        text,
  unique (age_from)
);

comment on table public.smsf_min_drawdown_rates is
  'ATO standard minimum-pension drawdown rates by age band (SC-5.L.02), as global reference '
  'data (RLS select-true, writes revoked — the 0155 pattern). SIS reg 1.06 schedule 7. Read by '
  'smsf_pension_drawdown.';

insert into public.smsf_min_drawdown_rates (age_from, age_to, rate_percent, notes) values
  (0,  64,   4.00, 'Under 65: 4%'),
  (65, 74,   5.00, '65-74: 5%'),
  (75, 79,   6.00, '75-79: 6%'),
  (80, 84,   7.00, '80-84: 7%'),
  (85, 89,   9.00, '85-89: 9%'),
  (90, 94,  11.00, '90-94: 11%'),
  (95, null, 14.00, '95 and over: 14%')
on conflict (age_from) do update set
  age_to = excluded.age_to, rate_percent = excluded.rate_percent, notes = excluded.notes;

alter table public.smsf_min_drawdown_rates enable row level security;
create policy smsf_min_drawdown_rates_select on public.smsf_min_drawdown_rates
  for select using (true);
revoke insert, update, delete on public.smsf_min_drawdown_rates from authenticated, anon;
grant select on public.smsf_min_drawdown_rates to authenticated, anon;

-- ── 2. Minimum-drawdown monitor ────────────────────────────────────────────────
create or replace function public.smsf_pension_drawdown(
    p_org uuid, p_fy_start_year integer, p_fund uuid default null)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fund   uuid;
  v_result jsonb;
begin
  -- Resolve the fund (explicit, else the org's single fund, else RAISE on >1).
  if p_fund is not null then
    v_fund := p_fund;
  else
    select id into v_fund from smsf_funds
      where organization_id = p_org and deleted_at is null;
    if not found then
      return jsonb_build_object('ok', false, 'organization_id', p_org,
        'error', 'no SMSF fund for this org', 'pensions', '[]'::jsonb);
    end if;
    if (select count(*) from smsf_funds where organization_id = p_org and deleted_at is null) > 1 then
      raise exception 'org % has multiple SMSF funds; pass p_fund', p_org;
    end if;
  end if;

  with
  -- Each pension + the member's age at 1 July (start of the income year) + the required
  -- age-band rate. Age null (no DOB) -> the conservative 4% floor band (age_from 0).
  pen as (
    select
      p.id, p.pension_type, p.commencement_value_cents,
      p.min_drawdown_percent                                          as recorded_rate,
      mb.name                                                         as member_name,
      case when mb.date_of_birth is null then null
           else extract(year from age(make_date(p_fy_start_year, 7, 1), mb.date_of_birth))::int
      end                                                            as age_at_1_july,
      -- The age used for the band lookup: null DOB -> 0 -> the conservative under-65 (4%) band.
      coalesce(case when mb.date_of_birth is null then null
           else extract(year from age(make_date(p_fy_start_year, 7, 1), mb.date_of_birth))::int
      end, 0)                                                         as band_age
    from smsf_pensions p
    join smsf_members mb on mb.id = p.member_id
    where mb.fund_id = v_fund and mb.organization_id = p_org
      and p.deleted_at is null and mb.deleted_at is null
  ),
  rated as (
    select pen.*,
      coalesce((
        select r.rate_percent from smsf_min_drawdown_rates r
        where pen.band_age >= r.age_from
          and (r.age_to is null or pen.band_age <= r.age_to)
        limit 1), 4.00) as required_rate
    from pen
  ),
  computed as (
    select *,
      floor(commencement_value_cents * required_rate / 100.0)::bigint as required_minimum_cents,
      (recorded_rate < required_rate)                                  as under_minimum
    from rated
  )
  select jsonb_build_object(
    'ok',              true,
    'organization_id', p_org,
    'fund_id',         v_fund,
    'fy_start_year',   p_fy_start_year,
    'pensions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'pension_id',              id,
        'member_name',             member_name,
        'pension_type',            pension_type,
        'age_at_1_july',           age_at_1_july,
        'commencement_value_cents', commencement_value_cents,
        'required_rate_percent',   required_rate,
        'recorded_rate_percent',   recorded_rate,
        'required_minimum_cents',  required_minimum_cents,
        'under_minimum',           under_minimum
      ) order by member_name) from computed), '[]'::jsonb),
    'totals', (
      select jsonb_build_object(
        'pension_count',          count(*),
        'under_minimum_count',    count(*) filter (where under_minimum),
        'total_required_minimum_cents', coalesce(sum(required_minimum_cents), 0))
      from computed),
    'caveats', jsonb_build_array(
      'The required minimum uses the member''s age at 1 July and the standard ATO age-band rate (SIS reg 1.06 sch 7) applied to the pension''s commencement value. The precise base is the 1-July account balance — a later refinement reads the rolled-forward balance (SC-5.I.01).',
      'Actual pension payments are not tracked in the schema yet, so under_minimum flags a pension whose RECORDED min_drawdown_percent is below the required age-band rate (set up to under-draw). Once actual payments are tracked, the monitor compares actual vs required cents.',
      'COVID-19 temporary 50% reduction is not applied (standard rates only). TRIS in accumulation phase also has a 10% maximum drawdown, which is not modelled here. A null member date of birth defaults to the under-65 4% band.'
    ),
    'note', 'SMSF minimum-pension-drawdown monitor (SC-5.L.02): per pension, the age-banded required minimum (commencement value × the member''s age-band rate) and an under_minimum flag where the recorded rate is below the band. Reads smsf_pensions/members + smsf_min_drawdown_rates. Advisory; SECURITY INVOKER; no writes.'
  )
  into v_result;

  return v_result;
end;
$$;

comment on function public.smsf_pension_drawdown(uuid, integer, uuid) is
  'SC-5.L.02: per-pension SMSF minimum-drawdown monitor (jsonb) — required minimum = the '
  'member''s age-band rate (smsf_min_drawdown_rates, SIS reg 1.06 sch 7) × the pension''s '
  'commencement value, with an under_minimum flag where the recorded rate is below the band. '
  'Reads smsf_pensions/members (0163). SECURITY INVOKER — RLS scopes the caller; no writes.';

revoke all on function public.smsf_pension_drawdown(uuid, integer, uuid) from public, anon;
grant execute on function public.smsf_pension_drawdown(uuid, integer, uuid) to authenticated;
