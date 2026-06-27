-- 0151_trusts_core.sql — SC-5.A.01 (Phase 5, Trusts)
--
-- The first trust slice: the two core entity tables that everything else in
-- Phase 5's trust track hangs off. TABLES ONLY — no calc, no deed terms, no
-- distributions. Those are separate green-ordered slices:
--   * trust_deed + family_trust_elections  → SC-5.A.02 (0152)
--   * trust_distributions                  → SC-5.A.03 (0153)
--   * net-income (s95) / optimiser / etc.  → SC-5.B / 5.C
--
--   trusts               — one row per trust the org acts for. The trust/non-trust
--                          distinction itself is read from business_profile.entity_type
--                          = 'trust' (migration 0051), NOT from a column here; this
--                          table simply registers the trust entities to administer.
--   trust_beneficiaries  — the people/entities a trust may distribute to. Carries its
--                          own organization_id (denormalised, like every other
--                          org-scoped table) so RLS is a direct check rather than a
--                          join through trusts, matching the house pattern (0138).
--
-- Both: org-scoped (RLS via get_accessible_org_ids()), audited, soft-delete +
-- created_at/updated_at/created_by per 0001/0051/0138. No money columns at this
-- layer — amounts live on trust_distributions (SC-5.A.03).
--
-- MIGRATION NUMBER: the ledger planned 0142, but 0142–0150 are all taken (Phase 4
-- CGT/return builder consumed them). Reassigned to 0151 per the drift rule — the
-- sequential repo head is 0150_return_offsets_credits (0178/0179 are late hotfixes).
-- Verified against live (dxoikltymmknxqpkpyhi): trusts/trust_beneficiaries do not
-- exist; organizations PK = id; get_accessible_org_ids/set_updated_at/
-- audit_log_trigger_v2 all present.

do $$ begin
  create type public.trust_type as enum (
    'discretionary', 'unit', 'hybrid', 'testamentary', 'bare'
  );
exception when duplicate_object then null; end $$;

-- Kind of beneficiary entity — drives the distribution optimiser's per-beneficiary
-- tax treatment (SC-5.C). 'smsf' and 'charity' are included so the same enum covers
-- the full range of who a discretionary trust can stream to.
do $$ begin
  create type public.beneficiary_type as enum (
    'individual', 'company', 'trust', 'smsf', 'charity', 'partnership', 'other'
  );
exception when duplicate_object then null; end $$;

create table public.trusts (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  name              text not null,
  trust_type        public.trust_type not null default 'discretionary',
  abn               text,                              -- nullable: may be unregistered/unknown at entry
  tfn               text,                              -- nullable; sensitive, stored as entered
  -- The trustee acting for the trust. Corporate vs individual trustee changes
  -- nothing structurally here but is needed for the distribution minute (SC-5.D).
  trustee_name      text,
  trustee_abn       text,
  is_corporate_trustee boolean not null default false,
  settled_date      date,                              -- when the trust was settled/established
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references auth.users (id),
  deleted_at        timestamptz
);

comment on table public.trusts is
  'Trust entities an org administers (SC-5.A.01). The entity IS a trust per '
  'business_profile.entity_type=''trust'' (0051); this registers the specific trusts. '
  'Tables only — deed/FTE = 0152, distributions = 0153.';

create table public.trust_beneficiaries (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  trust_id          uuid not null references public.trusts (id) on delete cascade,
  name              text not null,
  beneficiary_type  public.beneficiary_type not null default 'individual',
  -- Relationship to the trust/test individual (e.g. 'spouse', 'child', 'related_entity').
  -- Free text — used descriptively in the minute, not for calc.
  relationship      text,
  tfn               text,                              -- nullable; sensitive
  abn               text,                              -- nullable (for company/trust beneficiaries)
  -- Drives the Div 6AA minor-beneficiary penalty test in the optimiser (SC-5.C.01).
  -- Nullable: a non-individual beneficiary has no DOB.
  date_of_birth     date,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references auth.users (id),
  deleted_at        timestamptz,
  -- A DOB only makes sense for an individual beneficiary.
  check (date_of_birth is null or beneficiary_type = 'individual')
);

comment on table public.trust_beneficiaries is
  'Beneficiaries a trust may distribute to (SC-5.A.01). Carries organization_id '
  'denormalised for direct RLS. date_of_birth feeds the Div 6AA minor test (SC-5.C).';

-- Trusts listed per org.
create index trusts_org_idx
  on public.trusts (organization_id)
  where deleted_at is null;

-- Beneficiaries listed per trust (the common access path); org column kept first
-- so the index also serves RLS-scoped org-wide listing.
create index trust_beneficiaries_org_trust_idx
  on public.trust_beneficiaries (organization_id, trust_id)
  where deleted_at is null;

create trigger trusts_set_updated_at
  before update on public.trusts
  for each row execute function public.set_updated_at();
create trigger trusts_audit
  after insert or update or delete on public.trusts
  for each row execute function public.audit_log_trigger_v2();

create trigger trust_beneficiaries_set_updated_at
  before update on public.trust_beneficiaries
  for each row execute function public.set_updated_at();
create trigger trust_beneficiaries_audit
  after insert or update or delete on public.trust_beneficiaries
  for each row execute function public.audit_log_trigger_v2();

alter table public.trusts enable row level security;
alter table public.trust_beneficiaries enable row level security;

create policy trusts_select on public.trusts for select
  using (organization_id in (select get_accessible_org_ids()));
create policy trusts_insert on public.trusts for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy trusts_update on public.trusts for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy trusts_delete on public.trusts for delete
  using (organization_id in (select get_accessible_org_ids()));

create policy trust_beneficiaries_select on public.trust_beneficiaries for select
  using (organization_id in (select get_accessible_org_ids()));
create policy trust_beneficiaries_insert on public.trust_beneficiaries for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy trust_beneficiaries_update on public.trust_beneficiaries for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy trust_beneficiaries_delete on public.trust_beneficiaries for delete
  using (organization_id in (select get_accessible_org_ids()));

grant select, insert, update, delete on public.trusts to authenticated;
grant select, insert, update, delete on public.trust_beneficiaries to authenticated;
