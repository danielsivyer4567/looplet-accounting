-- ============================================================================
-- Migration: 0204_tag_draft_contract
-- Project:   Looplet Accounting  (finish-line: tag-draft upsert contract)
-- Purpose:   Give the frontend tag-draft upsert a real conflict arbiter.
--
--   The tag service (src/services/tags/tag-service.ts -> saveTagDraft) upserts a
--   draft with:
--
--       supabase.from('tag_drafts')
--         .upsert({ user_id, organization_id, page_url, ... },
--                 { onConflict: 'user_id,organization_id,page_url' })
--
--   For PostgREST to honour that ON CONFLICT clause, the table needs a UNIQUE
--   index over EXACTLY those three columns. 0200 created tag_drafts with only a
--   plain (non-unique) idx_tag_drafts_user index, and 0202 added FK-covering
--   indexes on organization_id / job_id — none of them is a unique arbiter. So
--   today the upsert either errors ("no unique or exclusion constraint matching
--   the ON CONFLICT specification") or, worse on a permissive PostgREST, silently
--   INSERTs a duplicate draft every save. This migration adds the missing arbiter
--   so "save draft" updates the existing row instead of piling up duplicates.
--
--   NULL page_url: page_url is nullable (0200). A standard B-tree unique index
--   treats two NULLs as distinct, which would let duplicate "no-page" drafts
--   accumulate AND would not let the upsert match an existing NULL-page draft.
--   We close that with NULLS NOT DISTINCT (Postgres 15+, which Supabase runs).
--   The CREATE is wrapped in a guarded DO block: PG15+ gets the NULLS NOT
--   DISTINCT arbiter; on an (unexpected) older engine we fall back to a plain
--   unique index plus a partial NULL-case unique index so dedup still holds for
--   the realistic non-null-page_url path the frontend always sends.
--
--   Idempotent + prod-safe: guarded with to_regclass() (table landed in 0200 and
--   may be absent on a partially-applied DB) and CREATE UNIQUE INDEX IF NOT
--   EXISTS (re-runnable over a drifted live history, [[migration-history-drift]]).
--   Pure additive DDL — no RLS / data changes.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- tag_drafts: unique arbiter for the (user_id, organization_id, page_url) upsert.
--   Matches saveTagDraft's onConflict list exactly. NULLS NOT DISTINCT so a
--   draft with no page_url (page_url IS NULL) also dedupes per (user, org).
-- ----------------------------------------------------------------------------
DO $td$
BEGIN
  IF to_regclass('public.tag_drafts') IS NULL THEN
    RAISE NOTICE 'Skipping tag_drafts unique arbiter (table not present in this database)';
    RETURN;
  END IF;

  IF current_setting('server_version_num')::int >= 150000 THEN
    -- PG15+: a single arbiter over the exact onConflict columns, NULL-collapsing.
    CREATE UNIQUE INDEX IF NOT EXISTS tag_drafts_user_org_page_uniq
      ON public.tag_drafts (user_id, organization_id, page_url)
      NULLS NOT DISTINCT;
  ELSE
    -- Pre-PG15 fallback: plain unique arbiter for the non-null path the UI sends,
    -- plus a partial unique index that dedupes the NULL-page_url case per (user, org).
    CREATE UNIQUE INDEX IF NOT EXISTS tag_drafts_user_org_page_uniq
      ON public.tag_drafts (user_id, organization_id, page_url);

    CREATE UNIQUE INDEX IF NOT EXISTS tag_drafts_user_org_nullpage_uniq
      ON public.tag_drafts (user_id, organization_id)
      WHERE page_url IS NULL;
  END IF;
END
$td$;

COMMENT ON INDEX public.tag_drafts_user_org_page_uniq IS
  'Conflict arbiter for saveTagDraft''s upsert onConflict '
  '(user_id, organization_id, page_url). NULLS NOT DISTINCT (PG15+) so a '
  'no-page draft also dedupes; one row per (user, org, page) is updated in place.';

COMMIT;
