-- 0189_grant_revoke_receipt_identities.sql
-- Allow authenticated users to revoke their org's receipt identities from the Receipt Hub UI.
-- 0088 created the receipt_identities_update RLS policy (FOR UPDATE TO authenticated) but only
-- GRANTed SELECT on the table, so an UPDATE was rejected at the privilege layer before RLS ran.
-- The policy already scopes writes to get_accessible_org_ids(); this grant makes the org-scoped
-- revoke (status='revoked', revoked_at=now()) actually reachable. SELECT/INSERT are unchanged
-- (issuance still flows through the SECURITY DEFINER issue_receipt_identity RPC).

GRANT UPDATE ON public.receipt_identities TO authenticated;
