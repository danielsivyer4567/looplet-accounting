-- 0055_security_hardening_p0.sql
-- P0 security hardening from the 2026-06-20 readiness audit (AUDIT.md §2 B1/B2 + §3d).
-- Applied to the live project (dxoikltymmknxqpkpyhi) on 2026-06-20 via MCP; this
-- migration is IDEMPOTENT and safe to re-run, so `supabase db push` will no-op on
-- an already-patched database and apply cleanly on a fresh one.
--
-- Fixes:
--   B1  Cross-tenant IDOR — all reporting views were SECURITY DEFINER with anon
--       SELECT grants, leaking every org's financials. Make them run as the caller
--       (so base-table RLS applies) and remove anon access.
--   B2  public.system_defaults had RLS off with full DML to anon/authenticated,
--       allowing anyone with the (committed) anon key to overwrite GST/super/tax
--       constants. Enable RLS, keep reads open, make writes service-role only.
--   d   notify() and orphaned cross-product functions were anon/PUBLIC-executable.

-- ── B1: reporting views run as caller + no anon read ────────────────────────────
do $$
declare v text;
begin
  for v in select table_name from information_schema.views where table_schema = 'public'
  loop
    execute format('alter view public.%I set (security_invoker = on)', v);
    execute format('revoke all on public.%I from anon', v);
  end loop;
end $$;

-- ── B2: global accounting constants — reads open, writes service-role only ───────
alter table public.system_defaults enable row level security;
revoke insert, update, delete, truncate, references, trigger
  on public.system_defaults from anon, authenticated;
drop policy if exists system_defaults_read on public.system_defaults;
create policy system_defaults_read on public.system_defaults
  for select to anon, authenticated using (true);

-- ── d: remove unauthenticated EXECUTE on definer/orphan functions ────────────────
-- Guarded with to_regprocedure so this is a no-op when a function is absent
-- (the orphaned ones were ported from another codebase and may not exist here).
do $$
begin
  if to_regprocedure('public.notify(uuid,text,text,text,text,text,uuid,text,uuid,jsonb)') is not null then
    execute 'revoke execute on function public.notify(uuid,text,text,text,text,text,uuid,text,uuid,jsonb) from anon';
  end if;
  if to_regprocedure('public.deduct_credits(uuid,integer)') is not null then
    execute 'revoke execute on function public.deduct_credits(uuid,integer) from anon, public';
  end if;
  if to_regprocedure('public.check_rate_limit(text,integer,integer)') is not null then
    execute 'revoke execute on function public.check_rate_limit(text,integer,integer) from anon, public';
  end if;
  if to_regprocedure('public.is_agency_user()') is not null then
    execute 'revoke execute on function public.is_agency_user() from anon, public';
  end if;
end $$;
