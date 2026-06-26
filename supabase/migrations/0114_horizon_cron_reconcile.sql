-- 0114: horizon reconcile + the 3-hourly scanner cron (SC-LC.F.03 — legal-RAG).
--
-- Closes the lifecycle loop of Phase F. The Sonar scanner (SC-LC.F.02) writes
-- PROPOSED, stage-labelled items into legal_horizon (F.01). When the auto-updater
-- (SC-LC.E.03) later detects that a section actually LANDED in the corpus — it
-- version-bumps legal_corpus (0108) and records a legal_change_events row via
-- notify_legal_change() (0111) — we want any matching OPEN horizon item to
-- auto-promote from "proposed (news)" to "enacted (law, cited)". This migration
-- ships two things:
--
--   1. reconcile_horizon_on_enactment(p_corpus_id) + a trigger on
--      legal_change_events that fires it on every enactment ('new'/'amended').
--      ACTIVE on deploy — pure DB objects, safe: the trigger only fires when the
--      (separately-gated) sync inserts a change event, and the fn is a no-op when
--      nothing matches.
--
--   2. An INERT (commented) cron.schedule() for the 3-hourly Sonar scan, mirroring
--      0112 / 0065 — registering it live is a deliberate, separate deploy step.
--
-- GLOBAL reference data (legal_horizon / legal_corpus / legal_change_events are not
-- org-scoped — the law is the same for every tenant). The reconcile is backend-only
-- (SECURITY DEFINER, service_role) like notify_legal_change(); horizon items are
-- NEVER a citation source until reconciled to a real corpus version.
--
-- MATCHING (v1, deliberately CONSERVATIVE — precision over recall): an open horizon
-- item reconciles to the enacting chunk when the chunk's full-text (the existing
-- GIN-indexed legal_corpus.tsv, heading||text) contains ALL the item's topic terms
-- (plainto_tsquery AND-semantics) AND the dates are compatible (the chunk commenced
-- on/around-or-after the item's proposed date, ≤60d grace; null proposed date = text
-- match only). Ambiguous items stay 'open' for the next sync / manual handling — a
-- false "enacted" flip would wrongly present a proposal as settled law. A semantic
-- (embedding) match is the future hardening (recorded in the ledger).

-- ----------------------------------------------------------------------------
-- 1. Reconcile fn + trigger (ACTIVE)
-- ----------------------------------------------------------------------------

-- Promote every OPEN horizon item that matches the just-enacted corpus chunk to
-- stage='enacted'/status='reconciled' and link it. Returns the number reconciled.
CREATE OR REPLACE FUNCTION public.reconcile_horizon_on_enactment(p_corpus_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.legal_horizon h
  SET stage = 'enacted',
      status = 'reconciled',
      reconciled_corpus_id = lc.id,
      last_seen_at = now()
  FROM public.legal_corpus lc
  WHERE lc.id = p_corpus_id
    AND lc.deleted_at IS NULL
    AND h.status = 'open'
    AND h.deleted_at IS NULL
    AND h.topic IS NOT NULL
    AND lc.tsv @@ plainto_tsquery('english', h.topic)              -- reuse the corpus's generated FTS
    AND (h.proposed_effective_from IS NULL
         OR h.proposed_effective_from <= lc.effective_from + INTERVAL '60 days');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 0060 hardening, locked to the BACKEND path (service_role only). Per the recurring
-- gotcha: this project's default privileges grant EXECUTE on new public functions to
-- authenticated + anon directly, so REVOKE FROM PUBLIC alone is NOT enough — a
-- logged-in user could otherwise call this DEFINER fn and forge reconciliations.
REVOKE ALL ON FUNCTION public.reconcile_horizon_on_enactment(uuid) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_horizon_on_enactment(uuid) TO service_role;

-- Trigger glue: on each enactment event ('new'/'amended' carry a successor chunk;
-- 'repealed' has no new_chunk_id), try to reconcile matching horizon items. Runs in
-- the sync's transaction right after the change is recorded.
CREATE OR REPLACE FUNCTION public.tg_reconcile_horizon_on_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.change_kind IN ('new', 'amended') AND NEW.new_chunk_id IS NOT NULL THEN
    PERFORM public.reconcile_horizon_on_enactment(NEW.new_chunk_id);
  END IF;
  RETURN NULL;  -- AFTER trigger: return value ignored
END;
$$;

REVOKE ALL ON FUNCTION public.tg_reconcile_horizon_on_event() FROM PUBLIC, authenticated, anon;

DROP TRIGGER IF EXISTS trg_reconcile_horizon ON public.legal_change_events;
CREATE TRIGGER trg_reconcile_horizon
  AFTER INSERT ON public.legal_change_events
  FOR EACH ROW EXECUTE FUNCTION public.tg_reconcile_horizon_on_event();

-- ----------------------------------------------------------------------------
-- 2. The 3-hourly Sonar scanner cron (INERT — mirrors 0112 / 0065)
-- ----------------------------------------------------------------------------
-- TRACKED FOR LATER — DO NOT RUN AS-IS. The cron.schedule() below is intentionally
-- commented out because
--   (a) legal-horizon-scan must be deployed first (--no-verify-jwt);
--   (b) it needs real <PROJECT_REF> / <LEGAL_SCAN_SECRET> values; and
--   (c) — CRITICAL — PERPLEXITY_API_KEY must be a VALID edge-fn secret. (SC-LC.F.02's
--       check found the LOCAL .env.local key stale; a scan with a bad key just 401s
--       and writes nothing, but verify the live secret is valid before enabling so
--       the 3-hourly run actually populates the horizon.)
-- config.toml sets [functions.legal-horizon-scan] verify_jwt=false so pg_cron can
-- drive it; the fn checks the service-role bearer / ?secret= itself.
--
-- The scanner takes no per-source input (it sweeps the default topics itself), so the
-- cron body is a single POST with an empty JSON body. Runs every 3 hours at minute 0
-- ('0 */3 * * *'), independent of the daily corpus-sync sweep (0112 @ 04:00).
--
-- Before enabling (the deliberate deploy step):
--   1. supabase functions deploy legal-horizon-scan --no-verify-jwt
--   2. supabase secrets set LEGAL_SCAN_SECRET=<random-32-char-string>
--   3. Confirm PERPLEXITY_API_KEY is set + valid (shared with ask-bot / Sonar fns).
--   4. Replace <PROJECT_REF> + <LEGAL_SCAN_SECRET> below and run the cron.schedule()
--      statement once (uncommented).
--
-- ⚠ DO NOT uncomment until legal-horizon-scan is deployed, LEGAL_SCAN_SECRET is set,
-- and PERPLEXITY_API_KEY is a valid edge-fn secret.
-- SELECT cron.schedule(
--   'legal-horizon-scan-3h',
--   '0 */3 * * *',  -- every 3 hours, on the hour
--   $cron$
--     SELECT net.http_post(
--       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/legal-horizon-scan'
--              || '?secret=<LEGAL_SCAN_SECRET>',
--       headers := jsonb_build_object('Content-Type', 'application/json'),
--       body := '{}'::jsonb
--     );
--   $cron$
-- );
-- ----------------------------------------------------------------------------
-- To inspect:
--   SELECT * FROM cron.job WHERE jobname = 'legal-horizon-scan-3h';
--   SELECT * FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'legal-horizon-scan-3h')
--    ORDER BY start_time DESC LIMIT 10;
--
-- To unschedule:
--   SELECT cron.unschedule('legal-horizon-scan-3h');

NOTIFY pgrst, 'reload schema';
