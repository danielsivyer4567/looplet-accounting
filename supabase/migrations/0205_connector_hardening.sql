-- 0205_connector_hardening.sql  (P0-06 — connector gateway PostgREST hardening)
--
-- PROBLEM (privilege escalation via the gateway-minted JWT):
--   The api-gateway exchanges an external API key for a short-lived Supabase JWT
--   so machine callers can hit PostgREST (/rest/v1) with RLS doing tenant
--   enforcement. Until now that JWT carried `role: authenticated`. PostgREST
--   runs every request under the JWT's `role` Postgres role, and the
--   `authenticated` role holds, from 0001:
--       GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO authenticated;
--   plus per-table DELETE grants in many later migrations (0047, 0072, 0118,
--   0138, 0151, 0196, ...). Every org table's write RLS policy keys on
--   get_accessible_org_ids(), which 0069 made honour the integration token's
--   `organization_id` claim. Net effect: ANY connector key could mint a token
--   and then POST / PATCH / DELETE bills, invoices, journal_entries, trusts, etc.
--   straight over /rest/v1 — completely bypassing the scoped `ingest` function
--   (the only surface where per-type write:* scopes are enforced). A read-only
--   connector could mutate the whole org's books.
--
-- FIX (least-privilege Postgres role for connector tokens):
--   Introduce a dedicated `connector` role with SELECT only — no INSERT / UPDATE
--   / DELETE on any public table, now or in the future (default privileges). The
--   api-gateway mints `role: connector` (see api-gateway/index.ts). PostgREST
--   SET ROLEs to it, so any write attempt is denied at the GRANT layer (SQLSTATE
--   42501) regardless of RLS — the scoped `ingest` function stays the only write
--   surface for connectors. Reads remain RLS-scoped to the single pinned org.
--
--   The token can no longer be "exchanged for a broader read JWT": the gateway
--   never mints `authenticated` for a key anymore, and `connector` carries no
--   write authority to escalate into.
--
-- WHY connector is a NOINHERIT member of authenticated:
--   Read RLS policies are a mix across the schema — most are untargeted
--   (FOR SELECT USING ..., i.e. apply to PUBLIC), but some were narrowed to
--   `TO authenticated` (e.g. invoices in 0196). Postgres applies a policy's role
--   list by membership (pg_has_role), independent of INHERIT, so making
--   `connector` a member of `authenticated` makes every `TO authenticated`
--   SELECT policy apply to connector tokens too — reads keep working everywhere.
--   NOINHERIT means connector does NOT silently inherit authenticated's table
--   write GRANTs; it only ever gets the SELECT we grant it directly below. This
--   is the crux: membership for policy applicability, but no inherited writes.
--
-- Safety / fidelity: idempotent and additive. No existing role, grant, or policy
-- is removed. Human (`authenticated`) sessions and the `ingest`/service-role
-- write path are unchanged. Live-proof is deploy-gated (no DB here): see the
-- slice's live_proof for the throwaway-key 403 / read-JWT-cannot-mutate checks.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The connector role: NOLOGIN, NOINHERIT, read-only.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'connector') THEN
    CREATE ROLE connector NOLOGIN NOINHERIT;
  ELSE
    -- Re-assert the shape in case an earlier hand-rolled role drifted.
    ALTER ROLE connector NOLOGIN NOINHERIT;
  END IF;
END $$;

-- PostgREST switches into the JWT `role` by SET ROLE from the `authenticator`
-- login role; that requires authenticator to be a member of connector. (The
-- managed Supabase `authenticator` role always exists.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    GRANT connector TO authenticator;
  END IF;
END $$;

-- Membership in authenticated → `TO authenticated` SELECT policies apply to
-- connector tokens. NOINHERIT (set above) keeps authenticated's write grants
-- from leaking in; connector's only privileges are the SELECT grants below.
GRANT authenticated TO connector;

-- ---------------------------------------------------------------------------
-- 2. Read-only privileges. SELECT only — never INSERT/UPDATE/DELETE.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO connector;

-- Existing tables. RLS still gates which ROWS are visible (org claim → 0069).
GRANT SELECT ON ALL TABLES IN SCHEMA public TO connector;

-- Future tables created later get SELECT for connector automatically, so a new
-- org table is not silently readable-but-unscoped or, worse, accidentally
-- writable. We deliberately do NOT add INSERT/UPDATE/DELETE here.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO connector;

-- Defensive: ensure no write privilege ever sits directly on connector, even if
-- a future migration's blanket grant slips. (Inherited grants are blocked by
-- NOINHERIT; this strips any *direct* write grant.)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM connector;

-- Connector tokens read via PostgREST only; they do not execute RPCs and never
-- need sequence/usage write capability. (No EXECUTE / sequence grants on
-- purpose — the scoped write surface is the `ingest` edge function under the
-- service role, not direct RPC calls by the connector token.)

NOTIFY pgrst, 'reload schema';

COMMIT;
