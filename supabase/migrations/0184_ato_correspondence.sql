-- 0184_ato_correspondence.sql - SC-7.H.01 (ATO correspondence model)
--
-- Stores received ATO notices/correspondence and drafted responses. This is a
-- durable prep-and-review model only: no sending, no lodgement, and no transport.
-- SC-7.H.02 builds draft text on top and the send path remains approval-gated.
--
-- MIGRATION NUMBER: ledger planned 0176, but 0176-0183 are already assigned.
-- Reassigned to 0184 per the drift rule; sequential repo head is 0183.

create table public.ato_correspondence (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  -- ATO correspondence/notice categories are open-ended, so this stays free text.
  notice_type        text not null check (length(btrim(notice_type)) > 0),
  subject            text,
  ato_reference      text,
  received_at        timestamptz not null default now(),
  due_date           date,
  -- Flexible pointer to the stored notice/source document, for example:
  -- {"bucket":"bills","storage_key":"org-x/notice.pdf","sha256":"..."}.
  source_doc_ref     jsonb not null default '{}'::jsonb check (jsonb_typeof(source_doc_ref) = 'object'),
  status             text not null default 'received'
                       check (status in ('received', 'in_review', 'drafted', 'responded', 'closed')),
  details            jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references auth.users (id),
  deleted_at         timestamptz
);

comment on table public.ato_correspondence is
  'ATO notices/correspondence received by an organization (SC-7.H.01). Stores notice type, '
  'received/due dates, a source document reference, workflow status, and structured details. '
  'Drafting/responding is separate and approval-gated before any send.';

create table public.ato_correspondence_drafts (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  correspondence_id  uuid not null references public.ato_correspondence (id) on delete cascade,
  draft_type         text not null default 'response'
                       check (draft_type in ('response', 'objection', 'review_request', 'payment_plan', 'note')),
  subject            text not null check (length(btrim(subject)) > 0),
  body               text not null check (length(btrim(body)) > 0),
  evidence           jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  status             text not null default 'draft'
                       check (status in ('draft', 'ready_for_review', 'approved', 'sent', 'superseded')),
  approval_id        uuid references public.approvals (id) on delete set null,
  sent_at            timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references auth.users (id),
  deleted_at         timestamptz,
  constraint ato_correspondence_drafts_approved_requires_approval
    check (status not in ('approved', 'sent') or approval_id is not null),
  constraint ato_correspondence_drafts_sent_at_matches_status
    check ((status = 'sent' and sent_at is not null) or (status <> 'sent' and sent_at is null))
);

comment on table public.ato_correspondence_drafts is
  'Draft response/objection/review text for ATO correspondence (SC-7.H.01). Evidence is a '
  'jsonb array of source links. Sending is not implemented here; sent/approved states require '
  'an approval_id for the Phase-7 approve-to-send gate.';

create index ato_correspondence_org_status_idx
  on public.ato_correspondence (organization_id, status, received_at desc)
  where deleted_at is null;

create index ato_correspondence_org_notice_idx
  on public.ato_correspondence (organization_id, notice_type, received_at desc)
  where deleted_at is null;

create index ato_correspondence_drafts_org_parent_idx
  on public.ato_correspondence_drafts (organization_id, correspondence_id, status, created_at desc)
  where deleted_at is null;

create index ato_correspondence_drafts_org_status_idx
  on public.ato_correspondence_drafts (organization_id, status, created_at desc)
  where deleted_at is null;

create or replace function public.ato_correspondence_draft_org_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_correspondence_org uuid;
  v_approval_org uuid;
begin
  select c.organization_id
    into v_correspondence_org
    from public.ato_correspondence c
   where c.id = new.correspondence_id
     and c.deleted_at is null;

  if v_correspondence_org is null then
    raise exception 'ato_correspondence_drafts.correspondence_id % does not reference an active correspondence row', new.correspondence_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_correspondence_org is distinct from new.organization_id then
    raise exception 'ato_correspondence_drafts organization_id must match parent correspondence organization_id'
      using errcode = 'check_violation';
  end if;

  if new.approval_id is not null then
    select a.organization_id
      into v_approval_org
      from public.approvals a
     where a.id = new.approval_id
       and a.deleted_at is null;

    if v_approval_org is null then
      raise exception 'ato_correspondence_drafts.approval_id % does not reference an active approval row', new.approval_id
        using errcode = 'foreign_key_violation';
    end if;

    if v_approval_org is distinct from new.organization_id then
      raise exception 'ato_correspondence_drafts organization_id must match approval organization_id'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger ato_correspondence_draft_org_guard
  before insert or update of organization_id, correspondence_id, approval_id on public.ato_correspondence_drafts
  for each row execute function public.ato_correspondence_draft_org_guard();

create trigger ato_correspondence_set_updated_at
  before update on public.ato_correspondence
  for each row execute function public.set_updated_at();

create trigger ato_correspondence_audit
  after insert or update or delete on public.ato_correspondence
  for each row execute function public.audit_log_trigger_v2();

create trigger ato_correspondence_drafts_set_updated_at
  before update on public.ato_correspondence_drafts
  for each row execute function public.set_updated_at();

create trigger ato_correspondence_drafts_audit
  after insert or update or delete on public.ato_correspondence_drafts
  for each row execute function public.audit_log_trigger_v2();

alter table public.ato_correspondence enable row level security;
alter table public.ato_correspondence_drafts enable row level security;

create policy ato_correspondence_select on public.ato_correspondence for select
  using (organization_id in (select get_accessible_org_ids()));
create policy ato_correspondence_insert on public.ato_correspondence for insert
  with check (
    organization_id in (select get_accessible_org_ids())
    and public.require_role(organization_id, 'accountant'::public.org_role)
  );
create policy ato_correspondence_update on public.ato_correspondence for update
  using (
    organization_id in (select get_accessible_org_ids())
    and public.require_role(organization_id, 'accountant'::public.org_role)
  )
  with check (
    organization_id in (select get_accessible_org_ids())
    and public.require_role(organization_id, 'accountant'::public.org_role)
  );
create policy ato_correspondence_delete on public.ato_correspondence for delete
  using (
    organization_id in (select get_accessible_org_ids())
    and public.require_role(organization_id, 'admin'::public.org_role)
  );

create policy ato_correspondence_drafts_select on public.ato_correspondence_drafts for select
  using (organization_id in (select get_accessible_org_ids()));
create policy ato_correspondence_drafts_insert on public.ato_correspondence_drafts for insert
  with check (
    organization_id in (select get_accessible_org_ids())
    and public.require_role(organization_id, 'accountant'::public.org_role)
  );
create policy ato_correspondence_drafts_update on public.ato_correspondence_drafts for update
  using (
    organization_id in (select get_accessible_org_ids())
    and public.require_role(organization_id, 'accountant'::public.org_role)
  )
  with check (
    organization_id in (select get_accessible_org_ids())
    and public.require_role(organization_id, 'accountant'::public.org_role)
  );
create policy ato_correspondence_drafts_delete on public.ato_correspondence_drafts for delete
  using (
    organization_id in (select get_accessible_org_ids())
    and public.require_role(organization_id, 'admin'::public.org_role)
  );

revoke all on table public.ato_correspondence from public, anon, authenticated;
revoke all on table public.ato_correspondence_drafts from public, anon, authenticated;
grant select, insert, update, delete on public.ato_correspondence to authenticated;
grant select, insert, update, delete on public.ato_correspondence_drafts to authenticated;

notify pgrst, 'reload schema';
