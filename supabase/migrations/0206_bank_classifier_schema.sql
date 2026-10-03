-- 0206: Bank transaction auto-classifier schema.
--
-- Adds two new objects:
--   1. bank_coding_rules  — per-org merchant description patterns → category
--      (the "Xero bank rules" equivalent; written by the classifier on auto-learn
--       or by a human confirming/overriding a suggestion)
--   2. bank_tx_coding_suggestions — parallel to coding_suggestions (0092) but
--      scoped to bank_transactions instead of bills; one live row per txn
--   3. ALTER bank_transactions — adds coding_status + suggested_job_id
--
-- Classifier edge function (bank-transaction-classifier) is the sole writer;
-- clients read via RLS-filtered views / select policies.
-- Reuses: coding_suggestion_status enum (0092), get_accessible_org_ids(),
--         set_updated_at(), audit_log_trigger_v2().

-- ── 1. bank_coding_rules ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bank_coding_rules (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL,
  pattern          text        NOT NULL,  -- merchant description pattern
  match_type       text        NOT NULL DEFAULT 'substring'
                   CHECK (match_type IN ('substring', 'regex')),
  category_code    text        REFERENCES public.intake_categories(code) ON DELETE SET NULL,
  job_id           uuid        REFERENCES public.jobs(id) ON DELETE SET NULL,
  is_personal      boolean     NOT NULL DEFAULT false,
  priority         integer     NOT NULL DEFAULT 0,
  hit_count        integer     NOT NULL DEFAULT 0,
  last_hit_at      timestamptz,
  is_active        boolean     NOT NULL DEFAULT true,
  source           text        NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('manual', 'auto_learn', 'human_confirm', 'human_override')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,

  CONSTRAINT bank_coding_rules_pkey PRIMARY KEY (id),
  CONSTRAINT bank_coding_rules_org_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE
);

-- Soft-delete column (consistent with other tables). MIG-01 repair (2026-10-03):
-- added before the partial index below, which filters on it; the two statements
-- were in the opposite order, so the index failed on a fresh database.
ALTER TABLE public.bank_coding_rules
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS bank_coding_rules_org_active_priority_idx
  ON public.bank_coding_rules (organization_id, priority DESC)
  WHERE is_active = true AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_bank_coding_rules_updated_at ON public.bank_coding_rules;
CREATE TRIGGER trg_bank_coding_rules_updated_at
  BEFORE UPDATE ON public.bank_coding_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_bank_coding_rules_audit ON public.bank_coding_rules;
CREATE TRIGGER trg_bank_coding_rules_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.bank_coding_rules
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

ALTER TABLE public.bank_coding_rules ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY bank_coding_rules_select ON public.bank_coding_rules
    FOR SELECT TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT ON public.bank_coding_rules TO authenticated;

-- ── 2. bank_tx_coding_suggestions ────────────────────────────────────────────
-- Mirrors coding_suggestions (0092) but for bank_transactions.
-- status reuses coding_suggestion_status enum created in 0092.
CREATE TABLE IF NOT EXISTS public.bank_tx_coding_suggestions (
  id                   uuid        NOT NULL DEFAULT gen_random_uuid(),
  organization_id      uuid        NOT NULL,
  bank_transaction_id  uuid        NOT NULL,
  category_code        text        REFERENCES public.intake_categories(code) ON DELETE SET NULL,
  job_id               uuid        REFERENCES public.jobs(id) ON DELETE SET NULL,
  confidence           numeric     NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status               public.coding_suggestion_status NOT NULL DEFAULT 'needs_review',
  rationale            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  applied_rule_id      uuid        REFERENCES public.bank_coding_rules(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at           timestamptz,

  CONSTRAINT bank_tx_coding_suggestions_pkey PRIMARY KEY (id),
  CONSTRAINT bank_tx_coding_suggestions_org_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT bank_tx_coding_suggestions_txn_fkey
    FOREIGN KEY (bank_transaction_id) REFERENCES public.bank_transactions(id) ON DELETE CASCADE
);

-- At most one live suggestion per bank transaction (idempotent classifier runs)
CREATE UNIQUE INDEX IF NOT EXISTS bank_tx_coding_suggestions_txn_uniq
  ON public.bank_tx_coding_suggestions (bank_transaction_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS bank_tx_coding_suggestions_org_status_idx
  ON public.bank_tx_coding_suggestions (organization_id, status, created_at DESC)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_bank_tx_coding_suggestions_updated_at ON public.bank_tx_coding_suggestions;
CREATE TRIGGER trg_bank_tx_coding_suggestions_updated_at
  BEFORE UPDATE ON public.bank_tx_coding_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_bank_tx_coding_suggestions_audit ON public.bank_tx_coding_suggestions;
CREATE TRIGGER trg_bank_tx_coding_suggestions_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.bank_tx_coding_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

ALTER TABLE public.bank_tx_coding_suggestions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY bank_tx_coding_suggestions_select ON public.bank_tx_coding_suggestions
    FOR SELECT TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT ON public.bank_tx_coding_suggestions TO authenticated;

-- ── 3. ALTER bank_transactions ────────────────────────────────────────────────
-- coding_status tracks where the classifier is up to for this transaction.
-- suggested_job_id is the classifier's best job match (temporal + merchant).
ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS coding_status text NOT NULL DEFAULT 'unclassified'
    CHECK (coding_status IN ('unclassified', 'auto_coded', 'suggested', 'needs_review', 'classified')),
  ADD COLUMN IF NOT EXISTS suggested_job_id uuid
    REFERENCES public.jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS suggested_job_score numeric(3,2);

-- Efficient query for "transactions the classifier still needs to process"
CREATE INDEX IF NOT EXISTS bank_txn_coding_status_idx
  ON public.bank_transactions (organization_id, coding_status, posted_at DESC)
  WHERE coding_status IN ('unclassified', 'needs_review');

-- ── 4. bank_tx_coding_queue view ─────────────────────────────────────────────
-- Thin filtered view over bank_tx_coding_suggestions for UI consumption.
-- security_invoker: the caller's RLS on bank_tx_coding_suggestions scopes the
-- view to their orgs (same convention as coding_review_queue in 0092).
DROP VIEW IF EXISTS public.bank_tx_coding_queue;
CREATE VIEW public.bank_tx_coding_queue
  WITH (security_invoker = true) AS
SELECT
  s.id,
  s.organization_id,
  s.bank_transaction_id,
  s.category_code,
  s.job_id,
  s.confidence,
  s.status,
  s.rationale,
  s.applied_rule_id,
  s.created_at,
  s.updated_at,
  -- Denormalised for the UI to avoid a second join
  bt.description         AS txn_description,
  bt.amount_cents        AS txn_amount_cents,
  bt.posted_at           AS txn_posted_at,
  bt.coding_status       AS txn_coding_status,
  bt.suggested_job_id    AS txn_suggested_job_id,
  bt.suggested_job_score AS txn_suggested_job_score,
  ic.label               AS category_label,
  ic.xero_account_code   AS category_xero_account_code
FROM public.bank_tx_coding_suggestions s
JOIN public.bank_transactions  bt ON bt.id = s.bank_transaction_id
LEFT JOIN public.intake_categories ic ON ic.code = s.category_code
WHERE s.status = 'needs_review'
  AND s.deleted_at IS NULL;

GRANT SELECT ON public.bank_tx_coding_queue TO authenticated;

NOTIFY pgrst, 'reload schema';
