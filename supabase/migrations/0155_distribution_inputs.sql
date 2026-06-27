-- 0155_distribution_inputs.sql — SC-5.C.01 (Phase 5, Trusts — distribution optimisation)
--
-- The READ-ONLY INPUT LAYER for the distribution optimiser (SC-5.C.02+). It assembles,
-- per beneficiary of a trust, the tax facts the optimiser needs to allocate s95 net
-- income (SC-5.B.01) to minimise total family tax: entity kind, other assessable income,
-- carry-forward losses, residency, the Div 6AA minor test, the s100AA tax-exempt flag,
-- and each beneficiary's marginal-rate bracket. Isolating this layer keeps the optimiser
-- slice testable against fixed inputs.
--
-- FOUR objects, ordered so the build stays green and each is independently assertable:
--
--   1. beneficiary_tax_profiles — PER-(beneficiary, FY) curated tax facts. trust_beneficiaries
--      (0151) is deliberately the STATIC registry ("No money columns at this layer — amounts
--      live elsewhere"); a beneficiary's other income / losses / residency vary BY YEAR, so
--      they live here keyed on (beneficiary_id, fy_start_year), not as FY-agnostic columns on
--      the registry. Org-scoped (RLS via get_accessible_org_ids()), audited, soft-delete —
--      the 0151 house pattern. Curated inputs (default 0 / resident / not-excepted): a
--      beneficiary's external income has no source in this schema, exactly like 0150's
--      curated business_profile.payg_instalments_paid_cents.
--
--   2. resident_marginal_rates — GLOBAL reference (the 0125 payroll_tax_rates pattern:
--      RLS select-true, no per-org writes). The resident individual marginal scale as DATA
--      so (a) the optimiser can bracket-FILL (it needs band boundaries, not just a rate) and
--      (b) there is a canonical home for the scale. The seeded FY2024-25+ scale + base_tax
--      figures are IDENTICAL to the inline copy in 0150 compute_tax_payable (verified equal);
--      a later refactor can point 0150 at this table to retire that duplication.
--
--   3. div6aa_minor_rates — GLOBAL reference. The Div 6AA penalty scale on a minor's
--      eligible (non-excepted) income: $0–$416 nil; $417–$1,307 = 66% of the excess over
--      $416; $1,308+ = 45% of the WHOLE amount (the top band sets applies_to_whole). The
--      ledger mandates "Minor-beneficiary (Div 6AA) penalty rates encoded here as a seeded
--      rate table" — this is it; the optimiser reads it to cap a penalised minor near $416.
--
--   4. distribution_inputs(org, trust, fy) — the assembler RPC. SECURITY INVOKER + STABLE:
--      trust_beneficiaries / beneficiary_tax_profiles are RLS-scoped to the caller, so a
--      foreign org degrades to an empty set rather than leaking. Returns jsonb: per-beneficiary
--      inputs + both rate references (so the optimiser needs one call). No writes.
--
-- DEP NOTE: the ledger lists SC-5.A.01 + SC-5.B.01 as deps. SC-5.A.01 (trust_beneficiaries)
-- is a REAL dep (FK + read). SC-5.B.01 (trust_net_income, the s95 TOTAL) is ORDERING-ONLY
-- here — the s95 pool is a trust-level figure the OPTIMISER (SC-5.C.02) consumes alongside
-- these per-beneficiary inputs; this layer does not call it, which keeps the test light and
-- the input set independently assertable (same stance 0154 took on its "depends on SC-5.A.01").
--
-- MIGRATION NUMBER: the ledger Files line planned 0146, long taken (Phase 4 return builder
-- consumed 0142–0150; the trust chain 0151–0154). Reassigned to 0155 per the drift rule —
-- the sequential repo head is 0154_trust_net_income (0178/0179 are late hotfixes that sort
-- after). Verified live (dxoikltymmknxqpkpyhi, read-only): distribution_inputs /
-- beneficiary_tax_profiles / resident_marginal_rates / div6aa_minor_rates all ABSENT and the
-- whole 0151–0154 trust chain is committed-but-not-deployed (deploys together) — no drift.

-- ── 1. Per-(beneficiary, FY) curated tax profile ───────────────────────────────
create table public.beneficiary_tax_profiles (
  id                            uuid primary key default gen_random_uuid(),
  organization_id               uuid not null references public.organizations (id) on delete cascade,
  beneficiary_id                uuid not null references public.trust_beneficiaries (id) on delete cascade,
  fy_start_year                 integer not null,           -- AU FY by start year (2024 = FY2024-25)
  -- The beneficiary's assessable income from OTHER sources (before any trust distribution).
  -- Drives the marginal-rate bracket. Curated — no schema source. Default 0.
  other_assessable_income_cents bigint  not null default 0 check (other_assessable_income_cents >= 0),
  -- Carry-forward tax losses the beneficiary can absorb against distributed income.
  prior_year_losses_cents       bigint  not null default 0 check (prior_year_losses_cents >= 0),
  -- Resident for tax this FY (drives which scale applies; non-resident scale not modelled).
  is_resident                   boolean not null default true,
  -- Div 6AA EXCEPTED PERSON (ITAA-1936 s102AC): disabled, beneficiary of a deceased estate,
  -- etc. When true the minor penalty rates do NOT apply even if under 18.
  is_excepted_person            boolean not null default false,
  notes                         text,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  created_by                    uuid references auth.users (id),
  deleted_at                    timestamptz,
  -- One profile per beneficiary per FY (the assembler's join key + upsert arbiter).
  unique (beneficiary_id, fy_start_year)
);

comment on table public.beneficiary_tax_profiles is
  'SC-5.C.01: per-(beneficiary, FY) curated tax facts for the distribution optimiser '
  '(other assessable income, carry-forward losses, residency, Div 6AA excepted-person). '
  'trust_beneficiaries (0151) is the static registry; these FY-varying amounts live here. '
  'Org-scoped RLS + audited; missing row → optimiser defaults (0 income, 0 losses, resident).';

-- The unique (beneficiary_id, fy_start_year) constraint already indexes the assembler's
-- per-beneficiary lookup; only the org-wide RLS scan needs its own index.
create index beneficiary_tax_profiles_org_idx
  on public.beneficiary_tax_profiles (organization_id)
  where deleted_at is null;

create trigger beneficiary_tax_profiles_set_updated_at
  before update on public.beneficiary_tax_profiles
  for each row execute function public.set_updated_at();
create trigger beneficiary_tax_profiles_audit
  after insert or update or delete on public.beneficiary_tax_profiles
  for each row execute function public.audit_log_trigger_v2();

alter table public.beneficiary_tax_profiles enable row level security;

create policy beneficiary_tax_profiles_select on public.beneficiary_tax_profiles for select
  using (organization_id in (select get_accessible_org_ids()));
create policy beneficiary_tax_profiles_insert on public.beneficiary_tax_profiles for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy beneficiary_tax_profiles_update on public.beneficiary_tax_profiles for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy beneficiary_tax_profiles_delete on public.beneficiary_tax_profiles for delete
  using (organization_id in (select get_accessible_org_ids()));

grant select, insert, update, delete on public.beneficiary_tax_profiles to authenticated;

-- ── 2. Resident individual marginal scale (global reference, effective-dated) ───
create table public.resident_marginal_rates (
  id             uuid primary key default gen_random_uuid(),
  effective_from date    not null,
  effective_to   date,                                        -- null = current (open-ended)
  lower_cents    bigint  not null check (lower_cents >= 0),   -- bracket floor (inclusive)
  upper_cents    bigint  check (upper_cents is null or upper_cents > lower_cents),  -- null = top
  rate           numeric(6, 5) not null check (rate >= 0 and rate <= 1),
  base_tax_cents bigint  not null default 0 check (base_tax_cents >= 0),  -- cumulative tax at lower_cents
  notes          text,
  unique (effective_from, lower_cents),
  check (effective_to is null or effective_to > effective_from)
);

comment on table public.resident_marginal_rates is
  'Global resident individual marginal income-tax scale as effective-dated reference data '
  '(0125 pattern). Bracket = [lower_cents, upper_cents); tax = base_tax_cents + rate × '
  '(income − lower_cents). Seeded FY2024-25+ scale equals 0150 compute_tax_payable''s inline '
  'copy. Read by distribution_inputs (marginal bracket) + the SC-5.C.02 optimiser (bracket-fill).';

insert into public.resident_marginal_rates
  (effective_from, effective_to, lower_cents, upper_cents, rate, base_tax_cents, notes)
values
  (date '2024-07-01', null,        0,  1820000, 0.00000,       0, 'Tax-free threshold $0–$18,200.'),
  (date '2024-07-01', null,  1820000,  4500000, 0.16000,       0, '$18,201–$45,000: 16%.'),
  (date '2024-07-01', null,  4500000, 13500000, 0.30000,  428800, '$45,001–$135,000: 30% (base $4,288).'),
  (date '2024-07-01', null, 13500000, 19000000, 0.37000, 3128800, '$135,001–$190,000: 37% (base $31,288).'),
  (date '2024-07-01', null, 19000000,     null, 0.45000, 5163800, 'Over $190,000: 45% (base $51,638).')
on conflict (effective_from, lower_cents) do update set
  effective_to   = excluded.effective_to,
  upper_cents    = excluded.upper_cents,
  rate           = excluded.rate,
  base_tax_cents = excluded.base_tax_cents,
  notes          = excluded.notes;

alter table public.resident_marginal_rates enable row level security;
create policy resident_marginal_rates_select on public.resident_marginal_rates
  for select using (true);
revoke insert, update, delete on public.resident_marginal_rates from authenticated, anon;
grant select on public.resident_marginal_rates to authenticated, anon;

-- ── 3. Div 6AA minor-beneficiary penalty scale (global reference) ──────────────
create table public.div6aa_minor_rates (
  id               uuid primary key default gen_random_uuid(),
  effective_from   date    not null,
  effective_to     date,
  lower_cents      bigint  not null check (lower_cents >= 0),
  upper_cents      bigint  check (upper_cents is null or upper_cents > lower_cents),
  rate             numeric(6, 5) not null check (rate >= 0 and rate <= 1),
  -- Top band only: the rate applies to the WHOLE eligible income, not the excess over lower.
  -- (No base_tax_cents: every Div 6AA band's cumulative base is 0 — the nil band contributes
  -- nothing and the top band is whole-amount — so it would be inert, unlike the resident scale.)
  applies_to_whole boolean not null default false,
  notes            text,
  unique (effective_from, lower_cents),
  check (effective_to is null or effective_to > effective_from)
);

comment on table public.div6aa_minor_rates is
  'Global Div 6AA (ITRA 1986) penalty scale on a minor''s eligible (non-excepted) income. '
  'Bands: $0–$416 nil; $417–$1,307 = 66% of the excess over $416; $1,308+ = 45% of the WHOLE '
  'amount (applies_to_whole). Seeded reference (0125 pattern); read by the SC-5.C.02 optimiser '
  'to cap a penalised minor''s allocation near the $416 nil band.';

insert into public.div6aa_minor_rates
  (effective_from, effective_to, lower_cents, upper_cents, rate, applies_to_whole, notes)
values
  (date '2024-07-01', null,      0,  41600, 0.00000, false, 'Eligible income $0–$416: nil.'),
  (date '2024-07-01', null,  41600, 130800, 0.66000, false, '$417–$1,307: 66% of the excess over $416.'),
  (date '2024-07-01', null, 130800,   null, 0.45000, true,  '$1,308+: 45% of the WHOLE eligible income.')
on conflict (effective_from, lower_cents) do update set
  effective_to     = excluded.effective_to,
  upper_cents      = excluded.upper_cents,
  rate             = excluded.rate,
  applies_to_whole = excluded.applies_to_whole,
  notes            = excluded.notes;

alter table public.div6aa_minor_rates enable row level security;
create policy div6aa_minor_rates_select on public.div6aa_minor_rates
  for select using (true);
revoke insert, update, delete on public.div6aa_minor_rates from authenticated, anon;
grant select on public.div6aa_minor_rates to authenticated, anon;

-- ── 4. distribution_inputs: assemble per-beneficiary tax inputs + rate references ──
create or replace function public.distribution_inputs(
    p_org uuid, p_trust uuid, p_fy_start_year integer)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fy_end        date := make_date(p_fy_start_year + 1, 6, 30);  -- 30 June = the age-test date
  -- Born after this date ⇒ under 18 at 30 June (turning 18 exactly on 30 June ⇒ adult).
  v_minor_cutoff  date := make_date(p_fy_start_year + 1 - 18, 6, 30);
  v_scale         jsonb;
  v_minor         jsonb;
  v_beneficiaries jsonb;
begin
  -- Rate references for the requested FY (effective-dated half-open windows).
  select jsonb_agg(jsonb_build_object(
           'lower_cents', lower_cents, 'upper_cents', upper_cents,
           'rate', rate, 'base_tax_cents', base_tax_cents) order by lower_cents)
    into v_scale
  from resident_marginal_rates
  where effective_from <= v_fy_end and (effective_to is null or v_fy_end < effective_to);

  select jsonb_agg(jsonb_build_object(
           'lower_cents', lower_cents, 'upper_cents', upper_cents,
           'rate', rate, 'applies_to_whole', applies_to_whole) order by lower_cents)
    into v_minor
  from div6aa_minor_rates
  where effective_from <= v_fy_end and (effective_to is null or v_fy_end < effective_to);

  -- Per-beneficiary inputs. LEFT JOIN the profile so a beneficiary with no row for this FY
  -- degrades to sensible defaults (0 income, 0 losses, resident, not excepted). Each
  -- profile default + derived flag is resolved ONCE in the `f`/`pen` laterals and reused.
  select jsonb_agg(
    jsonb_build_object(
      'beneficiary_id',                b.id,
      'name',                          b.name,
      'entity_kind',                   b.beneficiary_type,
      'other_assessable_income_cents', f.other_income,
      'prior_year_losses_cents',       f.losses,
      'is_resident',                   f.is_resident,
      'is_minor',                      f.is_minor,
      'is_excepted_person',            f.is_excepted,
      -- Div 6AA penalty rates bite only on a NON-excepted minor.
      'div6aa_penalty_applies',        pen.penalty_applies,
      -- ITAA-1936 s100AA/s100AB: a tax-exempt beneficiary (charity) must be PAID within the
      -- statutory window or the trustee is assessed. Flag derived from entity kind.
      's100aa_exempt_entity',          (b.beneficiary_type = 'charity'),
      'marginal_rate',                 mr.rate,
      'marginal_basis',                mr.basis
    ) order by b.name)
    into v_beneficiaries
  from trust_beneficiaries b
  left join beneficiary_tax_profiles p
    on p.beneficiary_id = b.id and p.fy_start_year = p_fy_start_year and p.deleted_at is null
  -- Resolve every profile default + the age-derived minor test once.
  cross join lateral (
    select
      coalesce(p.other_assessable_income_cents, 0) as other_income,
      coalesce(p.prior_year_losses_cents, 0)       as losses,
      coalesce(p.is_resident, true)                as is_resident,
      coalesce(p.is_excepted_person, false)        as is_excepted,
      (b.beneficiary_type = 'individual'
       and b.date_of_birth is not null
       and b.date_of_birth > v_minor_cutoff)       as is_minor
  ) f
  cross join lateral (
    select (f.is_minor and not f.is_excepted) as penalty_applies
  ) pen
  cross join lateral (
    -- Marginal rate on the next dollar of distributed ordinary income, by entity kind.
    select
      case
        -- A penalised minor's eligible income is taxed under Div 6AA, not the ordinary
        -- scale — report the 45% top penalty rate (precise $416/66% shade-in is in v_minor).
        when pen.penalty_applies then 0.45::numeric
        when b.beneficiary_type = 'individual' then
          coalesce((select r.rate from resident_marginal_rates r
                    where r.effective_from <= v_fy_end
                      and (r.effective_to is null or v_fy_end < r.effective_to)
                      and r.lower_cents <= f.other_income
                    order by r.lower_cents desc limit 1), 0::numeric)
        when b.beneficiary_type = 'company' then 0.30::numeric   -- base-rate 25% not determined per beneficiary
        when b.beneficiary_type = 'smsf'    then 0.15::numeric
        when b.beneficiary_type = 'charity' then 0.00::numeric   -- tax exempt (subject to s100AA)
        else null::numeric                                       -- trust/partnership/other: pass-through
      end as rate,
      case
        when pen.penalty_applies then 'div6aa_minor_penalty'
        when b.beneficiary_type = 'individual' and not f.is_resident
                                            then 'non_resident_resident_scale_proxy'
        when b.beneficiary_type = 'individual' then 'resident_individual_scale'
        when b.beneficiary_type = 'company' then 'company_flat_30'
        when b.beneficiary_type = 'smsf'    then 'smsf_flat_15'
        when b.beneficiary_type = 'charity' then 'tax_exempt'
        else 'pass_through_unknown'
      end as basis
  ) mr
  where b.organization_id = p_org and b.trust_id = p_trust and b.deleted_at is null;

  return jsonb_build_object(
    'organization_id',   p_org,
    'trust_id',          p_trust,
    'fy_start_year',     p_fy_start_year,
    'period_start',      make_date(p_fy_start_year, 7, 1),
    'period_end',        v_fy_end,
    'beneficiaries',     coalesce(v_beneficiaries, '[]'::jsonb),
    'beneficiary_count', coalesce(jsonb_array_length(v_beneficiaries), 0),
    'rate_reference', jsonb_build_object(
      'resident_individual_scale', coalesce(v_scale, '[]'::jsonb),
      'div6aa_minor_rates',        coalesce(v_minor, '[]'::jsonb)
    ),
    'caveats', jsonb_build_array(
      'other_assessable_income_cents / prior_year_losses_cents are curated per-(beneficiary, FY) inputs (no schema source); a beneficiary with no profile row for the FY defaults to 0 income / 0 losses / resident / not-excepted.',
      'is_minor is the age<18-at-30-June test only; the Div 6AA excepted-PERSON carve-out is the curated is_excepted_person flag and the excepted-INCOME analysis (employment, deceased estate, disability income) is not modelled.',
      'marginal_rate for individuals uses the resident FY2024-25+ scale; a non-resident is proxied by the resident scale (flagged via marginal_basis); a company beneficiary assumes the full 30% rate (base-rate-entity 25% not determined per beneficiary); trust/partnership beneficiaries are pass-through (rate null).',
      's100aa_exempt_entity flags charity beneficiaries subject to ITAA-1936 s100AA/s100AB (pay-or-trustee-assessed); the 2-month payment-timing test itself is not enforced here.',
      'For a penalised minor, marginal_rate is reported as the 45% Div 6AA top rate; the precise $0–$416 nil / 66% shade-in is in rate_reference.div6aa_minor_rates for the optimiser''s bracket-fill.'
    )
  );
end;
$$;

comment on function public.distribution_inputs(uuid, uuid, integer) is
  'SC-5.C.01: per-beneficiary tax inputs (jsonb) for a trust + AU FY — entity kind, other '
  'assessable income, carry-forward losses, residency, Div 6AA minor + s100AA exempt flags, '
  'and the marginal-rate bracket — plus the resident + Div 6AA rate references for the '
  'SC-5.C.02 optimiser. Read-only; SECURITY INVOKER scopes the caller via RLS.';

revoke all on function public.distribution_inputs(uuid, uuid, integer) from public, anon;
grant execute on function public.distribution_inputs(uuid, uuid, integer) to authenticated;
