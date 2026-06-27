-- 0175_advice_notes.sql - SC-6.A.01 (Phase 6, advisory engine artifact model)
--
-- advice_notes is the durable artifact for proactive advisory outputs. Scenario
-- models in Phase 6 write draft notes here; registered-agent sign-off and user
-- actions are separate slices. This table is the legal/quality guardrail anchor:
-- every note carries inputs, numbers, assumptions, citations, a disclaimer, and
-- optional registered-agent sign-off fields.
--
-- House table pattern: org-scoped RLS via get_accessible_org_ids(), audit +
-- updated_at triggers, soft-delete, org-first partial index.
--
-- MIGRATION NUMBER: ledger planned 0167, long taken by SMSF financial position.
-- Reassigned to 0175 per the drift rule: sequential repo head is 0174_asic_form484
-- (0178/0179 are late hotfixes that sort after).

do $$ begin
  create type public.advice_note_kind as enum (
    'structuring',
    'year_end',
    'cgt',
    'fbt',
    'profit_extraction',
    'forecast'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.advice_note_status as enum (
    'draft',
    'issued',
    'acted',
    'dismissed'
  );
exception when duplicate_object then null; end $$;

create table public.advice_notes (
  id                             uuid primary key default gen_random_uuid(),
  organization_id                uuid not null references public.organizations (id) on delete cascade,
  kind                           public.advice_note_kind not null,
  title                          text not null,
  summary                        text not null,
  inputs                         jsonb not null default '{}'::jsonb,
  numbers                        jsonb not null default '{}'::jsonb,
  assumptions                    jsonb not null default '{}'::jsonb,
  citations                      jsonb not null default '[]'::jsonb,
  disclaimer                     text not null default
    'General information only; not tax, legal, or financial advice. Review with a registered agent before acting.',
  registered_agent_signoff_by    uuid references auth.users (id),
  registered_agent_signoff_at    timestamptz,
  status                         public.advice_note_status not null default 'draft',
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  created_by                     uuid references auth.users (id),
  deleted_at                     timestamptz,
  constraint advice_notes_json_shapes
    check (
      jsonb_typeof(inputs) = 'object'
      and jsonb_typeof(numbers) = 'object'
      and jsonb_typeof(assumptions) = 'object'
      and jsonb_typeof(citations) = 'array'
    ),
  constraint advice_notes_signoff_fields_paired
    check ((registered_agent_signoff_by is null) = (registered_agent_signoff_at is null))
);

comment on table public.advice_notes is
  'Phase 6 advisory artifacts. Each note is org-scoped and carries kind, title, summary, '
  'inputs/numbers/assumptions/citations, a disclaimer, workflow status, and optional '
  'registered-agent sign-off fields. Acting on a recommendation remains approval-gated.';

create index advice_notes_org_status_kind_idx
  on public.advice_notes (organization_id, status, kind, created_at desc)
  where deleted_at is null;

create trigger advice_notes_set_updated_at
  before update on public.advice_notes
  for each row execute function public.set_updated_at();

create trigger advice_notes_audit
  after insert or update or delete on public.advice_notes
  for each row execute function public.audit_log_trigger_v2();

alter table public.advice_notes enable row level security;

create policy advice_notes_select on public.advice_notes for select
  using (organization_id in (select get_accessible_org_ids()));
create policy advice_notes_insert on public.advice_notes for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy advice_notes_update on public.advice_notes for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy advice_notes_delete on public.advice_notes for delete
  using (organization_id in (select get_accessible_org_ids()));

grant select, insert, update, delete on public.advice_notes to authenticated;
