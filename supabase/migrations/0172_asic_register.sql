-- 0172_asic_register.sql — SC-5.P.01 (Phase 5, ASIC company register)
--
-- The ASIC statutory registers a company must maintain, plus a log of ASIC form lodgements:
--   company_officers — directors & secretaries (appointment/cessation, Director ID).
--   share_register   — members' shareholdings (class, number, paid/unpaid amounts).
--   asic_filings     — a record of ASIC forms lodged (e.g. Form 484 change of details).
-- Tables only; the Form 484 change-detection RPC is SC-5.P.02. The ASIC workspace is gated on
-- business_profile.entity_type='company' (already a permitted CHECK value — no 0051 ALTER).
--
-- House table pattern: org-scoped RLS via get_accessible_org_ids(), audit_log_trigger_v2() +
-- set_updated_at() triggers, soft-delete (deleted_at), money-in-cents BIGINT, CHECK for the small
-- closed legal sets (officer role, filing status), org-first partial indexes WHERE deleted_at IS
-- NULL. Mirrors the SMSF core (0162).
--
-- MIGRATION NUMBER: the ledger Files line planned 0164, long taken. Reassigned to 0172 per the
-- drift rule — the sequential repo head is 0171_smsf_pension_drawdown (0178/0179 are late hotfixes
-- that sort after). Verified live (read-only): company_officers / share_register / asic_filings
-- all ABSENT (no drift); this ASIC chain is repo-only (deploys with the Phase-5 backlog).

-- ── Directors & secretaries ────────────────────────────────────────────────────
create table public.company_officers (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  name               text not null,
  -- The officer's role. Fixed legal set for the ASIC register => CHECK (not an enum).
  role               text not null check (role in ('director', 'secretary')),
  -- Director Identification Number (ABRS DIN). Nullable: secretaries don't have one, and a
  -- director's may be unknown at entry.
  director_id        text,
  appointment_date   date,
  -- Null while the officer is current; set when they cease.
  cessation_date     date,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references auth.users (id),
  deleted_at         timestamptz,
  -- A cessation can't predate the appointment.
  constraint company_officers_dates_ordered
    check (cessation_date is null or appointment_date is null or cessation_date >= appointment_date)
);

comment on table public.company_officers is
  'ASIC register of directors & secretaries (SC-5.P.01). role = director/secretary; director_id '
  'is the ABRS Director ID (nullable). cessation_date null = current. Gated on '
  'business_profile.entity_type=''company''.';

-- ── Share register ─────────────────────────────────────────────────────────────
create table public.share_register (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  -- The member (shareholder). A free-text holder name at this phase (no separate members table).
  member_name        text not null,
  -- Share class (e.g. 'ORD', 'A', 'PREF'). Free text — classes are company-defined, not a fixed set.
  share_class        text not null default 'ORD',
  -- Number of shares held in this class.
  number_held        bigint not null default 0 check (number_held >= 0),
  -- Amounts in cents: total paid up vs unpaid (issued but not yet paid) on the holding.
  amount_paid_cents   bigint not null default 0 check (amount_paid_cents >= 0),
  amount_unpaid_cents bigint not null default 0 check (amount_unpaid_cents >= 0),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references auth.users (id),
  deleted_at         timestamptz
);

comment on table public.share_register is
  'ASIC share register (SC-5.P.01): a member''s holding by share class — number_held + paid/unpaid '
  'amounts (money-in-cents). share_class is company-defined free text. Gated on '
  'business_profile.entity_type=''company''.';

-- ── ASIC filings log ───────────────────────────────────────────────────────────
create table public.asic_filings (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  -- The ASIC form lodged (e.g. '484' change of details, '201' registration). Free text — the
  -- ASIC form catalogue is large and open-ended, so not a CHECK.
  form_type          text not null,
  -- Lodgement workflow status. Fixed closed set => CHECK. 'draft' until prepared, 'lodged' once
  -- sent (real lodgement is Phase 7), 'accepted'/'rejected' on the ASIC response.
  status             text not null default 'draft'
                       check (status in ('draft', 'lodged', 'accepted', 'rejected')),
  -- Null until lodged.
  lodgement_date     date,
  -- Free-form payload/reference for the form (e.g. the change set) — structured later.
  details            jsonb not null default '{}'::jsonb,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references auth.users (id),
  deleted_at         timestamptz,
  -- A lodged/accepted/rejected filing must carry its lodgement date; a draft must not.
  constraint asic_filings_lodgement_date_matches_status
    check ((status = 'draft' and lodgement_date is null)
           or (status <> 'draft' and lodgement_date is not null))
);

comment on table public.asic_filings is
  'ASIC form lodgement log (SC-5.P.01): form_type (e.g. 484), status draft/lodged/accepted/'
  'rejected, lodgement_date (null until lodged), details jsonb. Real lodgement is Phase 7; this '
  'records the workflow. Gated on business_profile.entity_type=''company''.';

-- ── Indexes (org-first partial, so they also serve org-scoped listing) ──────────
create index company_officers_org_idx on public.company_officers (organization_id) where deleted_at is null;
create index share_register_org_idx   on public.share_register   (organization_id) where deleted_at is null;
create index asic_filings_org_idx      on public.asic_filings      (organization_id) where deleted_at is null;

-- ── Triggers (updated_at + audit) ──────────────────────────────────────────────
create trigger company_officers_set_updated_at before update on public.company_officers
  for each row execute function public.set_updated_at();
create trigger company_officers_audit after insert or update or delete on public.company_officers
  for each row execute function public.audit_log_trigger_v2();

create trigger share_register_set_updated_at before update on public.share_register
  for each row execute function public.set_updated_at();
create trigger share_register_audit after insert or update or delete on public.share_register
  for each row execute function public.audit_log_trigger_v2();

create trigger asic_filings_set_updated_at before update on public.asic_filings
  for each row execute function public.set_updated_at();
create trigger asic_filings_audit after insert or update or delete on public.asic_filings
  for each row execute function public.audit_log_trigger_v2();

-- ── RLS (org-scoped via get_accessible_org_ids) ────────────────────────────────
alter table public.company_officers enable row level security;
alter table public.share_register   enable row level security;
alter table public.asic_filings      enable row level security;

create policy company_officers_select on public.company_officers for select
  using (organization_id in (select get_accessible_org_ids()));
create policy company_officers_insert on public.company_officers for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy company_officers_update on public.company_officers for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy company_officers_delete on public.company_officers for delete
  using (organization_id in (select get_accessible_org_ids()));

create policy share_register_select on public.share_register for select
  using (organization_id in (select get_accessible_org_ids()));
create policy share_register_insert on public.share_register for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy share_register_update on public.share_register for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy share_register_delete on public.share_register for delete
  using (organization_id in (select get_accessible_org_ids()));

create policy asic_filings_select on public.asic_filings for select
  using (organization_id in (select get_accessible_org_ids()));
create policy asic_filings_insert on public.asic_filings for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy asic_filings_update on public.asic_filings for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy asic_filings_delete on public.asic_filings for delete
  using (organization_id in (select get_accessible_org_ids()));

grant select, insert, update, delete on public.company_officers to authenticated;
grant select, insert, update, delete on public.share_register   to authenticated;
grant select, insert, update, delete on public.asic_filings      to authenticated;
