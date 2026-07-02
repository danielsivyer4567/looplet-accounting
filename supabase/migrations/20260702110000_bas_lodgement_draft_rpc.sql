-- 20260702110000_bas_lodgement_draft_rpc.sql
--
-- BAS lodgement draft prep.
--
-- The BAS page previously opened a Tier-2 approval against the organization id.
-- That left no durable lodgement record for the approval to point at, and the
-- Lodgements page stayed empty until a future transport flow existed. This RPC
-- creates/reuses an append-only lodgements draft row for the exact worksheet
-- payload, then opens the Tier-2 approval against that lodgement row.
--
-- Nothing is submitted to the ATO here. Real transport remains gated by the
-- Phase-7 DSP/EVTE/SBR readiness checks.

create or replace function public.prepare_bas_lodgement_draft(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
returns jsonb
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
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if p_org not in (select public.get_accessible_org_ids()) then
    raise exception 'organization not accessible';
  end if;

  if not public.require_role(p_org, 'accountant'::public.org_role) then
    raise exception 'prepare_bas_lodgement_draft: accountant role required for organization %', p_org;
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
      auth.uid()
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

  v_approval_id := public.request_approval(
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

comment on function public.prepare_bas_lodgement_draft(uuid, integer, integer) is
  'Creates/reuses a draft BAS lodgement row for generate_bas_worksheet and opens '
  'a Tier-2 approval against that lodgement id and exact payload. Requires '
  'accountant-or-higher org role. Does not transmit to the ATO; Phase-7 transport '
  'remains DSP/EVTE/SBR-gated.';

revoke all on function public.prepare_bas_lodgement_draft(uuid, integer, integer) from public, anon;
grant execute on function public.prepare_bas_lodgement_draft(uuid, integer, integer) to authenticated;

notify pgrst, 'reload schema';
