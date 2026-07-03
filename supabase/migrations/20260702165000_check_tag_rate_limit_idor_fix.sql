-- Found during the P1 audit of the 61 authenticated-executable DEFINER
-- functions (2026-07-02): check_tag_rate_limit(p_user_id, p_page_url) takes
-- p_user_id as a caller-supplied parameter with no check that it matches the
-- authenticated caller. Any logged-in user can pass ANOTHER user's uuid and
-- read back that user's tag-creation velocity (count in the last hour) and
-- cooldown state — a cross-user information-disclosure IDOR, low severity
-- (activity metadata, not financial/tenant data, no write uses p_user_id
-- unscoped), but still wrong: the function should only ever report on the
-- caller's own rate-limit state.
--
-- Fix: validate p_user_id against auth.uid() before doing any lookup. Keeps
-- the existing signature (real callers already pass their own id) — this is
-- additive/narrowing, not a breaking change for legitimate use.
--
-- Real body preserved verbatim (read via pg_get_functiondef 2026-07-02);
-- only the guard at the top is new.
CREATE OR REPLACE FUNCTION public.check_tag_rate_limit(p_user_id uuid, p_page_url text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count_last_minute  integer;
  v_count_last_hour    integer;
  v_last_tag_time      timestamptz;
  v_cooldown_remaining integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'p_user_id must match the authenticated caller'
      USING ERRCODE = '42501';
  END IF;

  -- Clean up expired rate-limit records
  DELETE FROM public.tag_rate_limits WHERE expires_at < NOW();

  SELECT COUNT(*) INTO v_count_last_minute
  FROM public.tag_rate_limits
  WHERE user_id = p_user_id
    AND created_at > NOW() - INTERVAL '1 minute';

  SELECT COUNT(*) INTO v_count_last_hour
  FROM public.tag_rate_limits
  WHERE user_id = p_user_id
    AND created_at > NOW() - INTERVAL '1 hour';

  SELECT MAX(created_at) INTO v_last_tag_time
  FROM public.tag_rate_limits
  WHERE user_id = p_user_id;

  -- Cooldown: 5 seconds between tags
  IF v_last_tag_time IS NOT NULL AND
     v_last_tag_time > NOW() - INTERVAL '5 seconds' THEN
    v_cooldown_remaining := EXTRACT(EPOCH FROM (v_last_tag_time + INTERVAL '5 seconds' - NOW()))::integer;
    RETURN jsonb_build_object(
      'allowed', FALSE,
      'reason', 'cooldown',
      'wait_seconds', v_cooldown_remaining,
      'message', format('Please wait %s seconds before creating another tag', v_cooldown_remaining)
    );
  END IF;

  -- Hourly limit: 50 per hour
  IF v_count_last_hour >= 50 THEN
    RETURN jsonb_build_object(
      'allowed', FALSE,
      'reason', 'hourly_limit',
      'count', v_count_last_hour,
      'message', 'You have reached the maximum of 50 tags per hour'
    );
  END IF;

  RETURN jsonb_build_object(
    'allowed', TRUE,
    'remaining_hourly', 50 - v_count_last_hour
  );
END;
$function$;
