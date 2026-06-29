-- 0181_lodgements.sql - SC-7.A.01 (Phase 7, lodgements ledger)
--
-- Foundation ledger for ATO/SBR lodgements. This is append-only for payload
-- identity and record existence: rows cannot be deleted, payload fields cannot
-- be rewritten, and only a narrow forward status/receipt/fault transition is
-- allowed after insert.
--
-- MIGRATION NUMBER: ledger planned 0171, long taken by SMSF pension drawdown.
-- Reassigned to 0181 per the drift rule: sequential repo head is 0180_advisor_cron
-- (0178/0179 are late hotfixes already in the chain).

do $$ begin
  create type public.lodgement_type as enum (
    'bas',
    'stp',
    'tpar',
    'return',
    'fbt',
    'tbar'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.lodgement_status as enum (
    'draft',
    'queued',
    'submitted',
    'accepted',
    'rejected',
    'error'
  );
exception when duplicate_object then null; end $$;

create table public.lodgements (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  lodgement_type     public.lodgement_type not null,
  period_label       text not null check (length(btrim(period_label)) > 0),
  payload_hash       text not null check (length(btrim(payload_hash)) > 0),
  payload            jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  ato_receipt_id     text,
  status             public.lodgement_status not null default 'draft',
  submitted_at       timestamptz,
  response           jsonb not null default '{}'::jsonb check (jsonb_typeof(response) = 'object'),
  error_message      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references auth.users (id)
);

comment on table public.lodgements is
  'Phase 7 ATO/SBR lodgement ledger. Payload identity is immutable after insert; '
  'only forward status/receipt/fault transitions are permitted. Real lodgement '
  'transport remains gated on DSP/OSF onboarding and Tier-2 approval.';

create unique index lodgements_payload_once_idx
  on public.lodgements (organization_id, lodgement_type, period_label, payload_hash);

create index lodgements_org_type_period_idx
  on public.lodgements (organization_id, lodgement_type, period_label, created_at desc);

create index lodgements_org_status_idx
  on public.lodgements (organization_id, status, created_at desc);

create or replace function public.lodgements_guard_transition()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_allowed_new boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'DELETE on append-only table lodgements is forbidden'
      using errcode = 'insufficient_privilege';
  end if;

  if (
    to_jsonb(new) - array[
      'status',
      'submitted_at',
      'ato_receipt_id',
      'response',
      'error_message',
      'updated_at'
    ]::text[]
  ) is distinct from (
    to_jsonb(old) - array[
      'status',
      'submitted_at',
      'ato_receipt_id',
      'response',
      'error_message',
      'updated_at'
    ]::text[]
  ) then
    raise exception 'lodgements immutable fields cannot be updated'
      using errcode = 'insufficient_privilege';
  end if;

  if new.status is distinct from old.status then
    v_allowed_new := case old.status::text
      when 'draft' then new.status::text in ('queued', 'submitted', 'error')
      when 'queued' then new.status::text in ('submitted', 'error')
      when 'submitted' then new.status::text in ('accepted', 'rejected', 'error')
      else false
    end;

    if not v_allowed_new then
      raise exception 'invalid lodgement status transition: % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;
  end if;

  if old.ato_receipt_id is not null and new.ato_receipt_id is distinct from old.ato_receipt_id then
    raise exception 'lodgements ato_receipt_id is immutable once set'
      using errcode = 'insufficient_privilege';
  end if;

  if new.ato_receipt_id is not null and new.status = 'draft' then
    raise exception 'lodgements ato_receipt_id cannot be set while status is draft'
      using errcode = 'check_violation';
  end if;

  if old.submitted_at is not null and new.submitted_at is distinct from old.submitted_at then
    raise exception 'lodgements submitted_at is immutable once set'
      using errcode = 'insufficient_privilege';
  end if;

  if old.response <> '{}'::jsonb and new.response is distinct from old.response then
    raise exception 'lodgements response is immutable once set'
      using errcode = 'insufficient_privilege';
  end if;

  if old.error_message is not null and new.error_message is distinct from old.error_message then
    raise exception 'lodgements error_message is immutable once set'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger lodgements_guard_transition
  before update or delete on public.lodgements
  for each row execute function public.lodgements_guard_transition();

create trigger lodgements_set_updated_at
  before update on public.lodgements
  for each row execute function public.set_updated_at();

create trigger lodgements_audit
  after insert or update or delete on public.lodgements
  for each row execute function public.audit_log_trigger_v2();

alter table public.lodgements enable row level security;

create policy lodgements_select on public.lodgements for select
  using (organization_id in (select get_accessible_org_ids()));

create policy lodgements_insert on public.lodgements for insert
  with check (
    organization_id in (select get_accessible_org_ids())
    and public.require_role(organization_id, 'accountant'::public.org_role)
  );

create policy lodgements_update on public.lodgements for update
  using (
    organization_id in (select get_accessible_org_ids())
    and public.require_role(organization_id, 'accountant'::public.org_role)
  )
  with check (
    organization_id in (select get_accessible_org_ids())
    and public.require_role(organization_id, 'accountant'::public.org_role)
  );

create policy lodgements_delete on public.lodgements for delete
  using (
    organization_id in (select get_accessible_org_ids())
    and public.require_role(organization_id, 'admin'::public.org_role)
  );

revoke all on table public.lodgements from public, anon, authenticated;
grant select, insert, update, delete on public.lodgements to authenticated;
