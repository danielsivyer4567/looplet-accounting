-- 0179_fix_issue_receipt_identity_search_path.sql
-- Fix search_path for issue_receipt_identity to include extensions (since gen_random_bytes and digest come from pgcrypto in extensions)

CREATE OR REPLACE FUNCTION public.issue_receipt_identity(
  p_organization_id uuid,
  p_label text DEFAULT 'Phone pass',
  p_channel text DEFAULT 'phone-pass'
) RETURNS TABLE(id uuid, receipt_token text, token_prefix text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_prefix text;
  v_secret text;
  v_hash text;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_organization_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'organization not accessible';
  END IF;
  IF p_channel NOT IN ('phone-pass', 'tag', 'pos', 'epost') THEN
    RAISE EXCEPTION 'unsupported receipt identity channel';
  END IF;

  v_prefix := 'rhp_' || substr(encode(gen_random_bytes(8), 'hex'), 1, 8);
  v_secret := encode(gen_random_bytes(18), 'hex');
  v_hash := encode(digest(v_secret, 'sha256'), 'hex');

  INSERT INTO public.receipt_identities (
    organization_id, label, channel, token_prefix, token_hash, created_by
  ) VALUES (
    p_organization_id, COALESCE(NULLIF(trim(p_label), ''), 'Receipt pass'), p_channel,
    v_prefix, v_hash, auth.uid()
  ) RETURNING receipt_identities.id INTO v_id;

  RETURN QUERY SELECT v_id, (v_prefix || '.' || v_secret), v_prefix;
END;
$$;
