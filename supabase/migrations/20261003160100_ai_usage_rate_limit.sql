-- SEC-07: per-user rate limit for paid AI features.
--
-- Public sign-up lets anyone create an account and an organisation, so organisation membership alone
-- does not stop someone spending the Groq, Perplexity, OpenAI, Anthropic or MiniMax credit behind
-- ask-bot, bank-statement-extract, staged-entities-enrich-sonar and the other AI functions. Each paid
-- call by a signed-in user now takes one unit of a per-user, per-feature quota counted here, so the
-- limit holds across edge-function isolates and regions. Limits are set by the caller
-- (supabase/functions/_shared/aiRateLimit.ts); service-role and cron calls are not counted.
--
-- Only the service role can run consume_ai_quota, and nobody can read or write ai_usage_events through
-- the API: a user cannot spend or inspect another user's quota.

create table if not exists public.ai_usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  feature text not null check (feature ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_events_user_feature_created_idx
  on public.ai_usage_events (user_id, feature, created_at desc);

alter table public.ai_usage_events enable row level security;
-- No policies on purpose: only consume_ai_quota (security definer) touches this table.
revoke all on table public.ai_usage_events from public, anon, authenticated;

create or replace function public.consume_ai_quota(
  p_user_id uuid,
  p_feature text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, used integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window interval;
  v_used integer;
  v_oldest timestamptz;
begin
  if p_user_id is null or p_feature is null or p_limit is null or p_limit < 1
     or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'consume_ai_quota: invalid arguments' using errcode = '22023';
  end if;
  v_window := make_interval(secs => p_window_seconds);

  -- One decision at a time per user and feature, so two concurrent calls cannot both take the last unit.
  perform pg_advisory_xact_lock(hashtextextended('ai_quota:' || p_user_id::text || ':' || p_feature, 0));

  select count(*)::integer, min(e.created_at)
    into v_used, v_oldest
    from public.ai_usage_events e
   where e.user_id = p_user_id
     and e.feature = p_feature
     and e.created_at > now() - v_window;

  if v_used >= p_limit then
    -- The oldest counted call leaves the window first; that is when one unit frees up.
    return query select false, v_used, greatest(1, ceil(extract(epoch from (v_oldest + v_window - now())))::integer);
    return;
  end if;

  insert into public.ai_usage_events (user_id, feature) values (p_user_id, p_feature);

  -- Keep the table small: events older than the window (and at least a day) are no longer needed.
  delete from public.ai_usage_events e
   where e.user_id = p_user_id
     and e.feature = p_feature
     and e.created_at < now() - greatest(interval '1 day', v_window);

  return query select true, v_used + 1, 0;
end;
$$;

revoke all on function public.consume_ai_quota(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_ai_quota(uuid, text, integer, integer) to service_role;
