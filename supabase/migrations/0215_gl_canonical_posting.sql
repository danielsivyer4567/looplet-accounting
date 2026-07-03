-- ============================================================================
-- 0215_gl_canonical_posting.sql  (P1-04)
--
-- Canonical GL source-event posting + date-scoped trial balance foundation.
--
-- Existing GL primitives are preserved:
--   * post_journal_entry(uuid) remains the draft -> posted validator.
--   * v_trial_balance remains the cumulative compatibility view.
--
-- This migration adds the durable source-event key that future source posting
-- slices can share, then exposes create_and_post_journal(...) as the atomic path
-- for source events: build a balanced draft, insert lines, and delegate the final
-- posting invariant checks to post_journal_entry().
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Journal provenance / idempotency columns.
-- ---------------------------------------------------------------------------
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS source_event_key text,
  ADD COLUMN IF NOT EXISTS source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.journal_entries.idempotency_key IS
  'Caller-supplied stable idempotency key for canonical source-event posting. '
  'create_and_post_journal requires it and reuses the existing journal entry on retry.';
COMMENT ON COLUMN public.journal_entries.source_event_key IS
  'Canonical per-org source event key used to dedupe source postings. Pattern: '
  'lower(source_type), source_id/no-source-id, and idempotency_key joined by colons.';
COMMENT ON COLUMN public.journal_entries.source_metadata IS
  'Source-event metadata for GL postings, including reversal/correlation hints. '
  'The accounting record remains the posted journal lines; metadata is provenance only.';

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_idempotency_key_not_blank,
  ADD CONSTRAINT journal_entries_idempotency_key_not_blank
    CHECK (idempotency_key IS NULL OR btrim(idempotency_key) <> '');

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_event_key_requires_source,
  ADD CONSTRAINT journal_entries_source_event_key_requires_source
    CHECK (
      source_event_key IS NULL
      OR (
        source_type IS NOT NULL
        AND btrim(source_type) <> ''
        AND idempotency_key IS NOT NULL
        AND btrim(idempotency_key) <> ''
      )
    );

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_event_key_matches_fields,
  ADD CONSTRAINT journal_entries_source_event_key_matches_fields
    CHECK (
      source_event_key IS NULL
      OR source_event_key = (
        lower(btrim(source_type))
        || ':' || COALESCE(source_id::text, 'no-source-id')
        || ':' || btrim(idempotency_key)
      )
    );

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_org_source_event_key_uniq
  ON public.journal_entries (organization_id, source_event_key)
  WHERE source_event_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS journal_entries_org_posted_date_idx
  ON public.journal_entries (organization_id, entry_date, id)
  WHERE status = 'posted';

-- Extend the 0075 posted-entry immutability guard to freeze the new provenance
-- columns too. Without this, a posted journal's idempotency/source metadata
-- could be changed even though the legacy header columns are immutable.
CREATE OR REPLACE FUNCTION public.guard_posted_journal_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION
        'journal entry % is posted and cannot be deleted; reverse it instead',
        OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.status = 'posted' THEN
    -- Permit only posted -> void (cancellation). posted_at is preserved.
    IF NEW.status = 'posted' THEN
      -- No-op status; ensure nothing else changed.
      IF NEW.organization_id  IS DISTINCT FROM OLD.organization_id
         OR NEW.entry_date    IS DISTINCT FROM OLD.entry_date
         OR NEW.memo          IS DISTINCT FROM OLD.memo
         OR NEW.source_type   IS DISTINCT FROM OLD.source_type
         OR NEW.source_id     IS DISTINCT FROM OLD.source_id
         OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
         OR NEW.source_event_key IS DISTINCT FROM OLD.source_event_key
         OR NEW.source_metadata IS DISTINCT FROM OLD.source_metadata
         OR NEW.posted_at     IS DISTINCT FROM OLD.posted_at
         OR NEW.created_at    IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION
          'journal entry % is posted and is immutable; correct it with a reversing entry',
          OLD.id
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NEW.status = 'void' THEN
      -- Allowed transition; freeze every other field.
      IF NEW.organization_id  IS DISTINCT FROM OLD.organization_id
         OR NEW.entry_date    IS DISTINCT FROM OLD.entry_date
         OR NEW.memo          IS DISTINCT FROM OLD.memo
         OR NEW.source_type   IS DISTINCT FROM OLD.source_type
         OR NEW.source_id     IS DISTINCT FROM OLD.source_id
         OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
         OR NEW.source_event_key IS DISTINCT FROM OLD.source_event_key
         OR NEW.source_metadata IS DISTINCT FROM OLD.source_metadata
         OR NEW.posted_at     IS DISTINCT FROM OLD.posted_at
         OR NEW.created_at    IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION
          'voiding journal entry % may change only status; other fields are immutable',
          OLD.id
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSE
      RAISE EXCEPTION
        'journal entry % is posted; status may only move to void',
        OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_posted_journal_entry() IS
  'Trigger guard: a posted journal_entries row is immutable except for status '
  'posted -> void. Includes canonical idempotency/source provenance columns from '
  '0215; corrections go through reversing entries.';

-- ---------------------------------------------------------------------------
-- 2. Canonical atomic posting RPC.
--
-- SECURITY INVOKER is sufficient and preferable: callers still need normal RLS
-- write access, and the explicit get_accessible_org_ids() guard is what carries
-- the human/integration-token org boundary. Raw service-role calls without an
-- organization_id claim fail closed because get_accessible_org_ids() returns no
-- rows in that context.
--
-- p_lines is a JSON array of:
--   { "account_id": uuid, "debit_cents": bigint, "credit_cents": bigint,
--     "description": text? }
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_and_post_journal(
  p_organization_id  uuid,
  p_entry_date       date,
  p_source_type      text,
  p_source_id        uuid,
  p_idempotency_key  text,
  p_lines            jsonb,
  p_memo             text DEFAULT NULL,
  p_source_metadata  jsonb DEFAULT '{}'::jsonb
)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_entry             public.journal_entries;
  v_source_type       text := lower(btrim(p_source_type));
  v_idempotency_key   text := btrim(p_idempotency_key);
  v_source_event_key  text;
  v_source_metadata   jsonb := COALESCE(p_source_metadata, '{}'::jsonb);
  v_lines             integer;
  v_debits            bigint;
  v_credits           bigint;
  v_bad_lines         integer;
  v_bad_accounts      integer;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_entry_date IS NULL THEN
    RAISE EXCEPTION 'entry_date is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF v_source_type IS NULL OR v_source_type = '' THEN
    RAISE EXCEPTION 'source_type is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF v_idempotency_key IS NULL OR v_idempotency_key = '' THEN
    RAISE EXCEPTION 'idempotency_key is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF v_source_metadata IS NULL OR jsonb_typeof(v_source_metadata) <> 'object' THEN
    RAISE EXCEPTION 'source_metadata must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_organization_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'not authorized to create journal entry for org %', p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_source_event_key :=
    v_source_type || ':' || COALESCE(p_source_id::text, 'no-source-id') || ':' || v_idempotency_key;

  -- Idempotent replay: return the existing source-event posting before applying
  -- new-write checks. This keeps retries stable even after the period is locked.
  SELECT *
    INTO v_entry
    FROM public.journal_entries
   WHERE organization_id = p_organization_id
     AND source_event_key = v_source_event_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_entry.status = 'draft' THEN
      v_entry := public.post_journal_entry(v_entry.id);
    END IF;

    RETURN v_entry;
  END IF;

  -- Same active-lock predicate used by 0001/0209. The 0209 trigger will also
  -- reject the insert/update; this early guard keeps the RPC's contract explicit.
  IF EXISTS (
    SELECT 1
      FROM public.period_locks pl
     WHERE pl.organization_id = p_organization_id
       AND pl.unlocked_at IS NULL
       AND p_entry_date BETWEEN pl.period_start AND pl.period_end
  ) THEN
    RAISE EXCEPTION 'Cannot post journal entry dated %: period is locked', p_entry_date
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'p_lines must be a non-empty JSON array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  WITH parsed AS (
    SELECT
      l.account_id,
      COALESCE(l.debit_cents, 0)::bigint AS debit_cents,
      COALESCE(l.credit_cents, 0)::bigint AS credit_cents
    FROM jsonb_to_recordset(p_lines) AS l(
      account_id uuid,
      debit_cents bigint,
      credit_cents bigint,
      description text
    )
  )
  SELECT
    COUNT(*)::integer,
    COALESCE(SUM(debit_cents), 0)::bigint,
    COALESCE(SUM(credit_cents), 0)::bigint,
    COUNT(*) FILTER (
      WHERE account_id IS NULL
         OR debit_cents < 0
         OR credit_cents < 0
         OR ((debit_cents > 0)::integer + (credit_cents > 0)::integer) <> 1
    )::integer
    INTO v_lines, v_debits, v_credits, v_bad_lines
  FROM parsed;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'journal entry has no lines'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_bad_lines > 0 THEN
    RAISE EXCEPTION 'journal entry has % invalid line(s)', v_bad_lines
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_debits <> v_credits THEN
    RAISE EXCEPTION 'journal entry is unbalanced: debits=% credits=%', v_debits, v_credits
      USING ERRCODE = 'check_violation';
  END IF;

  WITH parsed AS (
    SELECT l.account_id
    FROM jsonb_to_recordset(p_lines) AS l(
      account_id uuid,
      debit_cents bigint,
      credit_cents bigint,
      description text
    )
  )
  SELECT COUNT(*)::integer
    INTO v_bad_accounts
  FROM parsed p
  LEFT JOIN public.chart_of_accounts coa
    ON coa.id = p.account_id
  WHERE coa.id IS NULL
     OR coa.organization_id <> p_organization_id
     OR coa.is_active = false;

  IF v_bad_accounts > 0 THEN
    RAISE EXCEPTION 'journal entry has % missing, inactive, or foreign-org account(s)', v_bad_accounts
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_source_metadata :=
    v_source_metadata
    || jsonb_build_object(
         'source_event_key', v_source_event_key,
         'posted_via', 'create_and_post_journal'
       );

  INSERT INTO public.journal_entries (
    organization_id,
    entry_date,
    memo,
    source_type,
    source_id,
    idempotency_key,
    source_event_key,
    source_metadata,
    status
  )
  VALUES (
    p_organization_id,
    p_entry_date,
    p_memo,
    v_source_type,
    p_source_id,
    v_idempotency_key,
    v_source_event_key,
    v_source_metadata,
    'draft'
  )
  ON CONFLICT (organization_id, source_event_key)
    WHERE source_event_key IS NOT NULL
  DO NOTHING
  RETURNING * INTO v_entry;

  -- Idempotent retry: return the already-created row. If it is still draft,
  -- attempt to finish posting it rather than creating a second journal entry.
  IF v_entry.id IS NULL THEN
    SELECT *
      INTO v_entry
      FROM public.journal_entries
     WHERE organization_id = p_organization_id
       AND source_event_key = v_source_event_key
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'journal entry idempotency conflict disappeared for key %', v_source_event_key;
    END IF;

    IF v_entry.status = 'draft' THEN
      v_entry := public.post_journal_entry(v_entry.id);
    END IF;

    RETURN v_entry;
  END IF;

  INSERT INTO public.journal_lines (
    journal_entry_id,
    account_id,
    debit_cents,
    credit_cents,
    description
  )
  SELECT
    v_entry.id,
    l.account_id,
    COALESCE(l.debit_cents, 0)::bigint,
    COALESCE(l.credit_cents, 0)::bigint,
    NULLIF(btrim(l.description), '')
  FROM jsonb_to_recordset(p_lines) AS l(
    account_id uuid,
    debit_cents bigint,
    credit_cents bigint,
    description text
  );

  -- Delegate the final posting invariant to the existing sanctioned primitive.
  v_entry := public.post_journal_entry(v_entry.id);
  RETURN v_entry;
END;
$$;

COMMENT ON FUNCTION public.create_and_post_journal(uuid, date, text, uuid, text, jsonb, text, jsonb) IS
  'Canonical atomic GL posting RPC for source events. Requires org access via '
  'get_accessible_org_ids() (human memberships or org-scoped integration token), '
  'rejects locked periods, validates non-empty/balanced debit-credit lines, stores '
  'source_type/source_id/idempotency_key/source_event_key/source_metadata, inserts '
  'a draft and lines, then posts via post_journal_entry(). Replays with the same '
  'per-org source_event_key return the existing journal entry without duplicating.';

REVOKE ALL ON FUNCTION public.create_and_post_journal(uuid, date, text, uuid, text, jsonb, text, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_and_post_journal(uuid, date, text, uuid, text, jsonb, text, jsonb)
  TO authenticated, service_role;

-- create_and_post_journal delegates to post_journal_entry(). Preserve the
-- existing authenticated caller and add service_role for org-claim backend use.
GRANT EXECUTE ON FUNCTION public.post_journal_entry(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Date-scoped trial balance.
--
-- p_period_start NULL means "as of p_period_end" from ledger inception.
-- Supplying both dates returns opening, period movement, and closing balances.
-- v_trial_balance stays cumulative for existing callers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trial_balance_by_period(
  p_org          uuid,
  p_period_start date DEFAULT NULL,
  p_period_end   date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  organization_id           uuid,
  account_id                uuid,
  account_code              text,
  account_name              text,
  account_type              public.account_type,
  period_start              date,
  period_end                date,
  opening_debit_cents       bigint,
  opening_credit_cents      bigint,
  opening_net_cents         bigint,
  period_debit_cents        bigint,
  period_credit_cents       bigint,
  period_net_cents          bigint,
  closing_debit_cents       bigint,
  closing_credit_cents      bigint,
  closing_net_cents         bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH params AS (
    SELECT
      p_org AS organization_id,
      p_period_start AS period_start,
      COALESCE(p_period_end, CURRENT_DATE)::date AS period_end
  ),
  postings AS (
    SELECT
      jl.account_id,
      COALESCE(SUM(jl.debit_cents) FILTER (
        WHERE p.period_start IS NOT NULL
          AND je.entry_date < p.period_start
      ), 0)::bigint AS opening_debit_cents,
      COALESCE(SUM(jl.credit_cents) FILTER (
        WHERE p.period_start IS NOT NULL
          AND je.entry_date < p.period_start
      ), 0)::bigint AS opening_credit_cents,
      COALESCE(SUM(jl.debit_cents) FILTER (
        WHERE (p.period_start IS NULL OR je.entry_date >= p.period_start)
          AND je.entry_date <= p.period_end
      ), 0)::bigint AS period_debit_cents,
      COALESCE(SUM(jl.credit_cents) FILTER (
        WHERE (p.period_start IS NULL OR je.entry_date >= p.period_start)
          AND je.entry_date <= p.period_end
      ), 0)::bigint AS period_credit_cents,
      COALESCE(SUM(jl.debit_cents) FILTER (
        WHERE je.entry_date <= p.period_end
      ), 0)::bigint AS closing_debit_cents,
      COALESCE(SUM(jl.credit_cents) FILTER (
        WHERE je.entry_date <= p.period_end
      ), 0)::bigint AS closing_credit_cents
    FROM params p
    JOIN public.journal_entries je
      ON je.organization_id = p.organization_id
     AND je.status = 'posted'
     AND je.entry_date <= p.period_end
    JOIN public.journal_lines jl
      ON jl.journal_entry_id = je.id
    GROUP BY jl.account_id
  )
  SELECT
    coa.organization_id,
    coa.id AS account_id,
    coa.code AS account_code,
    coa.name AS account_name,
    coa.account_type,
    p.period_start,
    p.period_end,
    COALESCE(postings.opening_debit_cents, 0)::bigint AS opening_debit_cents,
    COALESCE(postings.opening_credit_cents, 0)::bigint AS opening_credit_cents,
    (
      COALESCE(postings.opening_debit_cents, 0)
      - COALESCE(postings.opening_credit_cents, 0)
    )::bigint AS opening_net_cents,
    COALESCE(postings.period_debit_cents, 0)::bigint AS period_debit_cents,
    COALESCE(postings.period_credit_cents, 0)::bigint AS period_credit_cents,
    (
      COALESCE(postings.period_debit_cents, 0)
      - COALESCE(postings.period_credit_cents, 0)
    )::bigint AS period_net_cents,
    COALESCE(postings.closing_debit_cents, 0)::bigint AS closing_debit_cents,
    COALESCE(postings.closing_credit_cents, 0)::bigint AS closing_credit_cents,
    (
      COALESCE(postings.closing_debit_cents, 0)
      - COALESCE(postings.closing_credit_cents, 0)
    )::bigint AS closing_net_cents
  FROM params p
  JOIN public.chart_of_accounts coa
    ON coa.organization_id = p.organization_id
  LEFT JOIN postings
    ON postings.account_id = coa.id
  ORDER BY coa.code;
$$;

COMMENT ON FUNCTION public.trial_balance_by_period(uuid, date, date) IS
  'Date-scoped trial balance over posted journal entries. p_period_start NULL '
  'returns an as-of balance to p_period_end; providing both dates returns opening '
  '(< start), period movement (start..end), and closing (<= end) debit/credit/net '
  'amounts per account. SECURITY INVOKER so underlying RLS scopes results.';

REVOKE ALL ON FUNCTION public.trial_balance_by_period(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trial_balance_by_period(uuid, date, date)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
