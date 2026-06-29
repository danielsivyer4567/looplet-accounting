-- 0159_div7a_tables.sql — SC-5.E.01 (Phase 5, Div 7A / UPE tracking)
--
-- The first Div 7A slice: the two registry tables the Div 7A engine (SC-5.E.02
-- min-repayment schedule, SC-5.E.03 breach detection, SC-5.F.01 loan-agreement doc)
-- reads and writes. TABLES ONLY — the benchmark-rate reference + schedule RPC is
-- SC-5.E.02, breach detection is SC-5.E.03.
--
--   div7a_loans — a Division 7A loan: a private company lends to a shareholder or
--                 associate. Without a complying loan agreement (minimum interest at
--                 the ATO benchmark rate + repaid over the maximum term) the loan is
--                 deemed an unfranked dividend. Term is a fixed legal set: 7 years
--                 (unsecured) or 25 years (secured by a registered mortgage over real
--                 property) — a CHECK, not an enum (small closed set, house pattern
--                 0152's election_type). benchmark_rate_basis_points snapshots the rate
--                 recorded for the loan; the authoritative per-FY benchmark table is
--                 SC-5.E.02 (the schedule RPC reads that, this column is the entered/
--                 agreed figure). Money-in-cents (BIGINT).
--
--   div7a_upe   — an Unpaid Present Entitlement: a trust has made a corporate
--                 beneficiary presently entitled to trust income (a trust_distribution,
--                 SC-5.A.03) but has not paid it. Post-Dec-2009 (TR 2010/3 / PCG 2017/13)
--                 an unpaid UPE to a corporate beneficiary can itself be treated as a
--                 Division 7A loan unless put on a complying sub-trust or loan footing.
--                 `management` records that election: 'unmanaged' (at risk),
--                 'sub_trust', or 'div7a_loan'. Linked to the trust (FK) and the
--                 corporate beneficiary (FK trust_beneficiaries, nullable — the
--                 beneficiary may be recorded by name before it's added to the registry).
--
-- Both: org-scoped (RLS via get_accessible_org_ids()), audited, soft-delete +
-- created_at/updated_at/created_by per 0001/0051/0151/0153. Independent of the
-- trust-distribution calc slices (can stand alone) but conceptually fed by
-- trust_distributions UPEs.
--
-- MIGRATION NUMBER: the ledger Files line planned 0151, long taken (0151_trusts_core,
-- now live). Reassigned to 0159 per the drift rule — the sequential repo head is
-- 0158_distribution_persist (0178/0179 are late hotfixes that sort after). Verified
-- live (dxoikltymmknxqpkpyhi, read-only): div7a_loans/div7a_upe ABSENT (no drift);
-- trusts/trust_beneficiaries/organizations + get_accessible_org_ids/set_updated_at/
-- audit_log_trigger_v2 all present live.

create table public.div7a_loans (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations (id) on delete cascade,
  -- The private company that made the loan (the lender). Free text + optional ABN,
  -- mirroring trusts.trustee_name (the company may not be a registered entity row).
  lender_company_name       text not null,
  lender_company_abn        text,
  -- The shareholder/associate who borrowed (individual, trust, another entity).
  borrower_name             text not null,
  -- The income year the loan was made (AU FY start year, e.g. 2024 => FY2024-25).
  loan_year                 int not null,
  principal_cents           bigint not null,
  -- Complying-loan maximum term: 7 years (unsecured) or 25 years (secured by a
  -- registered mortgage over real property). Closed legal set => CHECK.
  term_years                int not null check (term_years in (7, 25)),
  -- The benchmark interest rate recorded for the loan, in basis points (e.g. 875 =
  -- 8.75%). Nullable: the authoritative per-FY benchmark reference + schedule is
  -- SC-5.E.02; this is the entered/agreed figure for the loan.
  benchmark_rate_basis_points int,
  -- Whether a complying written loan agreement is in place (no agreement => the loan
  -- is at risk of being a deemed dividend).
  has_complying_agreement   boolean not null default false,
  notes                     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid references auth.users (id),
  deleted_at                timestamptz,
  constraint div7a_loans_principal_non_negative check (principal_cents >= 0),
  constraint div7a_loans_rate_non_negative
    check (benchmark_rate_basis_points is null or benchmark_rate_basis_points >= 0)
);

comment on table public.div7a_loans is
  'Division 7A loans from a private company to a shareholder/associate (SC-5.E.01). '
  'term_years 7 (unsecured) or 25 (secured); benchmark_rate_basis_points is the recorded '
  'rate (authoritative per-FY benchmark + min-repayment schedule is SC-5.E.02). Read by '
  'the Div 7A schedule/breach engine (SC-5.E.02/.03) and the loan-agreement doc (SC-5.F.01).';

create table public.div7a_upe (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations (id) on delete cascade,
  -- The trust that owes the present entitlement.
  trust_id               uuid not null references public.trusts (id) on delete cascade,
  -- The corporate beneficiary presently entitled. FK to the beneficiary registry
  -- (nullable — may be recorded by name first); name kept denormalised for display.
  beneficiary_id         uuid references public.trust_beneficiaries (id) on delete set null,
  beneficiary_company_name text not null,
  -- The income year the present entitlement arose (AU FY start year).
  year_arose             int not null,
  unpaid_amount_cents    bigint not null,
  -- How the UPE is being managed for Div 7A: 'unmanaged' (at risk of being a deemed
  -- Div 7A loan), 'sub_trust' (held on a complying sub-trust), or 'div7a_loan' (put on
  -- a complying Div 7A loan footing). Closed set => CHECK.
  management             text not null default 'unmanaged'
                           check (management in ('unmanaged', 'sub_trust', 'div7a_loan')),
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid references auth.users (id),
  deleted_at             timestamptz,
  constraint div7a_upe_amount_non_negative check (unpaid_amount_cents >= 0)
);

comment on table public.div7a_upe is
  'Unpaid Present Entitlements of a trust to a corporate beneficiary (SC-5.E.01). '
  'Post-Dec-2009 an unpaid UPE can be treated as a Division 7A loan unless on a complying '
  'sub-trust/loan footing (management column). Read by the Div 7A breach engine (SC-5.E.03).';

-- Loans listed per org (org-first also serves RLS-scoped listing).
create index div7a_loans_org_idx
  on public.div7a_loans (organization_id)
  where deleted_at is null;

-- UPEs listed per trust (org-first so the index also serves org-wide listing).
create index div7a_upe_org_trust_idx
  on public.div7a_upe (organization_id, trust_id)
  where deleted_at is null;

create trigger div7a_loans_set_updated_at
  before update on public.div7a_loans
  for each row execute function public.set_updated_at();
create trigger div7a_loans_audit
  after insert or update or delete on public.div7a_loans
  for each row execute function public.audit_log_trigger_v2();

create trigger div7a_upe_set_updated_at
  before update on public.div7a_upe
  for each row execute function public.set_updated_at();
create trigger div7a_upe_audit
  after insert or update or delete on public.div7a_upe
  for each row execute function public.audit_log_trigger_v2();

alter table public.div7a_loans enable row level security;
alter table public.div7a_upe enable row level security;

create policy div7a_loans_select on public.div7a_loans for select
  using (organization_id in (select get_accessible_org_ids()));
create policy div7a_loans_insert on public.div7a_loans for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy div7a_loans_update on public.div7a_loans for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy div7a_loans_delete on public.div7a_loans for delete
  using (organization_id in (select get_accessible_org_ids()));

create policy div7a_upe_select on public.div7a_upe for select
  using (organization_id in (select get_accessible_org_ids()));
create policy div7a_upe_insert on public.div7a_upe for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy div7a_upe_update on public.div7a_upe for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy div7a_upe_delete on public.div7a_upe for delete
  using (organization_id in (select get_accessible_org_ids()));

grant select, insert, update, delete on public.div7a_loans to authenticated;
grant select, insert, update, delete on public.div7a_upe to authenticated;
