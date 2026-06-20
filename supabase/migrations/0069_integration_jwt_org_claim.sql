-- 0069_integration_jwt_org_claim.sql  (EPIC F — F1)
-- Wire integration (machine) tokens into the existing org-scoping RLS.
--
-- The api-gateway mints a short-lived JWT with role=authenticated and an
-- `organization_id` claim, but NO `sub`/auth.uid() and no membership row. The
-- existing get_accessible_org_ids() resolves orgs purely from
-- organization_memberships keyed on auth.uid(), so such a token would see
-- nothing. We extend the helper (option (b) in api-gateway's NOTE) to also
-- honour a vetted `organization_id` claim when present.
--
-- Safety: the claim is only minted by the gateway AFTER a valid API key has been
-- authenticated and is pinned to that key's organization_id — a caller cannot
-- forge it without the project JWT secret. Human sessions never carry this claim,
-- so their behaviour is unchanged.

-- Both helpers below are pinned to a fixed search_path and schema-qualify every
-- reference (tables, auth.uid()) so a SECURITY DEFINER function can never be
-- hijacked by a caller-controlled search_path. (Matches the 0060/0068 hardening
-- pattern.) Behaviour is otherwise identical to the prior definitions.
create or replace function public.integration_org_id() returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- The org claim from an integration token, or NULL for human/anon sessions.
  -- Defensive: bad/missing claims must yield NULL, never error.
  select nullif(
           coalesce(
             current_setting('request.jwt.claims', true)::jsonb ->> 'organization_id',
             ''
           ),
           ''
         )::uuid;
$$;

create or replace function public.get_accessible_org_ids() returns setof uuid
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_user_id     uuid := auth.uid();
  v_integration uuid := public.integration_org_id();
begin
  -- Integration token: scope strictly to the single pinned org. These tokens
  -- have no auth.uid(); they must NEVER inherit a human's broader access.
  if v_user_id is null and v_integration is not null then
    return next v_integration;
    return;
  end if;

  if v_user_id is null then
    return;
  end if;

  -- Direct memberships
  return query
    select m.organization_id
      from public.organization_memberships m
     where m.user_id = v_user_id;

  -- Sub-accounts of agencies the user admins
  return query
    select sa.id
      from public.organizations sa
      join public.organizations agency
        on sa.parent_organization_id = agency.id
      join public.organization_memberships m
        on m.organization_id = agency.id
     where agency.organization_type = 'agency'
       and sa.organization_type    = 'sub_account'
       and m.user_id                = v_user_id
       and m.role in ('owner', 'admin');
end;
$$;
