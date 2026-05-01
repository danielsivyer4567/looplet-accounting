-- ============================================================================
-- Migration: 0004_bill_routing
-- Adds bill→job routing: exact-match auto-attach, fuzzy suggestion, manual queue.
-- Uses pg_trgm (already enabled in 0001) for similarity scoring.
-- ============================================================================

-- New column: suggested_job_id holds the fuzzy-match suggestion when we
-- couldn't auto-attach. Lives until the operator confirms or rejects via
-- the Allocation Portal.
ALTER TABLE bills
  ADD COLUMN suggested_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  ADD COLUMN suggested_match_score NUMERIC(3, 2)
    CHECK (suggested_match_score IS NULL OR (suggested_match_score >= 0 AND suggested_match_score <= 1));

CREATE INDEX idx_bills_allocation_queue
  ON bills(organization_id, created_at DESC)
  WHERE deleted_at IS NULL
    AND status = 'verified'
    AND job_id IS NULL;

CREATE INDEX idx_bills_suggested_job
  ON bills(suggested_job_id)
  WHERE suggested_job_id IS NOT NULL;

COMMENT ON COLUMN bills.suggested_job_id IS
  'Fuzzy-match suggestion from match_job_for_bill(). NULL when score < 0.5 or no candidate found. Cleared when the bill gets attached.';

-- ----------------------------------------------------------------------------
-- match_job_for_bill — score every active job in an org against a job_ref string.
-- Returns the top 5 candidates ordered by descending score.
--
-- Score model:
--   1.00  exact UPPER() match
--   0.99  match after stripping spaces/dashes
--   0.00..1.00  trigram similarity otherwise
--
-- Threshold semantics (consumed by bills-extract):
--   ≥ 1.00  auto-attach
--   ≥ 0.50  store as suggested_job_id, surface in Allocation Portal
--   <  0.50 leave bill in queue with no suggestion
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION match_job_for_bill(
  p_org_id UUID,
  p_job_ref TEXT
) RETURNS TABLE(matched_job_id UUID, score REAL, job_number TEXT)
LANGUAGE sql STABLE SECURITY INVOKER AS $func$
  SELECT
    j.id,
    GREATEST(
      CASE WHEN UPPER(j.job_number) = UPPER(p_job_ref) THEN 1.0 ELSE 0.0 END,
      CASE WHEN regexp_replace(UPPER(j.job_number), '[\s-]', '', 'g')
              = regexp_replace(UPPER(p_job_ref),    '[\s-]', '', 'g')
           THEN 0.99 ELSE 0.0 END,
      similarity(j.job_number, p_job_ref)
    )::REAL AS score,
    j.job_number
  FROM jobs j
  WHERE j.organization_id = p_org_id
    AND j.deleted_at IS NULL
    AND j.status IN ('draft', 'active', 'paused')
    AND p_job_ref IS NOT NULL
    AND length(trim(p_job_ref)) > 0
  ORDER BY score DESC, j.created_at DESC
  LIMIT 5;
$func$;

COMMENT ON FUNCTION match_job_for_bill(UUID, TEXT) IS
  'Returns top 5 job candidates for a given job_reference string within one org. Score 1.0 = exact, 0.99 = normalised exact, otherwise trigram similarity. Used by bills-extract to decide auto-attach vs queue.';

GRANT EXECUTE ON FUNCTION match_job_for_bill(UUID, TEXT) TO authenticated, service_role;
