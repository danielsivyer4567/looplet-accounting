-- ============================================================================
-- 0212_automation_worker_cron.sql
--
-- Schedules the automation-worker edge function every 2 minutes via pg_cron.
--
-- Prerequisites (run ONCE after deployment):
--   1. supabase functions deploy automation-worker --no-verify-jwt
--   2. supabase secrets set AUTOMATION_WORKER_SECRET=<random-32-char-string>
--
-- Replace <PROJECT_REF> with the real Supabase project reference.
-- The secret must match AUTOMATION_WORKER_SECRET set in function secrets.
-- ============================================================================

-- Schedule: every 2 minutes
SELECT cron.schedule(
  'automation-worker-every-2min',
  '*/2 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://<PROJECT_REF>.supabase.co/functions/v1/automation-worker?secret=<AUTOMATION_WORKER_SECRET>',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb
    );
  $$
);

-- To inspect job history:
--   SELECT * FROM cron.job WHERE jobname = 'automation-worker-every-2min';
--   SELECT * FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'automation-worker-every-2min')
--    ORDER BY start_time DESC LIMIT 20;

-- To pause:
--   UPDATE cron.job SET active = false WHERE jobname = 'automation-worker-every-2min';

-- To unschedule permanently:
--   SELECT cron.unschedule('automation-worker-every-2min');
