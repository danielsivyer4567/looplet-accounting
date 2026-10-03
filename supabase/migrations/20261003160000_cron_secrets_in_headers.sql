-- SEC-07: cron secrets move from the URL to an x-cron-secret header.
--
-- These pg_cron jobs call their edge function with ?secret=<Vault secret> in the URL. A URL is written
-- to the edge-function invocation logs and to net._http_response, so the secrets end up in logs.
-- Production (read-only check of cron.job, 2026-10-03) has eleven of them:
--   notifications-cron-nightly, accountant-digest-cron, auto-reconcile-daily, bank-txn-classifier-cron,
--   automation-worker-every-2min, automation-watchdog-every-15min, gmail-watch-renew-daily,
--   accountant-orchestrator-daily, legal-horizon-scan-3h, legal-corpus-sync-daily,
--   advisor-scheduled-daily
-- and 0197 can also create bank-sync-all in that form. The xero-*, capital-purchase-propose and
-- receipt-sync-dispatch-drain jobs already send x-cron-secret and are not touched.
--
-- Each job is changed in place: cron.alter_job keeps its id, name, schedule and active flag, and its
-- command is rewritten from what is in cron.job now (not from the repo, which can differ): the
--   ?secret=' || (select decrypted_secret from vault.decrypted_secrets where name = '<n>' limit 1)
-- tail of the URL is removed, and the same Vault lookup is added to the headers as 'x-cron-secret'.
-- URL, body, timeout and per-organisation fan-out are unchanged. A job whose command does not have
-- exactly that shape (one URL secret, one Content-Type-only jsonb_build_object for headers) is left
-- as it is and reported, as is any other job that still sends ?secret=. Jobs that do not exist (a fresh
-- database, or a job an operator removed) are skipped.
--
-- Rollout order: deploy the edge functions first (they read x-cron-secret and, for one release, still
-- accept ?secret=; supabase/functions/_shared/cronSecret.ts), then apply this migration.
--
-- private.move_cron_secrets_to_headers() is kept so an operator can run it again (for example after
-- restoring a job from an older migration). The private schema is not exposed through the API.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.move_cron_secrets_to_headers()
returns table (job_name text, moved boolean, detail text)
language plpgsql
set search_path = ''
as $fn$
declare
  -- The Vault lookup that follows ?secret= in the URL (captured verbatim so the header reads the same secret).
  vault_lookup constant text :=
    '(\(\s*select\s+decrypted_secret\s+from\s+vault\.decrypted_secrets\s+where\s+name\s*=\s*''[a-z0-9_]+''\s+limit\s+1\s*\))';
  -- ...'<url>?secret=' || <lookup>   or   ...'<url>' || '?secret=' || <lookup>, ending the url argument.
  url_secret constant text := '(?:''\s*\|\|\s*'')?\?secret=''\s*\|\|\s*' || vault_lookup || '(?=\s*[,)])';
  content_type_only constant text :=
    '(headers\s*:=\s*jsonb_build_object\(\s*''Content-Type''\s*,\s*''application/json''\s*)\)';
  names constant text[] := array[
    'notifications-cron-nightly', 'accountant-digest-cron', 'auto-reconcile-daily', 'bank-txn-classifier-cron',
    'automation-worker-every-2min', 'automation-watchdog-every-15min', 'gmail-watch-renew-daily',
    'accountant-orchestrator-daily', 'legal-horizon-scan-3h', 'legal-corpus-sync-daily',
    'advisor-scheduled-daily', 'bank-sync-all'];
  job record;
  lookup text;
  rewritten text;
begin
  if to_regclass('cron.job') is null
     or to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') is null then
    raise notice 'pg_cron not available; no cron jobs to move';
    return;
  end if;

  for job in
    select j.jobid, j.jobname, j.command from cron.job j where j.jobname = any (names) order by j.jobid
  loop
    job_name := job.jobname;
    moved := false;
    if position('?secret=' in job.command) = 0 then
      detail := 'no secret in the URL; left as is';
      return next;
      continue;
    end if;

    lookup := (regexp_match(job.command, url_secret, 'i'))[1];
    if lookup is null
       or (select count(*) from regexp_matches(job.command, '\?secret=', 'g')) <> 1
       or (select count(*) from regexp_matches(job.command, content_type_only, 'gi')) <> 1
       or position('cron-secret' in lower(job.command)) > 0 then
      detail := 'command is not in the expected shape; left as is, move it by hand';
      raise notice 'cron job % (%): %', job.jobname, job.jobid, detail;
      return next;
      continue;
    end if;

    rewritten := regexp_replace(job.command, url_secret, '''', 'i');
    rewritten := regexp_replace(rewritten, content_type_only, '\1, ''x-cron-secret'', ' || replace(lookup, '\', '\\') || ')', 'i');

    if position('?secret=' in rewritten) > 0
       or (select count(*) from regexp_matches(rewritten, '''x-cron-secret''', 'g')) <> 1
       or position(lookup in rewritten) = 0 then
      detail := 'rewrite check failed; left as is, move it by hand';
      raise notice 'cron job % (%): %', job.jobname, job.jobid, detail;
      return next;
      continue;
    end if;

    begin
      perform cron.alter_job(job.jobid, command := rewritten);
      moved := true;
      detail := 'secret moved to the x-cron-secret header';
    exception when others then
      detail := 'cron.alter_job failed: ' || sqlerrm;
      raise notice 'cron job % (%): %', job.jobname, job.jobid, detail;
    end;
    return next;
  end loop;

  for job in
    select j.jobid, j.jobname from cron.job j
    where position('?secret=' in j.command) > 0 and not (j.jobname = any (names))
  loop
    raise notice 'cron job % (%) still sends a secret in its URL; move it to the x-cron-secret header', job.jobname, job.jobid;
  end loop;
end
$fn$;

revoke all on function private.move_cron_secrets_to_headers() from public, anon, authenticated;

do $$
declare
  r record;
begin
  for r in select * from private.move_cron_secrets_to_headers() loop
    raise notice 'cron job %: %', r.job_name, r.detail;
  end loop;
end $$;
