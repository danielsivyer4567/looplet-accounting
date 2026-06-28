-- ============================================================================
-- 0193_receipt_audit_bucket.sql - SC-10
--
-- Private storage bucket for immutable receipt audit packages. receipt-webhook
-- writes the audit JSON (payload + decision_path + evidence) to
--   receipt-hub/<organization_id>/<receipt_event_id>.json
-- which is exactly the key already stored in receipt_audit_packages.storage_key
-- (previously a dangling pointer — nothing wrote the object).
--
-- Writes are done by the webhook as service_role (RLS bypassed). Reads are
-- granted to members of the owning org so the detail drawer can download the
-- package. Object key prefix is receipt-hub/<org>/ (NOT org-<org>/ like the
-- bills bucket), so the policy regex differs accordingly. Org id is compared as
-- TEXT so a malformed key can't raise a uuid cast error during policy eval.
--
-- Idempotent + prod-safe: bucket insert is ON CONFLICT DO NOTHING; policies are
-- DROP IF EXISTS + CREATE.
-- ============================================================================

-- Private bucket (never public).
INSERT INTO storage.buckets (id, name, public)
VALUES ('receipt-audit', 'receipt-audit', false)
ON CONFLICT (id) DO NOTHING;

-- Members of the owning org may read their audit objects.
DROP POLICY IF EXISTS receipt_audit_bucket_org_members_select ON storage.objects;
CREATE POLICY receipt_audit_bucket_org_members_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'receipt-audit'
    AND substring(name FROM '^receipt-hub/([0-9a-fA-F-]+)/') IN (
      SELECT g::text FROM public.get_accessible_org_ids() AS g
    )
  );
