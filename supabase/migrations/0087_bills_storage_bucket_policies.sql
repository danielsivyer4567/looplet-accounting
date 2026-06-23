-- ============================================================================
-- 0087_bills_storage_bucket_policies.sql
--
-- FIX (migration fidelity): the private `bills` storage bucket and its
-- org-scoped storage.objects RLS were authored only via the Supabase dashboard
-- (0001 lines 771-779 describe them as SQL comments only). A fresh
-- `supabase db push` therefore created no bucket and no storage policies, so a
-- rebuilt/cloned project either broke bill uploads or — if an operator later
-- created the bucket without policies — exposed bill/invoice PDFs (ABNs, bank
-- details) cross-tenant.
--
-- Object key convention (set by useBillUpload.ts and the gmail ingest path):
--   org-<organization_id>/<...>
-- Access is granted only to members of that org via get_accessible_org_ids().
-- The org id is compared as TEXT (not cast from the untrusted object name to
-- uuid) so a malformed key can never raise a cast error during policy eval.
--
-- Idempotent + prod-safe: bucket insert is ON CONFLICT DO NOTHING; policies are
-- DROP IF EXISTS + CREATE. Re-asserting over the live (already-correct) config
-- changes nothing.
-- ============================================================================

-- Private bucket (never public).
INSERT INTO storage.buckets (id, name, public)
VALUES ('bills', 'bills', false)
ON CONFLICT (id) DO NOTHING;

-- Members of the owning org may read their bucket objects.
DROP POLICY IF EXISTS bills_bucket_org_members_select ON storage.objects;
CREATE POLICY bills_bucket_org_members_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'bills'
    AND substring(name FROM '^org-([0-9a-fA-F-]+)/') IN (
      SELECT g::text FROM public.get_accessible_org_ids() AS g
    )
  );

-- Members of the owning org may upload into their org prefix.
DROP POLICY IF EXISTS bills_bucket_org_members_insert ON storage.objects;
CREATE POLICY bills_bucket_org_members_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'bills'
    AND substring(name FROM '^org-([0-9a-fA-F-]+)/') IN (
      SELECT g::text FROM public.get_accessible_org_ids() AS g
    )
  );

-- Members of the owning org may update (e.g. re-upload/replace) their objects.
DROP POLICY IF EXISTS bills_bucket_org_members_update ON storage.objects;
CREATE POLICY bills_bucket_org_members_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'bills'
    AND substring(name FROM '^org-([0-9a-fA-F-]+)/') IN (
      SELECT g::text FROM public.get_accessible_org_ids() AS g
    )
  )
  WITH CHECK (
    bucket_id = 'bills'
    AND substring(name FROM '^org-([0-9a-fA-F-]+)/') IN (
      SELECT g::text FROM public.get_accessible_org_ids() AS g
    )
  );
