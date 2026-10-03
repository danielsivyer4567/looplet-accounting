-- SEC-12: the data-completeness sweep functions can be run only by the service role (and cron as postgres), never
-- by a signed-in user or the anon role.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/sweep-functions-service-only.sql

BEGIN;

CREATE TEMP TABLE outcomes (fn text, role text, can_execute boolean);
INSERT INTO outcomes
SELECT fn, r, has_function_privilege(r, fn, 'EXECUTE')
  FROM unnest(ARRAY['public.emit_critical_finding_notifications()', 'public.run_data_completeness_scan_all()']) AS fn
 CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r
 WHERE to_regprocedure(fn) IS NOT NULL;

-- Behaviour, not just grants: a signed-in owner calling the sweep gets a permission error.
CREATE TEMP TABLE calls (fn text, outcome text);
GRANT INSERT ON calls TO authenticated;  -- the probe below runs as authenticated
DO $$
DECLARE fn text;
BEGIN
  INSERT INTO auth.users (id, email, aud, role) VALUES ('5e000000-0000-4000-8000-000000000001', 'owner@example.test', 'authenticated', 'authenticated');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '5e000000-0000-4000-8000-000000000001', 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '5e000000-0000-4000-8000-000000000001', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  FOREACH fn IN ARRAY ARRAY['public.emit_critical_finding_notifications()', 'public.run_data_completeness_scan_all()'] LOOP
    IF to_regprocedure(fn) IS NULL THEN CONTINUE; END IF;
    BEGIN
      EXECUTE 'SELECT ' || fn;
      INSERT INTO calls VALUES (fn, 'ran');
    EXCEPTION
      WHEN insufficient_privilege THEN INSERT INTO calls VALUES (fn, 'denied');
      WHEN OTHERS THEN INSERT INTO calls VALUES (fn, 'error: ' || SQLSTATE || ' ' || SQLERRM);
    END;
  END LOOP;
  EXECUTE 'RESET ROLE';
END $$;

DO $$
DECLARE r record; bad text := '';
BEGIN
  IF (SELECT count(DISTINCT fn) FROM outcomes) < 2 THEN
    RAISE EXCEPTION 'expected both sweep functions to exist';
  END IF;
  FOR r IN SELECT * FROM outcomes LOOP
    IF (r.role = 'service_role') <> r.can_execute THEN
      bad := bad || format(E'\n  %s: %s can_execute=%s', r.fn, r.role, r.can_execute);
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM calls WHERE outcome <> 'denied' LOOP
    bad := bad || format(E'\n  %s called by a signed-in owner: %s (expected denied)', r.fn, r.outcome);
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'sweep function grants wrong:%', bad; END IF;
  RAISE NOTICE 'sweep functions: % grant checks and % call checks as expected', (SELECT count(*) FROM outcomes), (SELECT count(*) FROM calls);
END $$;

ROLLBACK;
