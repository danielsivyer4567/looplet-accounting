-- SC-06: Immutable raw bank event layer + idempotency
-- Adds bank_events_raw table, raw_event_id FK on bank_transactions,
-- and replay_bank_event RPC.

BEGIN;

-- ---------------------------------------------------------------------------
-- bank_events_raw — append-only landing table for every raw bank provider
-- event (Basiq webhooks, individual raw transactions). Rows are never deleted;
-- this is the audit and replay source of truth.
--
-- organization_id is nullable: webhook events whose connectionId has no
-- matching bank_connections row are stored with organization_id = NULL so
-- they are never silently dropped. They carry no tenant-read policy until
-- matched; service_role can access them for investigation/replay.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_events_raw (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        REFERENCES organizations(id),  -- nullable for unmatched webhooks
  provider          text        NOT NULL,
  provider_event_id text        NOT NULL,
  payload_hash      text        NOT NULL,
  raw_payload       jsonb       NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  -- Deduplicates exact re-deliveries of the same event+payload for a known org.
  -- Different payload → new row (tracks payload evolution).
  CONSTRAINT bank_events_raw_dedup UNIQUE (provider, organization_id, provider_event_id, payload_hash)
);

-- Safety: if an earlier draft of this migration created the table with
-- organization_id NOT NULL, the CREATE TABLE IF NOT EXISTS above will leave
-- the constraint intact. Drop it unconditionally so both fresh and previously-
-- applied databases end up in the same nullable state.
ALTER TABLE public.bank_events_raw
  ALTER COLUMN organization_id DROP NOT NULL;

-- PostgreSQL treats NULLs as DISTINCT in regular UNIQUE constraints, so two
-- rows with (provider, NULL, event_id, hash) would both pass the constraint
-- above. The partial index below closes that gap for unmatched (null-org) rows.
CREATE UNIQUE INDEX IF NOT EXISTS bank_events_raw_dedup_unmatched
  ON bank_events_raw (provider, provider_event_id, payload_hash)
  WHERE organization_id IS NULL;

ALTER TABLE bank_events_raw ENABLE ROW LEVEL SECURITY;

-- Org members can read their own raw events via get_accessible_org_ids().
-- Null-org rows are excluded naturally: NULL IN (SELECT ...) is NULL → false.
-- service_role bypasses RLS and can read all rows.
CREATE POLICY "org members read bank_events_raw"
  ON bank_events_raw FOR SELECT
  USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
  );

-- Explicit grants: authenticated can SELECT (subject to the RLS policy above);
-- service_role gets full access (RLS bypassed by default for service_role).
GRANT SELECT ON public.bank_events_raw TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bank_events_raw TO service_role;

REVOKE INSERT, UPDATE, DELETE ON bank_events_raw FROM authenticated, anon;

CREATE INDEX IF NOT EXISTS idx_bank_events_raw_org_provider
  ON bank_events_raw (organization_id, provider, provider_event_id);

-- ---------------------------------------------------------------------------
-- raw_event_id FK on bank_transactions — links each normalized transaction
-- back to the raw Basiq event it was derived from.
-- ---------------------------------------------------------------------------
ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS raw_event_id uuid REFERENCES bank_events_raw(id);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_raw_event
  ON bank_transactions (raw_event_id)
  WHERE raw_event_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- replay_bank_event — returns the stored raw payload for a given event id so
-- an edge function can re-run normalisation. Does NOT modify bank_transactions;
-- the upsert idempotency in the caller prevents duplicates.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION replay_bank_event(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row bank_events_raw%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM bank_events_raw WHERE id = p_event_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'event not found');
  END IF;

  -- Org isolation: service_role callers have auth.uid() = NULL and can access
  -- any event (including null-org unmatched events). Authenticated users must
  -- belong to the event's org; null-org events are inaccessible to them.
  IF auth.uid() IS NOT NULL THEN
    IF v_row.organization_id IS NULL OR
       v_row.organization_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not authorized');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok',               true,
    'event_id',         v_row.id,
    'provider',         v_row.provider,
    'provider_event_id', v_row.provider_event_id,
    'raw_payload',      v_row.raw_payload,
    'received_at',      v_row.received_at
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION replay_bank_event(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION replay_bank_event(uuid) TO authenticated, service_role;

COMMIT;
