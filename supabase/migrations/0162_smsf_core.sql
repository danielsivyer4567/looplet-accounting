-- 0162_smsf_core.sql — SC-5.H.01 (Phase 5, SMSF)
--
-- The first SMSF slice: the two core entity tables for a Self-Managed Super Fund the org
-- administers. TABLES ONLY — investments/contributions/pensions are SC-5.H.02, the
-- member-balance roll-forward / TBC / financials are SC-5.I/5.J.
--
--   smsf_funds   — one row per SMSF the org administers (ABN, TFN, establishment date,
--                  trustee structure: individual trustees vs a corporate trustee — a
--                  fixed legal pair, so a CHECK not an enum).
--   smsf_members — the fund's members. Each carries their role (a member is also a
--                  trustee, or a director of the corporate trustee) and the tax
--                  components of their member balance (tax-free vs taxable), money-in-
--                  cents (BIGINT). The full balance roll-forward is SC-5.I.01; this
--                  records the members + their opening component split.
--
-- Both: org-scoped (RLS via get_accessible_org_ids()), audited, soft-delete +
-- created_at/updated_at/created_by per 0001/0051/0151. The SMSF workspace gating flag is
-- read from business_profile.entity_type='smsf' (NOT a column here).
--
-- ── entity_type CHECK: ALREADY DONE (no ALTER here) ────────────────────────────
-- The ledger's note ("the entity_type CHECK does not allow 'smsf' — ALTER it") is STALE.
-- Verified live (dxoikltymmknxqpkpyhi) and in the repo: business_profile_entity_type_check
-- ALREADY includes 'smsf' — added by 0131_obligation_types_expand (drop+add of the
-- constraint with array['sole_trader','partnership','company','trust','smsf','other']),
-- which is both committed AND deployed. Re-dropping/re-adding it here would duplicate the
-- constraint 0131 owns and risk lineage drift, so this migration does NOT touch it. The
-- SMSF gating flag therefore already works.
--
-- MIGRATION NUMBER: the ledger Files line planned 0154, long taken (trust_net_income).
-- Reassigned to 0162 per the drift rule — the sequential repo head is 0161_div7a_breach
-- (0178/0179 are late hotfixes that sort after). Verified live (read-only): smsf_funds /
-- smsf_members ABSENT (no drift); business_profile/organizations + get_accessible_org_ids/
-- set_updated_at/audit_log_trigger_v2 all present.

create table public.smsf_funds (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  name              text not null,
  abn               text,                              -- nullable: may be unregistered/unknown at entry
  tfn               text,                              -- nullable; sensitive
  establishment_date date,                             -- when the fund was established
  -- Trustee structure: individual trustees, or a corporate trustee. Fixed legal pair => CHECK.
  trustee_structure text not null default 'individual'
                      check (trustee_structure in ('individual', 'corporate')),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references auth.users (id),
  deleted_at        timestamptz
);

comment on table public.smsf_funds is
  'Self-Managed Super Funds an org administers (SC-5.H.01). trustee_structure individual '
  'vs corporate. The SMSF workspace is gated on business_profile.entity_type=''smsf''. '
  'Tables only — investments/contributions/pensions = SC-5.H.02.';

create table public.smsf_members (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations (id) on delete cascade,
  fund_id                  uuid not null references public.smsf_funds (id) on delete cascade,
  name                     text not null,
  -- The member's capacity in the fund. All SMSF members must be trustees (or directors of
  -- the corporate trustee); 'member' covers a member not separately recorded as such.
  role                     text not null default 'member'
                             check (role in ('member', 'trustee', 'director')),
  tfn                      text,                       -- nullable; sensitive
  date_of_birth            date,                       -- drives preservation age / pension eligibility (SC-5.L)
  -- The tax components of the member's balance (tax-free vs taxable), money-in-cents.
  -- The full balance roll-forward is SC-5.I.01; this is the opening component split.
  tax_free_component_cents bigint not null default 0,
  taxable_component_cents  bigint not null default 0,
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid references auth.users (id),
  deleted_at               timestamptz,
  constraint smsf_members_components_non_negative
    check (tax_free_component_cents >= 0 and taxable_component_cents >= 0)
);

comment on table public.smsf_members is
  'Members of an SMSF (SC-5.H.01). role = member/trustee/director (capacity in the fund). '
  'tax_free/taxable_component_cents are the opening tax-component split of the member '
  'balance; the roll-forward is SC-5.I.01.';

-- Funds listed per org (org-first also serves RLS-scoped listing).
create index smsf_funds_org_idx
  on public.smsf_funds (organization_id)
  where deleted_at is null;

-- Members listed per fund (org-first so the index also serves org-wide listing).
create index smsf_members_org_fund_idx
  on public.smsf_members (organization_id, fund_id)
  where deleted_at is null;

create trigger smsf_funds_set_updated_at
  before update on public.smsf_funds
  for each row execute function public.set_updated_at();
create trigger smsf_funds_audit
  after insert or update or delete on public.smsf_funds
  for each row execute function public.audit_log_trigger_v2();

create trigger smsf_members_set_updated_at
  before update on public.smsf_members
  for each row execute function public.set_updated_at();
create trigger smsf_members_audit
  after insert or update or delete on public.smsf_members
  for each row execute function public.audit_log_trigger_v2();

alter table public.smsf_funds enable row level security;
alter table public.smsf_members enable row level security;

create policy smsf_funds_select on public.smsf_funds for select
  using (organization_id in (select get_accessible_org_ids()));
create policy smsf_funds_insert on public.smsf_funds for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy smsf_funds_update on public.smsf_funds for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy smsf_funds_delete on public.smsf_funds for delete
  using (organization_id in (select get_accessible_org_ids()));

create policy smsf_members_select on public.smsf_members for select
  using (organization_id in (select get_accessible_org_ids()));
create policy smsf_members_insert on public.smsf_members for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy smsf_members_update on public.smsf_members for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy smsf_members_delete on public.smsf_members for delete
  using (organization_id in (select get_accessible_org_ids()));

grant select, insert, update, delete on public.smsf_funds to authenticated;
grant select, insert, update, delete on public.smsf_members to authenticated;
