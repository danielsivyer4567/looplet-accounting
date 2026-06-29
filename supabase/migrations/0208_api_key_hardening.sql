-- ============================================================================
-- Migration: 0208_api_key_hardening
-- Project:   Looplet Accounting  (finish-line: P0-07 — API-key storage + rate-
--            limit hardening)
-- Purpose:   Lock down the external-connector API-key surface (api_keys, the
--            rate-limit RPC, and the lifecycle RPCs) so the secret material is
--            never exposed and the key lifecycle is forced through the RPCs.
--
--   BACKGROUND
--   ----------
--   migration 0001 grants the `authenticated` role table-wide privileges on
--   EVERY public table:
--       GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO authenticated;
--   and migration 0205 grants `connector` (the read-only PostgREST role for
--   connector tokens, a NOINHERIT member of `authenticated`):
--       GRANT SELECT ON ALL TABLES IN SCHEMA public TO connector;
--   The 0056 RLS policies then scope api_keys rows to the caller's own org. Net
--   effect today:
--     * an interactive user (or a connector token over /rest/v1) can
--         SELECT hashed_key FROM api_keys
--       for their own org and recover the SHA-256 of every key's secret — the
--       one piece of material that must never leave the service role. Although
--       only the hash is stored, exposing it lets an attacker mount an offline
--       brute force against the 128-bit secret and removes the "secret shown
--       once" guarantee.
--     * an interactive user can INSERT / UPDATE api_keys directly (bypassing the
--       issue_api_key / revoke_api_key RPCs), e.g. minting a key for their org
--       with arbitrary scopes / no expiry, planting an attacker-known
--       hashed_key, un-revoking a revoked key (clear revoked_at), or bumping
--       rate_limit_per_min — none of which should be possible outside the RPCs.
--     * issue_api_key() only checks org *membership*, so any member (viewer /
--       employee) could mint a connector key for the org. Key issuance is an
--       admin/owner action.
--     * issue_api_key() / api_key_rate_limit() pin `SET search_path = public`,
--       but their pgcrypto calls (gen_random_bytes / digest) resolve from the
--       `extensions` schema (0068 created pgcrypto WITH SCHEMA extensions). This
--       is the exact mismatch fixed for the sibling issue_receipt_identity() in
--       0179. We fully schema-qualify the pgcrypto calls AND widen the pinned
--       path to `public, extensions` so the function is correct and is not
--       exposed to a search_path-shadowing escalation.
--
--   FIX (this migration)
--   --------------------
--   (a) api_key_rate_limit() — re-assert SECURITY DEFINER + pinned search_path,
--       and harden EXECUTE grants: service_role only; REVOKE from
--       PUBLIC/anon/authenticated/connector. Per the DEFINER-grant gotcha, a
--       blanket REVOKE FROM PUBLIC alone can leave a direct grant in place, so we
--       revoke each principal explicitly. The edge functions call it under the
--       service role.
--   (b) hashed_key is no longer SELECTable by authenticated / anon / connector.
--       A column-level REVOKE narrows the table-wide SELECT from 0001/0205 so a
--       `SELECT *` (or an explicit `SELECT hashed_key`) is denied (SQLSTATE
--       42501) for those roles, while every other column stays readable for the
--       org-scoped dashboard listing. The gateway reads hashed_key under
--       service_role, which is unaffected.
--   (c) Direct INSERT / UPDATE / DELETE on api_keys is revoked from authenticated
--       / anon / connector, forcing the whole key lifecycle through the
--       SECURITY DEFINER RPCs (issue_api_key / revoke_api_key), which run as the
--       function owner and so are unaffected by these table grants. The now-dead
--       0056 insert/update RLS policies are dropped to make the intent explicit
--       (the SELECT policy stays so members can still list their keys).
--   (d) issue_api_key() now requires admin/owner on the target org
--       (require_role(p_organization_id, 'admin')) and fully schema-qualifies its
--       pgcrypto calls with the widened `public, extensions` search_path.
--
--   NOTE: hashed_key is NEVER returned to clients by anything here — the secret
--   is minted, hashed, and the plaintext returned exactly once by issue_api_key.
--
--   Idempotent: CREATE OR REPLACE + guarded REVOKE/GRANT + DROP POLICY IF EXISTS
--   are all re-runnable, so `supabase db push` no-ops on an already-patched DB.
--   Live-proof is deploy-gated (no DB here): see the slice's live_proof for the
--   issue/use/rate-limit/revoke/expired walk recorded in api_request_log and the
--   direct-table escalation attempts that must fail.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- (a) api_key_rate_limit(): re-assert the definer + pinned path, harden grants.
--     Body is byte-for-byte the 0068 definition (no pgcrypto here; make_interval
--     / now() are pg_catalog built-ins, so `search_path = public` is sufficient
--     and unchanged). Returns true iff the call is allowed. EXECUTE is hardened
--     to service_role only below.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_key_rate_limit(
  p_key_id uuid,
  p_window_seconds integer DEFAULT 60
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit   integer;
  v_started timestamptz;
  v_count   integer;
  v_now     timestamptz := now();
BEGIN
  SELECT rate_limit_per_min, rate_window_started_at, rate_count
    INTO v_limit, v_started, v_count
    FROM public.api_keys
   WHERE id = p_key_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Start a fresh window if none yet or the current one has elapsed.
  IF v_started IS NULL OR v_now - v_started >= make_interval(secs => p_window_seconds) THEN
    UPDATE public.api_keys
       SET rate_window_started_at = v_now,
           rate_count = 1
     WHERE id = p_key_id;
    RETURN true;
  END IF;

  IF v_count >= v_limit THEN
    RETURN false;  -- over the ceiling; do NOT increment
  END IF;

  UPDATE public.api_keys
     SET rate_count = rate_count + 1
   WHERE id = p_key_id;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.api_key_rate_limit(uuid, integer) IS
  'Atomic per-key fixed-window rate limiter (check-and-increment). SECURITY '
  'DEFINER, pinned search_path, service_role-only EXECUTE: called only by the '
  'edge functions (api-gateway / ingest) under the service role.';

-- ----------------------------------------------------------------------------
-- (d) issue_api_key(): require admin/owner + schema-qualify pgcrypto.
--     Adds a require_role(org,'admin') guard on top of the existing org-access
--     check, fully qualifies gen_random_bytes/digest to the extensions schema,
--     and widens the pinned path so the qualified calls always resolve. Body is
--     otherwise the 0068 definition; signature + return type are preserved.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_api_key(
  p_organization_id uuid,
  p_name            text,
  p_scopes          text[] DEFAULT '{}',
  p_expires_at      timestamptz DEFAULT NULL,
  p_rate_limit_per_min integer DEFAULT 120
) RETURNS TABLE (api_key text, key_prefix text, id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_prefix text;
  v_secret text;
  v_hash   text;
  v_id     uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'organization not accessible'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Issuing a connector key is an admin/owner action: a key grants full-org
  -- read over PostgREST and (scope-gated) writes via ingest, so a viewer /
  -- employee must not be able to mint one.
  IF NOT public.require_role(p_organization_id, 'admin'::org_role) THEN
    RAISE EXCEPTION 'insufficient role: issuing an API key requires admin or owner'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- "llp_" + 8 hex chars of public prefix; 32 hex chars (128-bit) of secret.
  -- pgcrypto (gen_random_bytes / digest) is fully schema-qualified to extensions
  -- so the call cannot be shadowed via an attacker-controlled search_path.
  v_prefix := 'llp_' || substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 8);
  v_secret := encode(extensions.gen_random_bytes(16), 'hex');
  v_hash   := encode(extensions.digest(v_secret, 'sha256'), 'hex');

  INSERT INTO public.api_keys (organization_id, name, key_prefix, hashed_key, scopes,
                               created_by, expires_at, rate_limit_per_min)
  VALUES (p_organization_id, p_name, v_prefix, v_hash, COALESCE(p_scopes, '{}'),
          auth.uid(), p_expires_at, greatest(1, p_rate_limit_per_min))
  RETURNING public.api_keys.id INTO v_id;

  RETURN QUERY SELECT (v_prefix || '.' || v_secret), v_prefix, v_id;
END;
$$;

COMMENT ON FUNCTION public.issue_api_key(uuid, text, text[], timestamptz, integer) IS
  'Mint an org-bound connector API key, returning the plaintext secret exactly '
  'once. SECURITY DEFINER; requires the caller to be admin/owner of the target '
  'org (require_role). Only the SHA-256 hash is persisted.';

-- ----------------------------------------------------------------------------
-- (a cont.) EXECUTE grants on the rate-limit RPC: service_role only.
--   The 0068 definition revoked PUBLIC/anon/authenticated at create time, but a
--   later blanket grant could re-expose it and the DEFINER-grant default can
--   leave a direct PUBLIC grant. Re-assert defensively, revoking each principal
--   explicitly (incl. the connector role from 0205) before the service_role grant.
-- ----------------------------------------------------------------------------
DO $harden$
DECLARE
  v_rl_sig    text := 'public.api_key_rate_limit(uuid,integer)';
  v_issue_sig text := 'public.issue_api_key(uuid,text,text[],timestamptz,integer)';
BEGIN
  IF to_regprocedure(v_rl_sig) IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC;', v_rl_sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon;', v_rl_sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated;', v_rl_sig);
    -- connector may not exist on a partially-reset DB; guard it.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'connector') THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM connector;', v_rl_sig);
    END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role;', v_rl_sig);
  ELSE
    RAISE NOTICE 'Skipping % (not found in this database)', v_rl_sig;
  END IF;

  -- issue_api_key keeps authenticated EXECUTE (the in-body admin guard is the
  -- real protection) + service_role; strip PUBLIC/anon defensively.
  IF to_regprocedure(v_issue_sig) IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon;', v_issue_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role;', v_issue_sig);
  ELSE
    RAISE NOTICE 'Skipping % (not found in this database)', v_issue_sig;
  END IF;
END
$harden$;

-- ----------------------------------------------------------------------------
-- (b) Hide hashed_key from interactive / connector reads.
--   Column-level REVOKE narrows the table-wide SELECT granted by 0001 (to
--   authenticated/anon) and 0205 (to connector). After this, `SELECT *` or any
--   query touching hashed_key is denied (42501) for these roles; every other
--   column stays readable (org-scoped via the api_keys_select RLS policy). The
--   gateway reads hashed_key under service_role, which is untouched.
-- ----------------------------------------------------------------------------
REVOKE SELECT (hashed_key) ON public.api_keys FROM authenticated;
REVOKE SELECT (hashed_key) ON public.api_keys FROM anon;
DO $hide$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'connector') THEN
    REVOKE SELECT (hashed_key) ON public.api_keys FROM connector;
  END IF;
END
$hide$;

-- ----------------------------------------------------------------------------
-- (c) Force the key lifecycle through the RPCs: no direct table writes.
--   Revoke INSERT/UPDATE/DELETE on api_keys from authenticated/anon/connector.
--   issue_api_key / revoke_api_key are SECURITY DEFINER (run as the function
--   owner) and api_key_rate_limit updates the counter under service_role, so all
--   legitimate writes still work. service_role retains GRANT ALL from 0001.
-- ----------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON public.api_keys FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.api_keys FROM anon;
DO $nowrite$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'connector') THEN
    REVOKE INSERT, UPDATE, DELETE ON public.api_keys FROM connector;
  END IF;
END
$nowrite$;

-- The 0056 insert/update RLS policies are now unreachable (no role holds the
-- underlying table grant), so drop them to keep the policy set honest. The
-- SELECT policy stays: members still list their org's keys (minus hashed_key).
DROP POLICY IF EXISTS api_keys_insert ON public.api_keys;
DROP POLICY IF EXISTS api_keys_update ON public.api_keys;

-- Make PostgREST pick up the changed function signatures / grants immediately.
NOTIFY pgrst, 'reload schema';

COMMIT;
