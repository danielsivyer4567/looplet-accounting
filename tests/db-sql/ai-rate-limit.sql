-- SEC-07: per-user quota for paid AI features (migration 20261003160100).
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/ai-rate-limit.sql
--
-- Setup runs as postgres. Quota calls run as service_role (the edge functions' admin client), and the
-- API roles are checked to be locked out.

BEGIN;

INSERT INTO auth.users (id, email, aud, role) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'quota-a@example.test', 'authenticated', 'authenticated'),
  ('b1000000-0000-4000-8000-000000000001', 'quota-b@example.test', 'authenticated', 'authenticated');

CREATE FUNCTION pg_temp.take(p_user uuid, p_feature text, p_limit int, p_window int DEFAULT 3600)
RETURNS record LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT * INTO r FROM public.consume_ai_quota(p_user, p_feature, p_limit, p_window);
  EXECUTE 'RESET ROLE';
  RETURN r;
END $$;

DO $$
DECLARE
  a constant uuid := 'a1000000-0000-4000-8000-000000000001';
  b constant uuid := 'b1000000-0000-4000-8000-000000000001';
  r record;
  i int;
  denied boolean;
BEGIN
  -- The first three calls in the hour are allowed and counted; the fourth is refused with a retry time.
  FOR i IN 1..3 LOOP
    r := pg_temp.take(a, 'ask_bot', 3);
    IF NOT r.allowed OR r.used <> i THEN RAISE EXCEPTION 'call % should be allowed as unit %, got %', i, i, r; END IF;
  END LOOP;
  r := pg_temp.take(a, 'ask_bot', 3);
  IF r.allowed OR r.used <> 3 OR r.retry_after_seconds NOT BETWEEN 3500 AND 3600 THEN
    RAISE EXCEPTION 'fourth call should be refused with about an hour to wait, got %', r;
  END IF;
  IF (SELECT count(*) FROM public.ai_usage_events WHERE user_id = a AND feature = 'ask_bot') <> 3 THEN
    RAISE EXCEPTION 'a refused call must not be counted';
  END IF;

  -- Other users and other features have their own quota.
  r := pg_temp.take(b, 'ask_bot', 3);
  IF NOT r.allowed OR r.used <> 1 THEN RAISE EXCEPTION 'user b should be unaffected, got %', r; END IF;
  r := pg_temp.take(a, 'bank_statement_extract', 3);
  IF NOT r.allowed OR r.used <> 1 THEN RAISE EXCEPTION 'another feature should be unaffected, got %', r; END IF;

  -- Calls older than the window no longer count, and the retry time follows the oldest counted call.
  UPDATE public.ai_usage_events SET created_at = now() - interval '61 minutes' WHERE user_id = a AND feature = 'ask_bot'
     AND id = (SELECT min(id) FROM public.ai_usage_events WHERE user_id = a AND feature = 'ask_bot');
  UPDATE public.ai_usage_events SET created_at = now() - interval '50 minutes' WHERE user_id = a AND feature = 'ask_bot'
     AND id = (SELECT min(id) + 1 FROM public.ai_usage_events WHERE user_id = a AND feature = 'ask_bot');
  r := pg_temp.take(a, 'ask_bot', 3);
  IF NOT r.allowed OR r.used <> 3 THEN RAISE EXCEPTION 'an expired call should free one unit, got %', r; END IF;
  r := pg_temp.take(a, 'ask_bot', 3);
  IF r.allowed OR r.retry_after_seconds NOT BETWEEN 540 AND 600 THEN
    RAISE EXCEPTION 'retry should be about 10 minutes (when the 50-minute-old call expires), got %', r;
  END IF;

  -- Old events are cleaned up as the user keeps calling.
  INSERT INTO public.ai_usage_events (user_id, feature, created_at) VALUES (b, 'ask_bot', now() - interval '3 days');
  r := pg_temp.take(b, 'ask_bot', 3);
  IF EXISTS (SELECT 1 FROM public.ai_usage_events WHERE user_id = b AND created_at < now() - interval '1 day') THEN
    RAISE EXCEPTION 'events older than a day should be removed';
  END IF;

  -- Bad arguments are refused rather than treated as unlimited.
  BEGIN
    r := pg_temp.take(a, 'ask_bot', 0);
    RAISE EXCEPTION 'a zero limit should be refused';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  RESET ROLE;
  BEGIN
    INSERT INTO public.ai_usage_events (user_id, feature) VALUES (a, 'Bad Feature!');
    RAISE EXCEPTION 'a malformed feature name should be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- The API roles cannot spend, read or reset anyone's quota.
  IF has_function_privilege('authenticated', 'public.consume_ai_quota(uuid,text,integer,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.consume_ai_quota(uuid,text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'API roles can run consume_ai_quota';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.consume_ai_quota(uuid,text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot run consume_ai_quota';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', a::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  denied := false;
  BEGIN
    PERFORM count(*) FROM public.ai_usage_events;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'authenticated can read ai_usage_events'; END IF;
  denied := false;
  BEGIN
    DELETE FROM public.ai_usage_events WHERE user_id = a;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'authenticated can delete ai_usage_events'; END IF;
  denied := false;
  BEGIN
    PERFORM * FROM public.consume_ai_quota(b, 'ask_bot', 1000, 3600);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'authenticated can run consume_ai_quota'; END IF;
  EXECUTE 'RESET ROLE';

  RAISE NOTICE 'ai-rate-limit: per-user, per-feature hourly quota enforced; refused calls not counted; window and retry time correct; API roles locked out';
END $$;

ROLLBACK;
