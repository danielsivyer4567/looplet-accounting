-- 0188_fix_organizations_audit_log.sql
--
-- The legacy write_audit_log() trigger from 0001 is still attached to
-- public.organizations. Unlike ordinary tenant tables, organizations is the
-- tenant root and does not have an organization_id column; its id is the
-- organization id. A first-org bootstrap through create_organization_with_owner
-- therefore tried to insert an audit_log row with organization_id = null and
-- failed the audit_log NOT NULL constraint.

create or replace function public.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_record_id uuid;
begin
  v_record_id := coalesce(
    (case when tg_op in ('INSERT', 'UPDATE') then (to_jsonb(new)->>'id') end)::uuid,
    (case when tg_op in ('UPDATE', 'DELETE') then (to_jsonb(old)->>'id') end)::uuid
  );

  v_org_id := case
    when tg_table_name = 'organizations' then v_record_id
    else coalesce(
      (case when tg_op in ('INSERT', 'UPDATE') then (to_jsonb(new)->>'organization_id') end)::uuid,
      (case when tg_op in ('UPDATE', 'DELETE') then (to_jsonb(old)->>'organization_id') end)::uuid
    )
  end;

  insert into public.audit_log (
    organization_id,
    table_name,
    record_id,
    operation,
    actor_user_id,
    before_data,
    after_data
  ) values (
    v_org_id,
    tg_table_name,
    v_record_id,
    tg_op::audit_operation,
    auth.uid(),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );

  return coalesce(new, old);
end;
$$;

comment on function public.write_audit_log() is
  'Legacy audit trigger used by 0001-era tables. Special-cases organizations '
  'because that table is the tenant root and its id is the audit organization_id.';
