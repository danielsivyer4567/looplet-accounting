-- 20260702123000_orchestrator_engine_dispatch.sql
--
-- Durable engine-dispatch artifacts for accountant-orchestrator.
--
-- The orchestrator can run from cron/service context, so draft creation cannot
-- depend on auth.uid() being a browser user. This migration adds:
--   * compliance_drafts: durable draft/evidence rows written by service dispatch.
--   * request_system_approval: service_role-only approval opener with requested_by
--     NULL, still hash-bound and pending for Tier-2 actions.
--   * prepare_bas_lodgement_draft_system: service_role-only BAS draft handoff that
--     creates/reuses a lodgement draft and opens a pending BAS approval. It does
--     not lodge or transmit anything.

create table if not exists public.compliance_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  engine text not null,
  action text not null,
  draft_type text not null,
  period_label text,
  source text not null default 'accountant_orchestrator',
  source_key text not null,
  resource_type text,
  resource_id uuid,
  status text not null default 'draft'
    check (status in ('draft', 'needs_review', 'blocked', 'superseded')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  deleted_at timestamptz
);

comment on table public.compliance_drafts is
  'Durable draft/evidence artifacts created by accountant-orchestrator engine dispatch. '
  'Rows are drafts only; lodgement, payment, send and registered-agent sign-off remain '
  'behind approvals and external legal gates.';

create unique index if not exists compliance_drafts_org_source_key_uniq
  on public.compliance_drafts (organization_id, source_key);

create index if not exists compliance_drafts_org_status_idx
  on public.compliance_drafts (organization_id, status, created_at desc)
  where deleted_at is null;

drop trigger if exists compliance_drafts_set_updated_at on public.compliance_drafts;
create trigger compliance_drafts_set_updated_at
  before update on public.compliance_drafts
  for each row execute function public.set_updated_at();

alter table public.compliance_drafts enable row level security;

drop policy if exists compliance_drafts_select on public.compliance_drafts;
create policy compliance_drafts_select on public.compliance_drafts
  for select to authenticated
  using (organization_id in (select public.get_accessible_org_ids()));

revoke all on public.compliance_drafts from public, anon, authenticated;
grant select on public.compliance_drafts to authenticated;
grant select, insert, update, delete on public.compliance_drafts to service_role;

create or replace function public.request_system_approval(
  p_org uuid,
  p_resource_type text,
  p_resource_id uuid,
  p_risk_tier public.approval_risk_tier,
  p_payload jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text;
  v_status public.approval_status;
  v_id uuid;
begin
  if not exists (
    select 1
      from public.organizations o
     where o.id = p_org
       and o.deleted_at is null
  ) then
    raise exception 'organization not found or deleted';
  end if;

  v_hash := encode(extensions.digest(p_payload::text, 'sha256'), 'hex');

  select a.id
    into v_id
    from public.approvals a
   where a.organization_id = p_org
     and a.resource_type = p_resource_type
     and a.resource_id = p_resource_id
     and a.payload_hash = v_hash
     and a.deleted_at is null;
  if v_id is not null then
    return v_id;
  end if;

  v_status := case when p_risk_tier = 'tier2_approve'
    then 'pending'::public.approval_status
    else 'approved'::public.approval_status
  end;

  begin
    insert into public.approvals (
      organization_id,
      risk_tier,
      status,
      resource_type,
      resource_id,
      payload_hash,
      requested_by,
      requested_at,
      created_by,
      resolved_at
    ) values (
      p_org,
      p_risk_tier,
      v_status,
      p_resource_type,
      p_resource_id,
      v_hash,
      null,
      now(),
      null,
      case when v_status = 'approved' then now() else null end
    )
    returning id into v_id;
  exception when unique_violation then
    select a.id
      into v_id
      from public.approvals a
     where a.organization_id = p_org
       and a.resource_type = p_resource_type
       and a.resource_id = p_resource_id
       and a.payload_hash = v_hash
       and a.deleted_at is null;
  end;

  return v_id;
end;
$$;

comment on function public.request_system_approval(
  uuid, text, uuid, public.approval_risk_tier, jsonb
) is
  'Service-role-only variant of request_approval for cron/orchestrator draft generation. '
  'It is still content-hash bound and leaves Tier-2 actions pending for a human approver; '
  'requested_by/created_by are NULL to show the request was system-opened.';

create or replace function public.prepare_bas_lodgement_draft_system(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_payload_hash text;
  v_period_label text;
  v_lodgement_id uuid;
  v_approval_id uuid;
begin
  if not exists (
    select 1
      from public.organizations o
     where o.id = p_org
       and o.deleted_at is null
  ) then
    raise exception 'organization not found or deleted';
  end if;

  if p_quarter not between 1 and 4 then
    raise exception 'p_quarter must be between 1 and 4';
  end if;

  v_payload := public.generate_bas_worksheet(p_org, p_fy_start_year, p_quarter);
  if v_payload is null then
    raise exception 'generate_bas_worksheet returned no payload';
  end if;

  v_period_label := format(
    'Q%s FY%s-%s',
    p_quarter,
    p_fy_start_year,
    right((p_fy_start_year + 1)::text, 2)
  );
  v_payload_hash := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');

  begin
    insert into public.lodgements (
      organization_id,
      lodgement_type,
      period_label,
      payload_hash,
      payload,
      status,
      created_by
    ) values (
      p_org,
      'bas'::public.lodgement_type,
      v_period_label,
      v_payload_hash,
      v_payload,
      'draft'::public.lodgement_status,
      null
    )
    returning id into v_lodgement_id;
  exception when unique_violation then
    select l.id
      into v_lodgement_id
      from public.lodgements l
     where l.organization_id = p_org
       and l.lodgement_type = 'bas'::public.lodgement_type
       and l.period_label = v_period_label
       and l.payload_hash = v_payload_hash
     order by l.created_at desc
     limit 1;
  end;

  if v_lodgement_id is null then
    raise exception 'could not create or find BAS lodgement draft';
  end if;

  v_approval_id := public.request_system_approval(
    p_org,
    'bas_lodgement',
    v_lodgement_id,
    'tier2_approve'::public.approval_risk_tier,
    v_payload
  );

  return jsonb_build_object(
    'lodgement_id', v_lodgement_id,
    'approval_id', v_approval_id,
    'lodgement_type', 'bas',
    'period_label', v_period_label,
    'payload_hash', v_payload_hash,
    'status', 'draft'
  );
end;
$$;

comment on function public.prepare_bas_lodgement_draft_system(uuid, integer, integer) is
  'Service-role-only BAS draft handoff for accountant-orchestrator. Creates/reuses a '
  'draft lodgement from generate_bas_worksheet and opens a pending system approval. '
  'Does not lodge or transmit to the ATO.';

grant execute on function public.generate_super_batch(uuid, integer, integer) to service_role;
grant execute on function public.build_return(uuid, integer) to service_role;
grant execute on function public.book_to_tax(uuid, integer) to service_role;
grant execute on function public.generate_eofy_pack(uuid, integer) to service_role;
grant execute on function public.generate_workcover_declaration(uuid, integer) to service_role;
grant execute on function public.smsf_tbc_tbar(uuid, integer, uuid) to service_role;
grant execute on function public.stream_trust_distribution(uuid, integer, uuid) to service_role;
grant execute on function public.div7a_breach_scan(uuid, date) to service_role;
grant execute on function public.cgt_calc(uuid, integer) to service_role;
grant execute on function public.asic_form484_draft(uuid, timestamptz) to service_role;

revoke all on function public.request_system_approval(
  uuid, text, uuid, public.approval_risk_tier, jsonb
) from public, anon, authenticated;
revoke all on function public.prepare_bas_lodgement_draft_system(
  uuid, integer, integer
) from public, anon, authenticated;
grant execute on function public.request_system_approval(
  uuid, text, uuid, public.approval_risk_tier, jsonb
) to service_role;
grant execute on function public.prepare_bas_lodgement_draft_system(
  uuid, integer, integer
) to service_role;

notify pgrst, 'reload schema';
