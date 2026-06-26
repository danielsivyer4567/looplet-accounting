-- 0111: legal_change_events — the append-only ledger of detected legal changes,
-- plus notify_legal_change(): the single sanctioned write path + the forward-
-- compatible hook point for flagging downstream consumers.
--
-- Phase E of the legal-citation / RAG engine. When the corpus-sync (SC-LC.E.03)
-- finds a section whose text changed, it version-bumps legal_corpus (0108) AND
-- records WHAT changed here: one row per (instrument, section) change, linking the
-- superseded chunk (old_chunk_id) to its successor (new_chunk_id). The horizon
-- reconcile (SC-LC.F.03) and the future advice/babysitter track read this ledger
-- to know "this section moved — re-check anything that cited it".
--
-- GLOBAL REFERENCE DATA — the law (and its change history) is the same for every
-- tenant: NOT org-scoped, RLS = SELECT-to-authenticated USING(true), writes go
-- through notify_legal_change() / service_role only. No organization_id → no
-- audit_log_trigger_v2 (matches legal_corpus 0108 / legal_sources 0110); the
-- append-only ledger IS its own audit trail.
--
-- The chunk ids are deliberately NOT foreign keys to legal_corpus: this is an
-- immutable audit ledger that must keep resolving even if the corpus is re-seeded
-- /re-embedded (which mints new chunk ids), so it stays decoupled from chunk
-- lifecycle (same no-FK stance as the global corpus itself).

CREATE TABLE IF NOT EXISTS public.legal_change_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_ref        text NOT NULL,                 -- the instrument, e.g. 'ITAA 1997'
  section_ref    text NOT NULL,                 -- the pinpoint, e.g. 's 328-180'
  change_kind    text NOT NULL CHECK (change_kind IN ('new', 'amended', 'repealed')),
  old_chunk_id   uuid,                          -- the superseded version (NULL for a 'new' section)
  new_chunk_id   uuid,                          -- the successor version (NULL for a 'repealed' section)
  detected_at    timestamptz NOT NULL DEFAULT now(),  -- when the sync detected the change
  effective_from date,                          -- when the change takes effect (the new version's commencement)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES auth.users(id),
  deleted_at     timestamptz
);

-- The propagation lookup: "which changes affected this section?" (NOT unique — a
-- section can legitimately change many times over the years, each its own event).
CREATE INDEX IF NOT EXISTS legal_change_events_section_idx
  ON public.legal_change_events (doc_ref, section_ref, detected_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.legal_change_events IS
  'Append-only ledger of detected AU tax-law changes (one row per section change, old_chunk_id → new_chunk_id). GLOBAL reference data: SELECT to authenticated, writes via notify_legal_change()/service_role. Read by the horizon reconcile (F.03) + the future advice track to re-check citations of a changed section.';

DROP TRIGGER IF EXISTS trg_legal_change_events_updated_at ON public.legal_change_events;
CREATE TRIGGER trg_legal_change_events_updated_at
  BEFORE UPDATE ON public.legal_change_events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- GLOBAL RLS: everyone reads the change history; writes are backend-only.
ALTER TABLE public.legal_change_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legal_change_events_select ON public.legal_change_events;
CREATE POLICY legal_change_events_select ON public.legal_change_events
  FOR SELECT TO authenticated
  USING (true);
GRANT SELECT ON public.legal_change_events TO authenticated;

-- notify_legal_change(): record one change event and return its id. This is the
-- STABLE write API the sync calls — keep its signature fixed (the later advisory
-- track binds to it). The "flag consumers" step is a FORWARD-COMPATIBLE no-op:
-- advice_notes does not exist yet, so the only effect today is the ledger insert;
-- when that track lands, the flagging of notes citing (doc_ref, section_ref) is
-- added below (or a trigger on this table) WITHOUT changing this signature.
CREATE OR REPLACE FUNCTION public.notify_legal_change(
  p_doc_ref        text,
  p_section_ref    text,
  p_change_kind    text,
  p_old_chunk_id   uuid DEFAULT NULL,
  p_new_chunk_id   uuid DEFAULT NULL,
  p_effective_from date DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_id uuid;
BEGIN
  INSERT INTO public.legal_change_events
    (doc_ref, section_ref, change_kind, old_chunk_id, new_chunk_id, effective_from)
  VALUES
    (p_doc_ref, p_section_ref, p_change_kind, p_old_chunk_id, p_new_chunk_id, p_effective_from)
  RETURNING id INTO v_event_id;

  -- FORWARD-COMPATIBLE HOOK (no-op today): advice_notes does not exist yet. When
  -- the advisory/babysitter track lands, flag any note citing (p_doc_ref,
  -- p_section_ref) as "law moved — re-verify" right here. Until then, recording
  -- the event IS the propagation (consumers poll the ledger).

  RETURN v_event_id;
END;
$$;

-- 0060 hardening, locked to the BACKEND WRITE PATH (service_role only). NOTE: this
-- project's default privileges GRANT EXECUTE on new public functions to authenticated
-- + anon, so `REVOKE FROM PUBLIC` alone is NOT enough for a service_role-only write fn
-- (a logged-in user could otherwise call this DEFINER fn and spoof change events) —
-- the authenticated/anon roles must be revoked explicitly.
REVOKE ALL ON FUNCTION public.notify_legal_change(text, text, text, uuid, uuid, date) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.notify_legal_change(text, text, text, uuid, uuid, date) TO service_role;

NOTIFY pgrst, 'reload schema';
