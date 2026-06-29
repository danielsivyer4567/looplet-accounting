-- 0152_trust_deed_fte.sql — SC-5.A.02 (Phase 5, Trusts)
--
-- The second trust slice: deed terms + family-trust/interposed-entity elections.
-- Both hang off trusts (0151). TABLES ONLY — distributions are SC-5.A.03 (0153),
-- the net-income/optimiser calc is SC-5.B/5.C.
--
--   trust_deed              — the governing deed for a trust. Stores a ref to the
--                             deed PDF (storage_key, in the private `bills` bucket,
--                             org-<id>/... key convention per 0087) plus the
--                             distribution-engine-relevant terms parsed out of it:
--                             streaming_allowed (does the deed permit streaming of
--                             capital gains / franked dividends — read by the
--                             streaming overlay SC-5.C.03), vesting_date, and the
--                             open-ended parsed_terms JSONB (distribution powers and
--                             any other parsed key terms the optimiser SC-5.C reads
--                             for deed-power constraints). One ACTIVE deed per trust
--                             (partial unique on trust_id) — a restatement soft-
--                             deletes the prior row, so the engine never has to guess
--                             which deed governs.
--   family_trust_elections  — FTE / IEE records. An FTE names a test individual and,
--                             together with the trust-loss measures, is what makes a
--                             trust's losses deductible (the "loss-test" scope of the
--                             original SC-34 — the loss-test itself is a later read-
--                             only RPC, not a table, per the ledger). An IEE
--                             interposes an entity into an existing family group and
--                             carries no test individual of its own.
--
-- Both: org-scoped (RLS via get_accessible_org_ids()), audited, soft-delete +
-- created_at/updated_at/created_by per 0001/0051/0138/0151. No money columns at this
-- layer — amounts live on trust_distributions (SC-5.A.03).
--
-- election_type is a fixed 2-value legal set (FTE vs IEE) so it is a CHECK, not an
-- enum — matching the small-closed-set house pattern (0088) rather than the broader
-- classification enums of 0151 (trust_type/beneficiary_type) that would have churned
-- ALTER TYPE.
--
-- MIGRATION NUMBER: 0152. The ledger planned 0143, but 0143–0150 are taken (Phase 4
-- CGT/return builder) and 0151 is the trusts-core slice this one extends; the
-- sequential repo head is 0151_trusts_core (0178/0179 are late hotfixes). Verified
-- against live (dxoikltymmknxqpkpyhi, read-only): trust_deed/family_trust_elections
-- do not exist (no drift); get_accessible_org_ids/set_updated_at/audit_log_trigger_v2
-- and the `bills` storage bucket all present.

create table public.trust_deed (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  trust_id          uuid not null references public.trusts (id) on delete cascade,
  -- When the deed (or the restatement this row represents) was executed.
  deed_date         date,
  -- The day the trust vests/ends — a key compliance date (distributions must cease,
  -- the corpus vests in the takers). Hoisted from the deed for queryability/alerts.
  vesting_date      date,
  -- Does the deed permit streaming of capital gains / franked dividends to specific
  -- beneficiaries? Read by the streaming overlay (SC-5.C.03). Conservative default:
  -- assume not allowed until the deed is confirmed to permit it.
  streaming_allowed boolean not null default false,
  -- Distribution powers and any other key terms parsed from the deed, as read by the
  -- distribution optimiser (SC-5.C) for deed-power constraints. Open-ended so new
  -- parsed facts don't need a migration.
  parsed_terms      jsonb not null default '{}'::jsonb,
  -- Object key of the deed PDF in the private `bills` bucket (org-<id>/... convention,
  -- 0087). Nullable: the deed terms may be entered before the document is uploaded.
  storage_key       text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references auth.users (id),
  deleted_at        timestamptz
);

comment on table public.trust_deed is
  'Governing deed per trust (SC-5.A.02). storage_key -> deed PDF in the `bills` '
  'bucket; parsed_terms/streaming_allowed/vesting_date are what the distribution '
  'engine (SC-5.C) reads. One active deed per trust (partial unique on trust_id).';

create table public.family_trust_elections (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete cascade,
  trust_id             uuid not null references public.trusts (id) on delete cascade,
  -- 'fte' = Family Trust Election (names a test individual; underpins the trust-loss
  -- measures). 'iee' = Interposed Entity Election (joins an entity to an existing
  -- family group; no test individual of its own).
  election_type        text not null default 'fte'
                         check (election_type in ('fte', 'iee')),
  -- The specified/test individual whose family group the election defines. Nullable —
  -- always null for an IEE, and may be filled in after the FTE row is created.
  test_individual_name text,
  test_individual_tfn  text,                          -- nullable; sensitive
  -- The income year the election is specified to take effect from.
  election_fy          int not null,
  -- The income year the election was revoked, if ever (FTEs are revocable only in
  -- limited circumstances). Null = still in force.
  revoked_fy           int,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid references auth.users (id),
  deleted_at           timestamptz,
  -- Can't revoke an election before it took effect.
  check (revoked_fy is null or revoked_fy >= election_fy)
);

comment on table public.family_trust_elections is
  'Family Trust / Interposed Entity Elections per trust (SC-5.A.02). FTE names a '
  'test individual and underpins the trust-loss measures (loss-test scope of '
  'SC-34); IEE joins an entity to the family group. The loss-test itself is a '
  'later read-only RPC, not a table.';

-- One active deed governs each trust; a restatement soft-deletes the prior row.
create unique index trust_deed_one_active_per_trust
  on public.trust_deed (trust_id)
  where deleted_at is null;

-- Deeds listed per trust (org-first so the index also serves org-wide listing).
create index trust_deed_org_trust_idx
  on public.trust_deed (organization_id, trust_id)
  where deleted_at is null;

-- Elections listed per trust (org-first, as above).
create index family_trust_elections_org_trust_idx
  on public.family_trust_elections (organization_id, trust_id)
  where deleted_at is null;

create trigger trust_deed_set_updated_at
  before update on public.trust_deed
  for each row execute function public.set_updated_at();
create trigger trust_deed_audit
  after insert or update or delete on public.trust_deed
  for each row execute function public.audit_log_trigger_v2();

create trigger family_trust_elections_set_updated_at
  before update on public.family_trust_elections
  for each row execute function public.set_updated_at();
create trigger family_trust_elections_audit
  after insert or update or delete on public.family_trust_elections
  for each row execute function public.audit_log_trigger_v2();

alter table public.trust_deed enable row level security;
alter table public.family_trust_elections enable row level security;

create policy trust_deed_select on public.trust_deed for select
  using (organization_id in (select get_accessible_org_ids()));
create policy trust_deed_insert on public.trust_deed for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy trust_deed_update on public.trust_deed for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy trust_deed_delete on public.trust_deed for delete
  using (organization_id in (select get_accessible_org_ids()));

create policy family_trust_elections_select on public.family_trust_elections for select
  using (organization_id in (select get_accessible_org_ids()));
create policy family_trust_elections_insert on public.family_trust_elections for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy family_trust_elections_update on public.family_trust_elections for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy family_trust_elections_delete on public.family_trust_elections for delete
  using (organization_id in (select get_accessible_org_ids()));

grant select, insert, update, delete on public.trust_deed to authenticated;
grant select, insert, update, delete on public.family_trust_elections to authenticated;
