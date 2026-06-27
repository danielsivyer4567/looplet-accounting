-- 0176_advice_notes_rpcs.sql - SC-6.A.02 (Phase 6, advice_notes RPC surface)
--
-- Mutating edge functions should use these RPCs instead of raw table writes so
-- advice-note shape, created_by, sign-off stamps, and status transitions stay in
-- one place. The functions are SECURITY DEFINER so edge functions can call a small
-- stable surface, but every function explicitly checks get_accessible_org_ids()
-- against auth.uid() before reading or writing an org's notes.
--
-- MIGRATION NUMBER: ledger planned 0168, long taken by SMSF member statements.
-- Reassigned to 0176 per the drift rule: sequential repo head is 0175_advice_notes
-- (0178/0179 are late hotfixes that sort after).

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
  'SC-6.A.02: creates a draft advice_notes row after checking the caller can access p_org. '
  'Returns a jsonb envelope with advice_note_id. SECURITY DEFINER with explicit org access check.';

comment on function public.list_advice_notes(uuid, public.advice_note_kind, public.advice_note_status) is
  'SC-6.A.02: lists accessible advice notes for an org, optionally filtered by kind/status. '
  'Non-members receive zero rows. SECURITY DEFINER with explicit org access predicate.';

comment on function public.sign_off_advice_note(uuid) is
  'SC-6.A.02: stamps registered_agent_signoff_by/at and flips an accessible note to issued.';

comment on function public.dismiss_advice_note(uuid) is
  'SC-6.A.02: flips an accessible note to dismissed.';

revoke all on function public.create_advice_note(uuid, public.advice_note_kind, text, text, jsonb, jsonb, jsonb, jsonb, text) from public, anon;
revoke all on function public.list_advice_notes(uuid, public.advice_note_kind, public.advice_note_status) from public, anon;
revoke all on function public.sign_off_advice_note(uuid) from public, anon;
revoke all on function public.dismiss_advice_note(uuid) from public, anon;

grant execute on function public.create_advice_note(uuid, public.advice_note_kind, text, text, jsonb, jsonb, jsonb, jsonb, text) to authenticated;
grant execute on function public.list_advice_notes(uuid, public.advice_note_kind, public.advice_note_status) to authenticated;
grant execute on function public.sign_off_advice_note(uuid) to authenticated;
grant execute on function public.dismiss_advice_note(uuid) to authenticated;
