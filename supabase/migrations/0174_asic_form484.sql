-- 0174_asic_form484.sql - SC-5.P.03 (Phase 5, ASIC Form 484 draft payload)
--
-- asic_form484_draft(org[, since]) generates a structured draft Form 484 payload
-- from the ASIC registers added in 0172 and records it in asic_filings as a draft.
-- Real lodgement to ASIC is Phase 7; this function only prepares the change set.
--
-- Change-detection source of truth:
--   * company_officers.updated_at > since for officer appointments/cessations/updates.
--   * share_register.updated_at > since for shareholding updates.
--   * address_changes is deliberately []: this schema has no company registered-
--     office/principal-place address table yet, so the RPC must not invent one.
--
-- If p_since is null, the function uses the latest lodged/accepted Form 484 filing
-- timestamp for the org; if none exists, it drafts all current register rows. Existing
-- live draft 484 filings are soft-deleted only when a non-empty new draft is written,
-- so repeated generation converges without touching lodged/accepted history.
--
-- SECURITY INVOKER + VOLATILE: reads and writes are scoped by the underlying table
-- RLS policies (organization_id in get_accessible_org_ids()). The function refuses
-- non-company profiles and returns an empty draft without writing when no changes are
-- detected.
--
-- MIGRATION NUMBER: ledger planned 0166, long taken by SMSF operating statement.
-- Reassigned to 0174 per the drift rule: sequential repo head is 0173_asic_obligation
-- (0178/0179 are late hotfixes that sort after).

create or replace function public.asic_form484_draft(
    p_org uuid,
    p_since timestamptz default null)
  returns jsonb
  language plpgsql
  volatile
  security invoker
  set search_path = public
as $$
declare
  v_entity          text;
  v_since           timestamptz;
  v_generated_at    timestamptz := now();
  v_officer_changes jsonb := '[]'::jsonb;
  v_share_changes   jsonb := '[]'::jsonb;
  v_change_count    integer := 0;
  v_replaced        integer := 0;
  v_filing_id       uuid;
  v_payload         jsonb;
begin
  select bp.entity_type
    into v_entity
    from public.business_profile bp
   where bp.organization_id = p_org;

  if v_entity is distinct from 'company' then
    return jsonb_build_object(
      'ok', false,
      'organization_id', p_org,
      'form_type', '484',
      'status', 'not_written',
      'change_count', 0,
      'filing_id', null,
      'error', case when v_entity is null then 'no_company_business_profile' else 'not_company' end
    );
  end if;

  select coalesce(
    p_since,
    (
      select max(greatest(f.created_at, coalesce(f.lodgement_date::timestamptz, f.created_at)))
      from public.asic_filings f
      where f.organization_id = p_org
        and f.form_type = '484'
        and f.status in ('lodged', 'accepted')
        and f.deleted_at is null
    ),
    '-infinity'::timestamptz
  )
  into v_since;

  select coalesce(jsonb_agg(jsonb_build_object(
    'change_type',
      case
        when co.cessation_date is not null then 'officer_cessation'
        when co.created_at > v_since and co.appointment_date is not null then 'officer_appointment'
        else 'officer_update'
      end,
    'officer_id', co.id,
    'name', co.name,
    'role', co.role,
    'director_id', co.director_id,
    'appointment_date', co.appointment_date,
    'cessation_date', co.cessation_date,
    'changed_at', co.updated_at
  ) order by co.updated_at, co.id), '[]'::jsonb)
  into v_officer_changes
  from public.company_officers co
  where co.organization_id = p_org
    and co.deleted_at is null
    and co.updated_at > v_since;

  select coalesce(jsonb_agg(jsonb_build_object(
    'change_type', 'shareholding_update',
    'shareholding_id', sr.id,
    'member_name', sr.member_name,
    'share_class', sr.share_class,
    'number_held', sr.number_held,
    'amount_paid_cents', sr.amount_paid_cents,
    'amount_unpaid_cents', sr.amount_unpaid_cents,
    'changed_at', sr.updated_at
  ) order by sr.updated_at, sr.id), '[]'::jsonb)
  into v_share_changes
  from public.share_register sr
  where sr.organization_id = p_org
    and sr.deleted_at is null
    and sr.updated_at > v_since;

  v_change_count := jsonb_array_length(v_officer_changes) + jsonb_array_length(v_share_changes);

  v_payload := jsonb_build_object(
    'ok', true,
    'organization_id', p_org,
    'form_type', '484',
    'status', 'draft',
    'generated_at', v_generated_at,
    'since', nullif(v_since, '-infinity'::timestamptz),
    'change_count', v_change_count,
    'officer_changes', v_officer_changes,
    'share_changes', v_share_changes,
    'address_changes', '[]'::jsonb,
    'caveats', jsonb_build_array(
      'Draft payload only - real ASIC lodgement is gated by Phase 7.',
      'Address changes are empty because this schema has no company registered-office/principal-place address source yet.',
      'Change detection is based on register row updated_at timestamps since the supplied p_since or the latest lodged/accepted Form 484 filing.'
    )
  );

  if v_change_count = 0 then
    return v_payload || jsonb_build_object(
      'status', 'empty',
      'filing_id', null,
      'drafts_replaced', 0
    );
  end if;

  update public.asic_filings
     set deleted_at = v_generated_at
   where organization_id = p_org
     and form_type = '484'
     and status = 'draft'
     and deleted_at is null;
  get diagnostics v_replaced = row_count;

  insert into public.asic_filings (
    organization_id, form_type, status, lodgement_date, details, notes, created_by
  )
  values (
    p_org,
    '484',
    'draft',
    null,
    v_payload,
    'Draft Form 484 change payload generated from the ASIC register tables.',
    auth.uid()
  )
  returning id into v_filing_id;

  return v_payload || jsonb_build_object(
    'filing_id', v_filing_id,
    'drafts_replaced', v_replaced
  );
end;
$$;

comment on function public.asic_form484_draft(uuid, timestamptz) is
  'SC-5.P.03: generates a draft ASIC Form 484 change payload from company_officers '
  'and share_register rows changed since p_since (or since the latest lodged/accepted '
  'Form 484), then records a status=draft row in asic_filings when changes exist. '
  'Address changes are deliberately empty until a company-address source exists. '
  'Draft only; real ASIC lodgement is Phase 7. SECURITY INVOKER; table RLS scopes reads/writes.';

revoke all on function public.asic_form484_draft(uuid, timestamptz) from public, anon;
grant execute on function public.asic_form484_draft(uuid, timestamptz) to authenticated;
