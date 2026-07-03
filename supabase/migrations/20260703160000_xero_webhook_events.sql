-- xero_webhook_events — durable landing table for Xero webhook deliveries.
--
-- Mirrors bank_events_raw (0217): append-only, RLS-scoped, service-role write.
-- The xero-webhook edge function verifies the HMAC x-xero-signature, then
-- best-effort inserts each verified delivery here so no event is lost. Turning
-- these into live syncs (map tenantId → xero_integrations → fetch changed
-- resources) is a follow-up; processed_at is reserved for that worker.
--
-- Timestamped filename (not a 0NNN number) to avoid cross-worktree migration
-- number collisions on the shared prod DB — see the three-worktree note.

BEGIN;

CREATE TABLE IF NOT EXISTS public.xero_webhook_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        REFERENCES organizations(id),  -- nullable until tenant-mapped
  provider_event_id text        NOT NULL,
  payload_hash      text        NOT NULL,
  event_count       integer     NOT NULL DEFAULT 0,
  processed_at      timestamptz,
  raw_payload       jsonb       NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  -- Deduplicates exact re-deliveries. Both columns are NOT NULL so there is no
  -- NULL-distinct gap (unlike bank_events_raw's nullable-org case).
  CONSTRAINT xero_webhook_events_dedup UNIQUE (provider_event_id, payload_hash)
);

ALTER TABLE public.xero_webhook_events ENABLE ROW LEVEL SECURITY;

-- Org members read only their own events (once tenant-mapped). Null-org rows
-- are excluded naturally: NULL IN (SELECT ...) is NULL → false. service_role
-- bypasses RLS for the webhook insert and any processing worker.
CREATE POLICY "org members read xero_webhook_events"
  ON public.xero_webhook_events FOR SELECT
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

GRANT SELECT ON public.xero_webhook_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.xero_webhook_events TO service_role;
REVOKE INSERT, UPDATE, DELETE ON public.xero_webhook_events FROM authenticated, anon;

CREATE INDEX IF NOT EXISTS idx_xero_webhook_events_unprocessed
  ON public.xero_webhook_events (received_at)
  WHERE processed_at IS NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
