-- 0212_basiq_durability.sql
-- Basiq bank-feed durability hardening.
--
-- WHY: the bank-* edge functions (bank-sync, bank-exchange, bank-discover,
-- bank-job-poll, _shared/basiq/client.ts) READ and WRITE
-- organizations.basiq_user_id, but NO migration ever creates that column. On a
-- live DB the column exists (applied out of band, like 0007/0008), so prod
-- works — but a fresh `supabase db reset` / clean deploy fails the moment
-- getOrCreateBasiqUser() selects basiq_user_id. This migration makes the column
-- part of the tracked schema so a fresh deploy stands up the bank feed.
--
-- It also adds the durability ledger the feed previously lacked:
--   * bank_link_jobs       — durable record of each Basiq Connect/auth_link job
--                            (bank-job-poll polled Basiq directly with nothing
--                            persisted, so a crashed poll lost the job entirely).
--   * bank_sync_runs       — one row per bank-sync invocation: idempotent,
--                            replayable, auditable (which connection, how many
--                            txns inserted/deduped, error, duration).
--   * bank_webhook_events  — bank-webhook persists the inbound event BEFORE it
--                            acks Basiq, so a crash after ack never silently
--                            drops an event; replays dedupe on the provider
--                            event id.
--
-- All statements are idempotent (IF NOT EXISTS / guarded DO blocks) so this is
-- safe to apply against the live DB where basiq_user_id already exists.
-- Style mirrors 0007/0008 (banking backfill) and 0187 (receipt POS reliability).

-- ---------------------------------------------------------------------------
-- (a) organizations.basiq_user_id — the column code already depends on.
-- ---------------------------------------------------------------------------
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS basiq_user_id text;

COMMENT ON COLUMN public.organizations.basiq_user_id IS
  'Per-org Basiq user id. Created once via POST /users (getOrCreateBasiqUser) and '
  'reused for every bank connection the org makes. Basiq auth is org-level (server '
  'token), so this is the join key between Looplet orgs and Basiq connections.';

-- One Basiq user per org. Partial unique so multiple orgs with NULL (not yet
-- connected) coexist, but a given basiq user id can never map to two orgs.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_basiq_user_id_key
  ON public.organizations (basiq_user_id)
  WHERE basiq_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- (b1) bank_link_jobs — durable Connect/auth_link job ledger.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bank_link_jobs (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  provider           public.bank_provider NOT NULL DEFAULT 'basiq',
  -- Basiq job id (from auth_link / Connect callback). Unique per provider so a
  -- replayed poll of the same job is a no-op upsert, not a duplicate row.
  external_job_id    text NOT NULL,
  basiq_user_id      text,
  status             text NOT NULL DEFAULT 'pending',
  -- Resolved connection id once the job succeeds (bank-job-poll fills this in).
  connection_external_id text,
  last_error         text,
  attempts           integer NOT NULL DEFAULT 0,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  created_by         uuid,
  CONSTRAINT bank_link_jobs_pkey PRIMARY KEY (id),
  CONSTRAINT bank_link_jobs_provider_job_key UNIQUE (provider, external_job_id),
  CONSTRAINT bank_link_jobs_status_check
    CHECK (status IN ('pending', 'processing', 'active', 'failed', 'expired')),
  CONSTRAINT bank_link_jobs_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT bank_link_jobs_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_bank_link_jobs_org_status
  ON public.bank_link_jobs (organization_id, status, created_at DESC);

ALTER TABLE public.bank_link_jobs ENABLE ROW LEVEL SECURITY;

-- Members may read their org's link jobs (the UI polls status). Writes are
-- service-role only (bank-job-poll / bank-exchange run with service_role),
-- so no INSERT/UPDATE/DELETE policy is granted to authenticated.
DO $$ BEGIN
  CREATE POLICY bank_link_jobs_select ON public.bank_link_jobs
    FOR SELECT TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- (b2) bank_sync_runs — one auditable row per bank-sync execution.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bank_sync_runs (
  id                    uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  bank_connection_id    uuid,
  -- Caller-supplied idempotency key. When two invocations share a key (e.g. a
  -- webhook replay) we record both runs but can correlate / dedupe on it.
  idempotency_key       text,
  trigger_source        text NOT NULL DEFAULT 'manual',
  status                text NOT NULL DEFAULT 'running',
  from_date             date,
  accounts_updated      integer NOT NULL DEFAULT 0,
  transactions_inserted integer NOT NULL DEFAULT 0,
  transactions_deduped  integer NOT NULL DEFAULT 0,
  transactions_skipped  integer NOT NULL DEFAULT 0,
  last_error            text,
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  CONSTRAINT bank_sync_runs_pkey PRIMARY KEY (id),
  CONSTRAINT bank_sync_runs_status_check
    CHECK (status IN ('running', 'success', 'partial', 'error')),
  CONSTRAINT bank_sync_runs_trigger_source_check
    CHECK (trigger_source IN ('manual', 'webhook', 'cron', 'exchange', 'discover')),
  CONSTRAINT bank_sync_runs_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT bank_sync_runs_bank_connection_id_fkey
    FOREIGN KEY (bank_connection_id) REFERENCES public.bank_connections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bank_sync_runs_org_time
  ON public.bank_sync_runs (organization_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_sync_runs_conn_time
  ON public.bank_sync_runs (bank_connection_id, started_at DESC)
  WHERE bank_connection_id IS NOT NULL;

ALTER TABLE public.bank_sync_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY bank_sync_runs_select ON public.bank_sync_runs
    FOR SELECT TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- (c) bank_webhook_events — persist-before-ack store for Basiq webhooks.
-- ---------------------------------------------------------------------------
-- bank-webhook writes the raw inbound event here BEFORE it returns 200 to
-- Basiq. If the function crashes after acking, the event is already durable and
-- can be reprocessed. Replays of the SAME provider event are deduped on
-- (provider, external_event_id) via the partial unique index below.
--
-- HMAC NOTE: Basiq's webhook delivery does NOT include a per-request HMAC
-- signature header in the v3 API — authenticity is enforced via the
-- pre-registered HTTPS callback URL plus a shared secret carried in the URL
-- query (?token=...), which bank-webhook verifies fail-closed against
-- BASIQ_WEBHOOK_VERIFY_TOKEN. We still persist a signature column so that if a
-- provider (or a future Basiq version) does send an HMAC we can record the raw
-- signature for audit; verifyWebhookSignature() in _shared/basiq/durability.ts
-- performs constant-time HMAC-SHA256 verification when a secret + signature are
-- both present, and otherwise falls back to the documented URL-token gate.
CREATE TABLE IF NOT EXISTS public.bank_webhook_events (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  provider           public.bank_provider NOT NULL DEFAULT 'basiq',
  -- Basiq event id when present; else a derived hash (see durability.ts).
  external_event_id  text NOT NULL,
  event_type         text NOT NULL,
  -- May be null at receive time — we still persist the event and resolve the
  -- org/connection during processing.
  organization_id    uuid,
  bank_connection_id uuid,
  connection_external_id text,
  signature          text,
  status             text NOT NULL DEFAULT 'received',
  action             text,
  error              text,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  CONSTRAINT bank_webhook_events_pkey PRIMARY KEY (id),
  CONSTRAINT bank_webhook_events_status_check
    CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  CONSTRAINT bank_webhook_events_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE SET NULL,
  CONSTRAINT bank_webhook_events_bank_connection_id_fkey
    FOREIGN KEY (bank_connection_id) REFERENCES public.bank_connections(id) ON DELETE SET NULL
);

-- Dedupe replays on the provider event id. Partial so future rows that somehow
-- lack an id are still insertable (the app always supplies one).
CREATE UNIQUE INDEX IF NOT EXISTS bank_webhook_events_provider_event_key
  ON public.bank_webhook_events (provider, external_event_id)
  WHERE external_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bank_webhook_events_status_time
  ON public.bank_webhook_events (status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_webhook_events_org_time
  ON public.bank_webhook_events (organization_id, received_at DESC)
  WHERE organization_id IS NOT NULL;

ALTER TABLE public.bank_webhook_events ENABLE ROW LEVEL SECURITY;

-- Members may read their org's webhook events for diagnostics; null-org events
-- (unmatched) are visible only via service_role (which bypasses RLS). Writes
-- are service-role only (bank-webhook), so no write policy for authenticated.
DO $$ BEGIN
  CREATE POLICY bank_webhook_events_select ON public.bank_webhook_events
    FOR SELECT TO authenticated
    USING (
      organization_id IS NOT NULL
      AND organization_id IN (SELECT public.get_accessible_org_ids())
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- (d) Idempotent sync — dedupe by external id.
-- ---------------------------------------------------------------------------
-- bank_transactions already enforces UNIQUE (bank_account_id, external_id) via
-- bank_transactions_bank_account_id_external_id_key (migration 0008), which is
-- exactly the dedupe key bank-sync upserts on (onConflict:
-- 'bank_account_id,external_id'). Re-assert it defensively so a fresh deploy
-- that somehow lost it still gets a dedupe guarantee; this no-ops where the
-- named constraint from 0008 exists.
CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_acct_external_uniq
  ON public.bank_transactions (bank_account_id, external_id);
