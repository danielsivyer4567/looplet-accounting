-- 0163_smsf_movements.sql — SC-5.H.02 (Phase 5, SMSF — transactional layer)
--
-- The SMSF transactional tables that hang off the core (smsf_funds/smsf_members, 0162):
-- investments held, member contributions, and pensions in payment. This is the layer the
-- member-balance roll-forward (SC-5.I.01), the transfer-balance-cap / TBAR (SC-5.I.02),
-- the contribution-caps / Div 293 monitor (SC-5.L.01) and the minimum-drawdown monitor
-- (SC-5.L.02) all read. TABLES ONLY — those calcs are later slices.
--
--   smsf_investments  — assets the fund holds (asset class, name, units, cost + current
--                       market value, acquisition date). Money-in-cents (BIGINT).
--   smsf_contributions— a contribution to a member's account. type concessional vs
--                       non-concessional (the cap-relevant split, SC-5.L.01) — a fixed
--                       legal pair, CHECK not enum. amount_cents + the income year +
--                       contribution date.
--   smsf_pensions     — a pension in payment to a member. type ABP (account-based
--                       pension) vs TRIS (transition-to-retirement income stream) — fixed
--                       pair, CHECK. Commencement value (the TBC debit/credit basis,
--                       SC-5.I.02) + the age-based minimum-drawdown percentage.
--
-- All: org-scoped (RLS via get_accessible_org_ids()), audited, soft-delete +
-- created_at/updated_at/created_by per 0001/0151/0162. FK to smsf_funds / smsf_members
-- (0162). organization_id denormalised for direct RLS (house pattern).
--
-- MIGRATION NUMBER: the ledger Files line planned 0155, long taken (distribution_inputs).
-- Reassigned to 0163 per the drift rule — the sequential repo head is 0162_smsf_core
-- (0178/0179 are late hotfixes that sort after). Verified live (dxoikltymmknxqpkpyhi,
-- read-only): smsf_investments/smsf_contributions/smsf_pensions ABSENT (no drift);
-- smsf_funds/smsf_members are repo-only (0162, not yet deployed; deploy together).

create table public.smsf_investments (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete cascade,
  fund_id              uuid not null references public.smsf_funds (id) on delete cascade,
  name                 text not null,
  -- Broad asset class for reporting / in-house-asset checks. Free-ish but a small set;
  -- kept as a CHECK so the operating statement / SIS in-house-asset tests can group on it.
  asset_class          text not null default 'other'
                         check (asset_class in ('cash', 'shares', 'property', 'managed_fund',
                                                'fixed_interest', 'crypto', 'collectible', 'other')),
  units                numeric,                       -- nullable: cash/property have no unit count
  cost_base_cents      bigint not null default 0,
  market_value_cents   bigint not null default 0,
  acquisition_date     date,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid references auth.users (id),
  deleted_at           timestamptz,
  constraint smsf_investments_values_non_negative
    check (cost_base_cents >= 0 and market_value_cents >= 0)
);

comment on table public.smsf_investments is
  'Assets an SMSF holds (SC-5.H.02). asset_class groups for the operating statement / SIS '
  'in-house-asset tests; cost_base + market_value in cents. Read by the SMSF financials '
  '(SC-5.J).';

create table public.smsf_contributions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  fund_id           uuid not null references public.smsf_funds (id) on delete cascade,
  member_id         uuid not null references public.smsf_members (id) on delete cascade,
  -- The cap-relevant split (SC-5.L.01): concessional (employer/salary-sacrifice/deductible
  -- personal) vs non-concessional (after-tax). Fixed legal pair => CHECK.
  contribution_type text not null
                      check (contribution_type in ('concessional', 'non_concessional')),
  amount_cents      bigint not null,
  -- The income year the contribution counts to (AU FY start year) + the actual date.
  fy_start_year     int not null,
  contribution_date date,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references auth.users (id),
  deleted_at        timestamptz,
  constraint smsf_contributions_amount_non_negative check (amount_cents >= 0)
);

comment on table public.smsf_contributions is
  'Contributions to an SMSF member''s account (SC-5.H.02). contribution_type concessional '
  'vs non_concessional drives the cap / Div 293 monitor (SC-5.L.01). amount in cents.';

create table public.smsf_pensions (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  fund_id             uuid not null references public.smsf_funds (id) on delete cascade,
  member_id           uuid not null references public.smsf_members (id) on delete cascade,
  -- ABP (account-based pension) vs TRIS (transition-to-retirement income stream).
  pension_type        text not null
                        check (pension_type in ('abp', 'tris')),
  commencement_date   date,
  -- The pension's value at commencement — the transfer-balance-cap debit/credit basis
  -- (SC-5.I.02). Money-in-cents.
  commencement_value_cents bigint not null default 0,
  -- The age-based minimum annual drawdown rate (e.g. 4.00, 5.00 … 14.00 percent). The
  -- drawdown monitor (SC-5.L.02) compares actual payments against this.
  min_drawdown_percent numeric(5, 2) not null default 0,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id),
  deleted_at          timestamptz,
  constraint smsf_pensions_value_non_negative check (commencement_value_cents >= 0),
  constraint smsf_pensions_drawdown_range
    check (min_drawdown_percent >= 0 and min_drawdown_percent <= 100)
);

comment on table public.smsf_pensions is
  'Pensions in payment to an SMSF member (SC-5.H.02). pension_type abp/tris; '
  'commencement_value_cents is the TBC basis (SC-5.I.02); min_drawdown_percent drives the '
  'minimum-drawdown monitor (SC-5.L.02).';

-- Investments listed per fund (org-first also serves RLS-scoped listing).
create index smsf_investments_org_fund_idx
  on public.smsf_investments (organization_id, fund_id)
  where deleted_at is null;

-- Contributions listed per member (org-first); FY is a common filter for cap checks.
create index smsf_contributions_org_member_fy_idx
  on public.smsf_contributions (organization_id, member_id, fy_start_year)
  where deleted_at is null;

-- Pensions listed per member (org-first).
create index smsf_pensions_org_member_idx
  on public.smsf_pensions (organization_id, member_id)
  where deleted_at is null;

create trigger smsf_investments_set_updated_at
  before update on public.smsf_investments
  for each row execute function public.set_updated_at();
create trigger smsf_investments_audit
  after insert or update or delete on public.smsf_investments
  for each row execute function public.audit_log_trigger_v2();

create trigger smsf_contributions_set_updated_at
  before update on public.smsf_contributions
  for each row execute function public.set_updated_at();
create trigger smsf_contributions_audit
  after insert or update or delete on public.smsf_contributions
  for each row execute function public.audit_log_trigger_v2();

create trigger smsf_pensions_set_updated_at
  before update on public.smsf_pensions
  for each row execute function public.set_updated_at();
create trigger smsf_pensions_audit
  after insert or update or delete on public.smsf_pensions
  for each row execute function public.audit_log_trigger_v2();

alter table public.smsf_investments enable row level security;
alter table public.smsf_contributions enable row level security;
alter table public.smsf_pensions enable row level security;

create policy smsf_investments_select on public.smsf_investments for select
  using (organization_id in (select get_accessible_org_ids()));
create policy smsf_investments_insert on public.smsf_investments for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy smsf_investments_update on public.smsf_investments for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy smsf_investments_delete on public.smsf_investments for delete
  using (organization_id in (select get_accessible_org_ids()));

create policy smsf_contributions_select on public.smsf_contributions for select
  using (organization_id in (select get_accessible_org_ids()));
create policy smsf_contributions_insert on public.smsf_contributions for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy smsf_contributions_update on public.smsf_contributions for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy smsf_contributions_delete on public.smsf_contributions for delete
  using (organization_id in (select get_accessible_org_ids()));

create policy smsf_pensions_select on public.smsf_pensions for select
  using (organization_id in (select get_accessible_org_ids()));
create policy smsf_pensions_insert on public.smsf_pensions for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy smsf_pensions_update on public.smsf_pensions for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy smsf_pensions_delete on public.smsf_pensions for delete
  using (organization_id in (select get_accessible_org_ids()));

grant select, insert, update, delete on public.smsf_investments to authenticated;
grant select, insert, update, delete on public.smsf_contributions to authenticated;
grant select, insert, update, delete on public.smsf_pensions to authenticated;
