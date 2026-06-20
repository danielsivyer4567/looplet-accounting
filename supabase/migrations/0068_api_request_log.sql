-- 0068_api_request_log.sql  (EPIC F — F3)
-- Observability + abuse-control + lifecycle RPCs for the external connector API.
--
-- Adds:
--   * api_request_log         — one row per external (gateway/ingest) call.
--   * api_keys.rate_*          — per-key fixed-window rate-limit counter state.
--   * rpc api_key_rate_limit() — atomic check-and-increment used by the edge fns.
--   * rpc issue_api_key()      — mint a key (returns the one-time secret).
--   * rpc revoke_api_key()     — soft-revoke (sets revoked_at).
--
-- The edge functions run under the service role, so these RPCs/inserts are not
-- gated by RLS at call time; RLS below still scopes interactive (dashboard) use.

-- ---------------------------------------------------------------------------
-- 1. Request log
-- ---------------------------------------------------------------------------
create table if not exists public.api_request_log (
  id              bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  api_key_id      uuid references public.api_keys(id) on delete set null,
  key_prefix      text,                       -- denormalised so the row survives key deletion
  endpoint        text not null,              -- 'api-gateway' | 'ingest' | ...
  method          text,
  ingest_type     text,                       -- bill | bank_transaction | invoice (ingest only)
  status          integer not null,           -- HTTP status returned to the caller
  ts              timestamptz not null default now()
);

create index if not exists api_request_log_org_ts_idx  on public.api_request_log(organization_id, ts desc);
create index if not exists api_request_log_key_ts_idx  on public.api_request_log(api_key_id, ts desc);

alter table public.api_request_log enable row level security;

-- Members of the owning org can read their own call log; nobody writes via RLS
-- (only the service role, from the edge functions).
drop policy if exists api_request_log_select on public.api_request_log;
create policy api_request_log_select on public.api_request_log for select to authenticated
  using (organization_id in (select get_accessible_org_ids()));

-- ---------------------------------------------------------------------------
-- 2. Per-key rate-limit state (fixed window)
-- ---------------------------------------------------------------------------
-- A simple fixed-window counter: rate_window_started_at marks the start of the
-- current window; rate_count is the number of calls seen in it. The window
-- length and ceiling are passed in by the caller (defaults below).
alter table public.api_keys
  add column if not exists rate_limit_per_min     integer not null default 120,
  add column if not exists rate_window_started_at  timestamptz,
  add column if not exists rate_count              integer not null default 0;

-- Atomic check-and-increment. Returns true if the call is ALLOWED (and records
-- it), false if the key is over its ceiling for the current window.
-- SECURITY DEFINER so the service role can call it without RLS friction.
create or replace function public.api_key_rate_limit(
  p_key_id uuid,
  p_window_seconds integer default 60
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit   integer;
  v_started timestamptz;
  v_count   integer;
  v_now     timestamptz := now();
begin
  select rate_limit_per_min, rate_window_started_at, rate_count
    into v_limit, v_started, v_count
    from public.api_keys
   where id = p_key_id
   for update;

  if not found then
    return false;
  end if;

  -- Start a fresh window if none yet or the current one has elapsed.
  if v_started is null or v_now - v_started >= make_interval(secs => p_window_seconds) then
    update public.api_keys
       set rate_window_started_at = v_now,
           rate_count = 1
     where id = p_key_id;
    return true;
  end if;

  if v_count >= v_limit then
    return false;  -- over the ceiling; do NOT increment
  end if;

  update public.api_keys
     set rate_count = rate_count + 1
   where id = p_key_id;
  return true;
end;
$$;

revoke all on function public.api_key_rate_limit(uuid, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Lifecycle RPCs: issue + revoke
-- ---------------------------------------------------------------------------
-- issue_api_key: caller must be a member of the target org (checked against
-- get_accessible_org_ids()). The plaintext secret is generated server-side,
-- hashed, and returned exactly ONCE. The hash is what we persist.
--
-- A key is presented later as:  Authorization: Bearer <key_prefix>.<secret>
create or replace function public.issue_api_key(
  p_organization_id uuid,
  p_name            text,
  p_scopes          text[] default '{}',
  p_expires_at      timestamptz default null,
  p_rate_limit_per_min integer default 120
) returns table (api_key text, key_prefix text, id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix text;
  v_secret text;
  v_hash   text;
  v_id     uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_organization_id not in (select get_accessible_org_ids()) then
    raise exception 'organization not accessible';
  end if;

  -- "llp_" + 8 hex chars of public prefix; 32 hex chars (128-bit) of secret.
  v_prefix := 'llp_' || substr(encode(gen_random_bytes(8), 'hex'), 1, 8);
  v_secret := encode(gen_random_bytes(16), 'hex');
  v_hash   := encode(digest(v_secret, 'sha256'), 'hex');

  insert into public.api_keys (organization_id, name, key_prefix, hashed_key, scopes,
                               created_by, expires_at, rate_limit_per_min)
  values (p_organization_id, p_name, v_prefix, v_hash, coalesce(p_scopes, '{}'),
          auth.uid(), p_expires_at, greatest(1, p_rate_limit_per_min))
  returning public.api_keys.id into v_id;

  return query select (v_prefix || '.' || v_secret), v_prefix, v_id;
end;
$$;

-- revoke_api_key: soft-revoke (audit trail survives). Member-of-org enforced.
create or replace function public.revoke_api_key(p_key_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select organization_id into v_org from public.api_keys where id = p_key_id;
  if v_org is null then
    return false;
  end if;
  if v_org not in (select get_accessible_org_ids()) then
    raise exception 'organization not accessible';
  end if;

  update public.api_keys set revoked_at = now()
   where id = p_key_id and revoked_at is null;
  return true;
end;
$$;

-- digest()/gen_random_bytes() come from pgcrypto.
create extension if not exists pgcrypto with schema extensions;

-- Interactive callers (dashboard) may issue/revoke; the service role calls them
-- from the edge functions too. Both go through the org-membership check inside.
grant execute on function public.issue_api_key(uuid, text, text[], timestamptz, integer) to authenticated;
grant execute on function public.revoke_api_key(uuid) to authenticated;
