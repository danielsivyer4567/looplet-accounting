-- 0194_refresh_advice_notes_rpc.sql
--
-- Repair/refresh migration for environments where PostgREST reports
-- public.advice_notes or public.list_advice_notes as missing from the schema
-- cache. It is intentionally idempotent enough to repair projects where the
-- earlier advice-note migrations were skipped or the PostgREST cache was stale.

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

create table if not exists public.advice_notes (
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

create index if not exists advice_notes_org_status_kind_idx
  on public.advice_notes (organization_id, status, kind, created_at desc)
  where deleted_at is null;

drop trigger if exists advice_notes_set_updated_at on public.advice_notes;
create trigger advice_notes_set_updated_at
  before update on public.advice_notes
  for each row execute function public.set_updated_at();

drop trigger if exists advice_notes_audit on public.advice_notes;
create trigger advice_notes_audit
  after insert or update or delete on public.advice_notes
  for each row execute function public.audit_log_trigger_v2();

alter table public.advice_notes enable row level security;

drop policy if exists advice_notes_select on public.advice_notes;
create policy advice_notes_select on public.advice_notes for select
  using (organization_id in (select get_accessible_org_ids()));

drop policy if exists advice_notes_insert on public.advice_notes;
create policy advice_notes_insert on public.advice_notes for insert
  with check (
    organization_id in (select get_accessible_org_ids())
    and public.require_role(organization_id, 'accountant'::public.org_role)
  );

drop policy if exists advice_notes_update on public.advice_notes;
create policy advice_notes_update on public.advice_notes for update
  using (
    organization_id in (select get_accessible_org_ids())
    and public.require_role(organization_id, 'accountant'::public.org_role)
  )
  with check (
    organization_id in (select get_accessible_org_ids())
    and public.require_role(organization_id, 'accountant'::public.org_role)
  );

drop policy if exists advice_notes_delete on public.advice_notes;
create policy advice_notes_delete on public.advice_notes for delete
  using (
    organization_id in (select get_accessible_org_ids())
    and public.require_role(organization_id, 'admin'::public.org_role)
  );

revoke all on table public.advice_notes from public, anon, authenticated;
grant select on public.advice_notes to authenticated;
grant all on public.advice_notes to service_role;

create or replace function public.create_advice_note(
    p_org uuid,
    p_kind public.advice_note_kind,
    p_title text,
    p_summary text,
    p_inputs jsonb default '{}'::jsonb,
    p_numbers jsonb default '{}'::jsonb,
    p_assumptions jsonb default '{}'::jsonb,
    p_citations jsonb default '[]'::jsonb,
    p_disclaimer text default null)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_org not in (select get_accessible_org_ids()) then
    raise exception 'create_advice_note: organization % not accessible', p_org;
  end if;
  if not public.require_role(p_org, 'accountant'::public.org_role) then
    raise exception 'create_advice_note: accountant role required for organization %', p_org;
  end if;

  insert into public.advice_notes (
    organization_id,
    kind,
    title,
    summary,
    inputs,
    numbers,
    assumptions,
    citations,
    disclaimer,
    created_by
  )
  values (
    p_org,
    p_kind,
    p_title,
    p_summary,
    coalesce(p_inputs, '{}'::jsonb),
    coalesce(p_numbers, '{}'::jsonb),
    coalesce(p_assumptions, '{}'::jsonb),
    coalesce(p_citations, '[]'::jsonb),
    coalesce(
      p_disclaimer,
      'General information only; not tax, legal, or financial advice. Review with a registered agent before acting.'
    ),
    auth.uid()
  )
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'advice_note_id', v_id,
    'organization_id', p_org,
    'kind', p_kind,
    'status', 'draft'
  );
end;
$$;

create or replace function public.list_advice_notes(
    p_org uuid,
    p_kind public.advice_note_kind default null,
    p_status public.advice_note_status default null)
  returns setof public.advice_notes
  language sql
  stable
  security definer
  set search_path = public
as $$
  select n.*
  from public.advice_notes n
  where n.organization_id = p_org
    and p_org in (select get_accessible_org_ids())
    and n.deleted_at is null
    and (p_kind is null or n.kind = p_kind)
    and (p_status is null or n.status = p_status)
  order by n.created_at desc, n.id;
$$;

create or replace function public.sign_off_advice_note(p_id uuid)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org
  from public.advice_notes
  where id = p_id
    and deleted_at is null;

  if v_org is null then
    raise exception 'sign_off_advice_note: note % not found', p_id;
  end if;
  if v_org not in (select get_accessible_org_ids()) then
    raise exception 'sign_off_advice_note: note % not accessible', p_id;
  end if;
  if not public.require_role(v_org, 'accountant'::public.org_role) then
    raise exception 'sign_off_advice_note: accountant role required for note %', p_id;
  end if;

  update public.advice_notes
     set registered_agent_signoff_by = auth.uid(),
         registered_agent_signoff_at = now(),
         status = 'issued'
   where id = p_id;

  return jsonb_build_object(
    'ok', true,
    'advice_note_id', p_id,
    'organization_id', v_org,
    'status', 'issued'
  );
end;
$$;

create or replace function public.dismiss_advice_note(p_id uuid)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org
  from public.advice_notes
  where id = p_id
    and deleted_at is null;

  if v_org is null then
    raise exception 'dismiss_advice_note: note % not found', p_id;
  end if;
  if v_org not in (select get_accessible_org_ids()) then
    raise exception 'dismiss_advice_note: note % not accessible', p_id;
  end if;
  if not public.require_role(v_org, 'accountant'::public.org_role) then
    raise exception 'dismiss_advice_note: accountant role required for note %', p_id;
  end if;

  update public.advice_notes
     set status = 'dismissed'
   where id = p_id;

  return jsonb_build_object(
    'ok', true,
    'advice_note_id', p_id,
    'organization_id', v_org,
    'status', 'dismissed'
  );
end;
$$;

comment on function public.create_advice_note(uuid, public.advice_note_kind, text, text, jsonb, jsonb, jsonb, jsonb, text) is
  'SC-6.A.02 repair: creates a draft advice_notes row after checking the caller can access p_org. '
  'Requires accountant-or-higher org role. Returns a jsonb envelope with advice_note_id. '
  'SECURITY DEFINER with explicit org access and role checks.';

comment on function public.list_advice_notes(uuid, public.advice_note_kind, public.advice_note_status) is
  'SC-6.A.02 repair: lists accessible advice notes for an org, optionally filtered by kind/status. '
  'Non-members receive zero rows. SECURITY DEFINER with explicit org access predicate.';

comment on function public.sign_off_advice_note(uuid) is
  'SC-6.A.02 repair: stamps registered_agent_signoff_by/at and flips an accessible note to issued. '
  'Requires accountant-or-higher org role.';

comment on function public.dismiss_advice_note(uuid) is
  'SC-6.A.02 repair: flips an accessible note to dismissed. Requires accountant-or-higher org role.';

revoke all on function public.create_advice_note(uuid, public.advice_note_kind, text, text, jsonb, jsonb, jsonb, jsonb, text) from public, anon;
revoke all on function public.list_advice_notes(uuid, public.advice_note_kind, public.advice_note_status) from public, anon;
revoke all on function public.sign_off_advice_note(uuid) from public, anon;
revoke all on function public.dismiss_advice_note(uuid) from public, anon;

grant execute on function public.create_advice_note(uuid, public.advice_note_kind, text, text, jsonb, jsonb, jsonb, jsonb, text) to authenticated;
grant execute on function public.list_advice_notes(uuid, public.advice_note_kind, public.advice_note_status) to authenticated;
grant execute on function public.sign_off_advice_note(uuid) to authenticated;
grant execute on function public.dismiss_advice_note(uuid) to authenticated;

notify pgrst, 'reload schema';
