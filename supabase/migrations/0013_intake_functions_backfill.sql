-- 0013 (BACKFILL): intake RPC functions.
--   public.lookup_known_sender(text)
--   public.match_intake_rule(uuid, text, text, text)
--   public.record_intake_rule_hit(uuid)
--
-- RECONSTRUCTION NOTE: Exist in the LIVE DB but had no repo migration. Called by edge
-- functions (gmail-mine .rpc('lookup_known_sender'); gmail-pubsub-push / intake-routing-apply
-- .rpc('match_intake_rule') / .rpc('record_intake_rule_hit')). Reconstructed verbatim from
-- live via pg_get_functiondef (read-only MCP, 2026-06-20). CREATE OR REPLACE = safe.
-- Depends on intake_rules / intake_categories / intake_known_senders (0005/0006).
-- See docs/MIGRATION_GAP_AUDIT.md.

CREATE OR REPLACE FUNCTION public.lookup_known_sender(p_email text)
 RETURNS TABLE(domain text, brand_name text, parent_brand text, kind public.staged_entity_kind, category_code text, arm text, is_marketing boolean, confidence numeric, match_specificity integer)
 LANGUAGE sql
 STABLE
AS $function$
  WITH RECURSIVE
    parts AS (
      SELECT
        LOWER(p_email) AS email,
        LOWER(split_part(p_email, '@', 2)) AS full_domain
    ),
    candidates AS (
      SELECT full_domain AS d, 0 AS depth FROM parts
      UNION ALL
      SELECT
        substring(d FROM position('.' IN d) + 1) AS d,
        depth + 1
      FROM candidates
      WHERE position('.' IN d) > 0 AND depth < 5
    )
  SELECT s.domain, s.brand_name, s.parent_brand, s.kind, s.category_code,
         s.arm, s.is_marketing, s.confidence, c.depth
  FROM candidates c
  JOIN intake_known_senders s ON s.domain = c.d
  WHERE s.sender_pattern IS NULL
     OR (SELECT email FROM parts) ~ s.sender_pattern
  ORDER BY c.depth ASC, s.confidence DESC
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.match_intake_rule(p_org_id uuid, p_sender_email text, p_subject text DEFAULT NULL::text, p_attachment_filename text DEFAULT NULL::text)
 RETURNS TABLE(rule_id uuid, matcher_type text, matcher_value text, category_code text, supplier_id uuid, customer_id uuid, job_id uuid, xero_account_code text, xero_tax_type text, is_personal boolean, skip_ocr boolean)
 LANGUAGE sql
 STABLE
AS $function$
  WITH e AS (
    SELECT
      LOWER(p_sender_email) AS email,
      LOWER(split_part(p_sender_email, '@', 2)) AS domain,
      LOWER(p_subject) AS subject_lc,
      LOWER(p_attachment_filename) AS attachment_lc
  )
  SELECT
    r.id,
    r.matcher_type,
    r.matcher_value,
    r.category_code,
    r.supplier_id,
    r.customer_id,
    r.job_id,
    COALESCE(r.xero_account_code_override, ic.xero_account_code),
    COALESCE(r.xero_tax_type_override, ic.xero_tax_type),
    r.is_personal,
    r.skip_ocr
  FROM intake_rules r
  LEFT JOIN intake_categories ic ON ic.code = r.category_code
  CROSS JOIN e
  WHERE r.organization_id = p_org_id
    AND r.is_active
    AND (
      (r.matcher_type = 'sender_address' AND e.email = LOWER(r.matcher_value))
      OR (r.matcher_type = 'sender_domain' AND (e.domain = LOWER(r.matcher_value) OR e.domain LIKE '%.' || LOWER(r.matcher_value)))
      OR (r.matcher_type = 'subject_pattern' AND p_subject IS NOT NULL AND e.subject_lc ~* r.matcher_value)
      OR (r.matcher_type = 'attachment_name' AND p_attachment_filename IS NOT NULL AND e.attachment_lc ~* r.matcher_value)
    )
  ORDER BY
    r.matcher_priority ASC,
    CASE r.matcher_type
      WHEN 'sender_address' THEN 1
      WHEN 'sender_domain'  THEN 2
      WHEN 'sender_name'    THEN 3
      WHEN 'attachment_name' THEN 4
      WHEN 'subject_pattern' THEN 5
      WHEN 'body_keyword'   THEN 6
      ELSE 9
    END ASC,
    r.created_at DESC
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.record_intake_rule_hit(p_rule_id uuid)
 RETURNS void
 LANGUAGE sql
AS $function$
  UPDATE intake_rules
  SET hit_count = hit_count + 1, last_matched_at = now()
  WHERE id = p_rule_id;
$function$;
