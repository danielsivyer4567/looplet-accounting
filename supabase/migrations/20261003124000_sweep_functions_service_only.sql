-- SEC-12: the data-completeness sweep functions run only from cron or the service role, not from a signed-in user.
--
-- run_data_completeness_scan_all() scans every organisation and emit_critical_finding_notifications() writes
-- notifications into whichever organisations had findings. Both are SECURITY DEFINER, take no arguments and are
-- scheduled by pg_cron (job data-completeness-scan). The service-role-only guard added in 20260702153000 protects
-- the body, but EXECUTE was still granted to authenticated, so any signed-in user could at least trigger the sweep.
-- Guarded so a database without one of the functions still applies.
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.emit_critical_finding_notifications()',
    'public.run_data_completeness_scan_all()'
  ]
  LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    ELSE
      RAISE NOTICE 'SEC-12: % not found, skipped', fn;
    END IF;
  END LOOP;
END $$;
