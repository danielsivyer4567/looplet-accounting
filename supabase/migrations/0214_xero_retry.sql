-- 0214_xero_retry.sql  (P1-08 — Xero durable retry/backfill + stable idempotency keys)
--
-- PROBLEM (duplicate invoices on retry):
--   The xero-push-bill / xero-push-invoice edge functions minted a fresh
--   `crypto.randomUUID()` as the Xero `Idempotency-Key` header on EVERY attempt.
--   Xero's idempotency contract keys on that header — a POST replaying a
--   previously-seen key returns the already-created invoice instead of creating
--   a new one. With a random key per attempt that protection never engaged, so a
--   retry after a network timeout / "unknown result" (Xero may have committed the
--   invoice but the HTTP response was lost) created a DUPLICATE ACCPAY/ACCREC.
--   Push state also lived only in `bills.metadata->>'xero_attempts'` /
--   `invoices.metadata` — no durable, queryable retry surface, and no place to
--   pin the stable key so concurrent/duplicate invocations agree on it.
--
-- FIX (this migration):
--   1. `xero_push_queue` — one durable row per (organization, record_type,
--      record_id) logical push. Holds the STABLE idempotency_key (derived in
--      _shared/xero/idempotency.ts from org+kind+id), status, attempt count,
--      last_error, last_http_status and the resolved xero_invoice_id. The edge
--      functions upsert this row before each attempt and ALWAYS reuse the stored
--      idempotency_key, so a retry replays the same Xero header and Xero dedupes
--      server-side. UNIQUE (organization_id, record_type, record_id) is the
--      natural key; idempotency_key is independently UNIQUE.
--   2. `v_xero_pending_pushes` is rebuilt so the invoice branch ALSO surfaces
--      `failed` rows (the bill branch already did) — i.e. attached-but-failed
--      pushes are reconciled and re-attempted, not silently dropped.
--
-- NOTE on the two "idempotency keys": this queue's stable key is the Xero HTTP
-- header value (same across retries). `xero_sync_log.idempotency_key` (0001) is a
-- per-attempt UNIQUE audit id and stays a fresh random UUID per appended row —
-- the two are deliberately distinct and must not be merged.
--
-- Fidelity: idempotent + additive. No existing table/column dropped; the view is
-- CREATE OR REPLACE with an additive predicate change only. Migrations can't be
-- live-tested here — style mirrors 0044_xero_sync / 0187_receipt_pos_reliability.
-- Live proof is deploy-gated (Xero demo company: retry produces no duplicate).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. xero_push_queue — durable per-entity push state + stable idempotency key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.xero_push_queue (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  record_type      TEXT NOT NULL CHECK (record_type IN ('bill', 'invoice')),
  record_id        UUID NOT NULL,
  -- STABLE Xero Idempotency-Key header value: derived deterministically from
  -- org+record_type+record_id, so every retry of this push reuses it and Xero
  -- returns the existing invoice instead of creating a duplicate.
  idempotency_key  UUID NOT NULL,
  status           sync_status NOT NULL DEFAULT 'pending',  -- pending|synced|failed|amended|voided
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  last_error       TEXT,
  last_http_status INTEGER,                                  -- 401/429/5xx of the last failed attempt
  xero_invoice_id  TEXT,                                     -- set once Xero confirms the push
  next_attempt_at  TIMESTAMPTZ,                              -- backoff hint for the retry sweep
  last_attempt_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One logical push per source entity. Edge fns upsert on this key.
  UNIQUE (organization_id, record_type, record_id),
  -- The Xero header value is globally unique to this push.
  UNIQUE (idempotency_key)
);
COMMENT ON TABLE public.xero_push_queue IS
  'Durable per-entity Xero push state. idempotency_key is the STABLE Xero '
  'Idempotency-Key header reused across retries to prevent duplicate invoices.';
COMMENT ON COLUMN public.xero_push_queue.idempotency_key IS
  'Deterministic Xero Idempotency-Key (org+record_type+record_id). REUSED on '
  'every retry so Xero dedupes server-side. Never randomised per attempt.';

-- Retry sweep: rows still owed a push (not synced, under the attempt cap).
CREATE INDEX IF NOT EXISTS xero_push_queue_due_idx
  ON public.xero_push_queue (organization_id, next_attempt_at)
  WHERE status IN ('pending', 'failed') AND attempts < max_attempts;

CREATE INDEX IF NOT EXISTS xero_push_queue_record_idx
  ON public.xero_push_queue (record_type, record_id);

-- updated_at trigger (set_updated_at exists from 0001).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_xero_push_queue_set_updated_at'
  ) THEN
    CREATE TRIGGER trg_xero_push_queue_set_updated_at
      BEFORE UPDATE ON public.xero_push_queue
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- RLS: org-scoped reads for the UI; writes go through service_role (edge fns).
ALTER TABLE public.xero_push_queue ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'xero_push_queue' AND policyname = 'xero_push_queue_select'
  ) THEN
    CREATE POLICY xero_push_queue_select ON public.xero_push_queue
      FOR SELECT USING (organization_id IN (SELECT public.get_accessible_org_ids()));
  END IF;
END $$;

-- Reads only for authenticated; the edge fns mutate as service_role. We do NOT
-- grant INSERT/UPDATE to authenticated — the stable key is service-managed and a
-- client must never be able to forge or churn it.
GRANT SELECT ON public.xero_push_queue TO authenticated;
GRANT ALL    ON public.xero_push_queue TO service_role;

-- ---------------------------------------------------------------------------
-- 2. v_xero_pending_pushes — include attached-but-FAILED invoices so the retry
--    sweep reconciles them (the bill branch already surfaced 'failed'; the
--    invoice branch only surfaced NULL/'pending', so failed invoice pushes were
--    silently dropped from the queue). Additive predicate change only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_xero_pending_pushes AS
  SELECT
    'bill'::TEXT            AS record_type,
    b.id                    AS record_id,
    b.organization_id,
    b.total_inc_gst_cents   AS amount_cents,
    b.invoice_date          AS doc_date,
    b.xero_status::TEXT,
    b.xero_invoice_id,
    b.supplier_name_raw     AS counterparty_name
  FROM public.bills b
  WHERE b.deleted_at IS NULL
    AND b.status = 'paid'
    AND (b.xero_status IS NULL OR b.xero_status IN ('pending', 'failed'))

  UNION ALL

  SELECT
    'invoice'::TEXT         AS record_type,
    i.id                    AS record_id,
    i.organization_id,
    i.total_inc_gst_cents   AS amount_cents,
    i.issue_date            AS doc_date,
    i.xero_status::TEXT,
    i.xero_invoice_id,
    c.name                  AS counterparty_name
  FROM public.invoices i
  LEFT JOIN public.customers c ON c.id = i.customer_id
  WHERE i.deleted_at IS NULL
    AND i.status IN ('sent', 'paid', 'partially_paid')
    -- include 'failed' so attached-but-failed pushes are reconciled & retried
    AND (i.xero_status IS NULL OR i.xero_status IN ('pending', 'failed'));

COMMENT ON VIEW public.v_xero_pending_pushes IS
  'Bills (paid) + invoices (sent/paid) awaiting Xero sync, INCLUDING failed '
  'pushes so the retry sweep reconciles attached-but-failed records.';

GRANT SELECT ON public.v_xero_pending_pushes TO authenticated;
GRANT SELECT ON public.v_xero_pending_pushes TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
