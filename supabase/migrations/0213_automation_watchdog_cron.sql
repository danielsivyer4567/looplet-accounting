-- ============================================================================
-- 0213_automation_watchdog_cron.sql
--
-- Schedules the automation-watchdog edge function every 15 minutes via pg_cron.
--
-- Prerequisites (run ONCE after deployment):
--   1. supabase functions deploy automation-watchdog --no-verify-jwt
--   2. supabase secrets set AUTOMATION_WATCHDOG_SECRET=<random-32-char-string>
--
-- Replace <PROJECT_REF> with the real Supabase project reference.
-- The secret must match AUTOMATION_WATCHDOG_SECRET set in function secrets.
-- ============================================================================

-- Schedule: every 15 minutes
SELECT cron.schedule(
  'automation-watchdog-every-15min',
  '*/15 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://<PROJECT_REF>.supabase.co/functions/v1/automation-watchdog?secret=<AUTOMATION_WATCHDOG_SECRET>',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb
    );
  $$
);

-- To inspect job history:
--   SELECT * FROM cron.job WHERE jobname = 'automation-watchdog-every-15min';
--   SELECT * FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'automation-watchdog-every-15min')
--    ORDER BY start_time DESC LIMIT 20;

-- To pause:
--   UPDATE cron.job SET active = false WHERE jobname = 'automation-watchdog-every-15min';

-- To unschedule permanently:
--   SELECT cron.unschedule('automation-watchdog-every-15min');
