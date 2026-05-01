-- ============================================================================
-- Migration: 0002_bill_content_hash
-- Adds SHA-256 content hash to bills for OCR dedup ("once-off OCR per file").
--
-- Re-uploading the same file (same bytes) within the same organization will
-- skip OCR and copy the prior extraction. Single-tenant scope only —
-- cross-tenant cache sharing is intentionally NOT supported (privacy).
--
-- See: docs/decisions/0001-loaded-hourly-rate.md (no), this is just dedup.
-- ============================================================================

ALTER TABLE bills
  ADD COLUMN content_sha256 CHAR(64);

-- Composite index for the cache lookup. Partial: only indexes rows that have
-- a hash AND aren't soft-deleted AND have actual extraction data.
CREATE INDEX idx_bills_org_sha_cache
  ON bills(organization_id, content_sha256)
  WHERE deleted_at IS NULL
    AND content_sha256 IS NOT NULL
    AND raw_extracted IS NOT NULL;

COMMENT ON COLUMN bills.content_sha256 IS
  'SHA-256 hex of the original file bytes. Used by bills-extract to skip OCR on a re-upload of the same file within the same organization. NULL until first OCR run completes.';
