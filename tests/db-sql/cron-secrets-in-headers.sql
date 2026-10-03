-- SEC-07: migration 20261003160000 moves cron secrets out of URLs and into an x-cron-secret header.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/cron-secrets-in-headers.sql
--
-- A fresh database has no pg_cron jobs, so this test creates jobs shaped like the production ones
-- (secret in the URL, Content-Type-only headers), plus an operator-paused job, an operator-rewritten
-- job, a job in an unexpected shape, a job that already uses the header and a dashboard job, then runs
-- the migration's function and checks exactly what changed. Job commands are never executed (EXPLAIN
-- only plans them), so nothing is sent anywhere.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule('notifications-cron-nightly', '30 2 * * *', $c$
  select net.http_post(
    url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/notifications-cron?secret='
      || (select decrypted_secret from vault.decrypted_secrets where name = 'notifications_cron_secret' limit 1),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$c$);
-- Per organisation, URL built as '<url>' || '?secret=' || <lookup>.
SELECT cron.schedule('auto-reconcile-daily', '15 3 * * *', $c$
  select net.http_post(
    url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/auto-reconcile'
      || '?secret=' || (select decrypted_secret from vault.decrypted_secrets where name = 'auto_reconcile_cron_secret' limit 1),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('organization_id', o.id)
  )
  from public.organizations o
  where o.deleted_at is null;
$c$);
-- A production job with no definition in the repo (body with as_at_date), upper-case SQL.
SELECT cron.schedule('accountant-orchestrator-daily', '45 3 * * *', $c$
  SELECT net.http_post(
    url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/accountant-orchestrator?secret=' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'accountant_orchestrator_cron_secret' LIMIT 1),
    headers := jsonb_build_object('Content-Type','application/json'),
    body := jsonb_build_object('organization_id', o.id, 'as_at_date', current_date)
  )
  FROM public.organizations o
  WHERE o.deleted_at IS NULL;
$c$);
-- Paused by an operator: moved, and stays paused.
SELECT cron.schedule('automation-worker-every-2min', '*/2 * * * *', $c$
  select net.http_post(
    url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/automation-worker?secret='
      || (select decrypted_secret from vault.decrypted_secrets where name = 'automation_worker_cron_secret' limit 1),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$c$);
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'automation-worker-every-2min'), active := false);
-- Rewritten by an operator to do nothing: left as is.
SELECT cron.schedule('gmail-watch-renew-daily', '0 3 * * *', $c$ select 1 $c$);
-- An unexpected shape (an extra header): left as is and reported, never half-rewritten.
SELECT cron.schedule('legal-horizon-scan-3h', '0 */3 * * *', $c$
  select net.http_post(
    url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/legal-horizon-scan?secret='
      || (select decrypted_secret from vault.decrypted_secrets where name = 'legal_scan_secret' limit 1),
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Trace', 'cron')
  );
$c$);
-- Already sends the header (like the xero-* jobs): not in the list, untouched.
SELECT cron.schedule('xero-sync-accounts-daily', '0 17 * * *', $c$
  select net.http_post(
    url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/xero-sync-accounts',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'xero_cron_secret' limit 1))
  );
$c$);
-- Created in the dashboard, not in the list: untouched (the function raises a NOTICE naming it).
SELECT cron.schedule('dashboard-job', '0 5 * * *', $c$
  select net.http_post(url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/eofy-pack?secret=abc')
$c$);

CREATE TEMP TABLE before_jobs AS SELECT jobid, jobname, schedule, active, command FROM cron.job;
CREATE TEMP TABLE result AS SELECT * FROM private.move_cron_secrets_to_headers();

DO $$
DECLARE
  got text;
  j record;
  n int;
BEGIN
  SELECT string_agg(job_name || '=' || moved, ', ' ORDER BY job_name) INTO got FROM result;
  IF got IS DISTINCT FROM 'accountant-orchestrator-daily=true, auto-reconcile-daily=true, automation-worker-every-2min=true, '
                          'gmail-watch-renew-daily=false, legal-horizon-scan-3h=false, notifications-cron-nightly=true' THEN
    RAISE EXCEPTION 'unexpected result: %', got;
  END IF;

  -- Exact rewrite of one job: only the URL tail and the header change.
  IF (SELECT command FROM cron.job WHERE jobname = 'notifications-cron-nightly') IS DISTINCT FROM $e$
  select net.http_post(
    url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/notifications-cron',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notifications_cron_secret' limit 1)),
    body := '{}'::jsonb
  );
$e$ THEN
    RAISE EXCEPTION 'notifications-cron-nightly rewritten as: %', (SELECT command FROM cron.job WHERE jobname = 'notifications-cron-nightly');
  END IF;
  IF (SELECT command FROM cron.job WHERE jobname = 'auto-reconcile-daily') IS DISTINCT FROM $e$
  select net.http_post(
    url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/auto-reconcile',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'auto_reconcile_cron_secret' limit 1)),
    body := jsonb_build_object('organization_id', o.id)
  )
  from public.organizations o
  where o.deleted_at is null;
$e$ THEN
    RAISE EXCEPTION 'auto-reconcile-daily rewritten as: %', (SELECT command FROM cron.job WHERE jobname = 'auto-reconcile-daily');
  END IF;

  -- Every moved job: same id, schedule and active flag; no URL secret; one header with the same Vault secret; plans cleanly.
  FOR j IN
    SELECT c.jobid, c.jobname, c.command, c.schedule, c.active, b.jobid AS old_id, b.schedule AS old_schedule,
           b.active AS old_active, b.command AS old_command
    FROM cron.job c JOIN before_jobs b USING (jobname)
    WHERE c.jobname IN (SELECT job_name FROM result WHERE moved)
  LOOP
    IF j.jobid <> j.old_id OR j.schedule <> j.old_schedule OR j.active <> j.old_active THEN
      RAISE EXCEPTION '% id/schedule/active changed', j.jobname;
    END IF;
    IF position('?secret=' IN j.command) > 0 THEN RAISE EXCEPTION '% still has ?secret=', j.jobname; END IF;
    SELECT count(*) INTO n FROM regexp_matches(j.command, '''x-cron-secret''', 'g');
    IF n <> 1 THEN RAISE EXCEPTION '% has % x-cron-secret headers', j.jobname, n; END IF;
    IF substring(j.command FROM '(?i)name = ''([a-z_]+)''') IS DISTINCT FROM substring(j.old_command FROM '(?i)name = ''([a-z_]+)''') THEN
      RAISE EXCEPTION '% reads a different Vault secret now', j.jobname;
    END IF;
    IF substring(j.command FROM '(?i)body := .*') IS DISTINCT FROM substring(j.old_command FROM '(?i)body := .*') THEN
      RAISE EXCEPTION '% body changed', j.jobname;
    END IF;
    EXECUTE 'EXPLAIN ' || regexp_replace(j.command, ';\s*$', '');
  END LOOP;

  IF (SELECT active FROM cron.job WHERE jobname = 'automation-worker-every-2min') THEN
    RAISE EXCEPTION 'the paused job was re-enabled';
  END IF;
  FOR j IN SELECT b.jobname FROM before_jobs b JOIN cron.job c USING (jobid)
           WHERE b.jobname IN ('gmail-watch-renew-daily', 'legal-horizon-scan-3h', 'xero-sync-accounts-daily', 'dashboard-job')
             AND c.command IS DISTINCT FROM b.command LOOP
    RAISE EXCEPTION '% should not have changed', j.jobname;
  END LOOP;
  IF (SELECT detail FROM result WHERE job_name = 'legal-horizon-scan-3h') NOT LIKE 'command is not in the expected shape%' THEN
    RAISE EXCEPTION 'unexpected-shape job not reported';
  END IF;

  -- Running it again changes nothing.
  SELECT count(*) INTO n FROM private.move_cron_secrets_to_headers() WHERE moved;
  IF n <> 0 THEN RAISE EXCEPTION 'second run moved % jobs', n; END IF;

  -- Not reachable through the API roles.
  IF has_schema_privilege('authenticated', 'private', 'USAGE') OR has_schema_privilege('anon', 'private', 'USAGE') THEN
    RAISE EXCEPTION 'API roles can use the private schema';
  END IF;
  IF has_function_privilege('authenticated', 'private.move_cron_secrets_to_headers()', 'EXECUTE')
     OR has_function_privilege('anon', 'private.move_cron_secrets_to_headers()', 'EXECUTE') THEN
    RAISE EXCEPTION 'API roles can run the cron rewrite';
  END IF;

  RAISE NOTICE 'cron-secrets-in-headers: 4 jobs moved in place (URL, body, schedule, active kept), operator-changed, odd-shaped, header and unknown jobs untouched, re-run is a no-op, API roles locked out';
END $$;

ROLLBACK;
