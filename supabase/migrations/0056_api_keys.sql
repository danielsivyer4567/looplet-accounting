-- 0056_api_keys.sql
-- External connector auth layer (AUDIT.md §2 B5 + §5).
-- Goal: let ANY external source push/pull data without a human login, while
-- existing RLS keeps doing all tenant enforcement.
--
-- Model: an API key is organization-bound; only a SHA-256 hash is stored. The
-- `api-gateway` edge function validates a presented key and mints a short-lived
-- Supabase JWT carrying role=authenticated + the key's organization_id, so reads
-- via PostgREST and writes via the `ingest` function are automatically scoped.

create table if not exists public.api_keys (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  key_prefix      text not null unique,                 -- public id, e.g. "llp_ab12cd34"
  hashed_key      text not null,                         -- sha256(full secret); secret shown once
  scopes          text[] not null default '{}',          -- read:financials, write:bills, ...
  created_by      uuid references auth.users(id),
  last_used_at    timestamptz,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists api_keys_org_idx    on public.api_keys(organization_id);
create index if not exists api_keys_prefix_idx on public.api_keys(key_prefix);

alter table public.api_keys enable row level security;

-- Members of the owning org manage their keys. NOTE: hashed_key must never be
-- returned to clients — expose keys through a column-restricted view in the app
-- layer; the gateway reads hashed_key under the service role only.
drop policy if exists api_keys_select on public.api_keys;
create policy api_keys_select on public.api_keys for select to authenticated
  using (organization_id in (select get_accessible_org_ids()));

drop policy if exists api_keys_insert on public.api_keys;
create policy api_keys_insert on public.api_keys for insert to authenticated
  with check (organization_id in (select get_accessible_org_ids()));

drop policy if exists api_keys_update on public.api_keys;
create policy api_keys_update on public.api_keys for update to authenticated
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));

-- No delete policy: keys are revoked (set revoked_at), never hard-deleted, so the
-- audit trail of which key did what survives.
