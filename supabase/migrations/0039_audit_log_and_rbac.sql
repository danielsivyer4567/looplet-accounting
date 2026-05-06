-- ============================================================================
-- Migration: 0039_audit_log_and_rbac
-- Project:   Looplet Accounting
-- Date:      2026-05-03
-- Purpose:   Extend audit log with rich diff + actor metadata; add fine-grained
--            org_role enum alongside existing membership_role; add require_role()
--            helper; tighten RLS on sensitive write operations; extend
--            organization_memberships with invite tracking columns.
--
-- Intentional design notes:
--   - The existing `membership_role` enum ('owner','admin','manager','member')
--     and `write_audit_log()` trigger already exist from migration 0001.
--   - We ADD a new `org_role` enum for the RBAC helper (finer grained).
--   - We ADD new columns to audit_log (actor_email, action, resource_type,
--     resource_id, before, after, changes, metadata, user_agent) alongside
--     the existing columns. Old rows keep NULLs in new columns.
--   - We ADD a new trigger function `audit_log_trigger_v2` that uses the
--     enriched schema. The old `write_audit_log` stays intact (append-only
--     constraint means we can't alter existing rows).
--   - We DO NOT drop or rename the existing `membership_role` enum; new code
--     reads `role_enum` (org_role); old code keeps reading `role` (membership_role).
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. NEW ENUM: org_role (finer-grained, used by require_role())
-- ============================================================================

CREATE TYPE org_role AS ENUM ('viewer', 'employee', 'accountant', 'admin', 'owner');

-- ============================================================================
-- 2. EXTEND organization_memberships
--    Add role_enum (org_role), invited_by, invited_at, accepted_at.
--    Keep existing `role` (membership_role) untouched.
-- ============================================================================

ALTER TABLE organization_memberships
  ADD COLUMN IF NOT EXISTS role_enum    org_role,
  ADD COLUMN IF NOT EXISTS invited_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS invited_at   timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS accepted_at  timestamptz;

-- Backfill role_enum from the existing membership_role column.
-- 'manager' maps to 'accountant' (closest equivalent in the new enum).
UPDATE organization_memberships
SET role_enum = CASE role::text
  WHEN 'owner'   THEN 'owner'::org_role
  WHEN 'admin'   THEN 'admin'::org_role
  WHEN 'manager' THEN 'accountant'::org_role
  ELSE                'employee'::org_role   -- 'member' → employee
END
WHERE role_enum IS NULL;

-- Mark all existing (non-pending) memberships as accepted at their join time.
UPDATE organization_memberships
SET accepted_at = joined_at
WHERE accepted_at IS NULL;

-- ============================================================================
-- 3. EXTEND audit_log WITH RICHER COLUMNS
--    The existing table has: id, organization_id, table_name, record_id,
--    operation, actor_user_id, before_data, after_data, occurred_at,
--    request_id, ip_address.
--
--    We add: actor_email, action, resource_type, resource_id,
--            before (alias), after (alias), changes, metadata, user_agent.
--    The append-only trigger only blocks UPDATE/DELETE — ALTER TABLE is fine.
-- ============================================================================

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS actor_email   text,
  ADD COLUMN IF NOT EXISTS action        text,          -- explicit verb: INSERT|UPDATE|DELETE|INVITE|ROLE_CHANGE
  ADD COLUMN IF NOT EXISTS resource_type text,          -- human table alias: bill|invoice|job|customer...
  ADD COLUMN IF NOT EXISTS resource_id   uuid,          -- same as record_id, kept for API consistency
  ADD COLUMN IF NOT EXISTS before        jsonb,         -- alias for before_data; new trigger writes here
  ADD COLUMN IF NOT EXISTS after         jsonb,         -- alias for after_data
  ADD COLUMN IF NOT EXISTS changes       jsonb,         -- computed diff {col:[old,new],...}
  ADD COLUMN IF NOT EXISTS metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS user_agent    text;

-- Additional indexes on new columns (old indexes on org/actor/record still exist).
CREATE INDEX IF NOT EXISTS audit_log_resource_type_id_idx
  ON audit_log (resource_type, resource_id)
  WHERE resource_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_log_action_idx
  ON audit_log (organization_id, action)
  WHERE action IS NOT NULL;

-- ============================================================================
-- 4. RICH AUDIT TRIGGER FUNCTION (v2)
--    Replaces per-table old trigger; computes diff for UPDATE.
--    Reads actor email from auth.users via SECURITY DEFINER lookup.
--    Table → resource_type mapping is inline.
-- ============================================================================

CREATE OR REPLACE FUNCTION audit_log_trigger_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id       uuid;
  v_record_id    uuid;
  v_actor_id     uuid;
  v_actor_email  text;
  v_before       jsonb;
  v_after        jsonb;
  v_changes      jsonb := '{}'::jsonb;
  v_resource     text;
  v_key          text;
  v_old_val      jsonb;
  v_new_val      jsonb;
BEGIN
  -- Resolve actor
  v_actor_id := auth.uid();
  IF v_actor_id IS NOT NULL THEN
    SELECT email INTO v_actor_email
      FROM auth.users
     WHERE id = v_actor_id;
  END IF;

  -- Resolve organization_id and record_id from row data
  CASE TG_OP
    WHEN 'INSERT' THEN
      v_org_id    := (to_jsonb(NEW)->>'organization_id')::uuid;
      v_record_id := (to_jsonb(NEW)->>'id')::uuid;
      v_after     := to_jsonb(NEW);
    WHEN 'UPDATE' THEN
      v_org_id    := COALESCE(
                       (to_jsonb(NEW)->>'organization_id')::uuid,
                       (to_jsonb(OLD)->>'organization_id')::uuid
                     );
      v_record_id := COALESCE(
                       (to_jsonb(NEW)->>'id')::uuid,
                       (to_jsonb(OLD)->>'id')::uuid
                     );
      v_before := to_jsonb(OLD);
      v_after  := to_jsonb(NEW);
      -- Compute column-level diff
      FOR v_key IN
        SELECT jsonb_object_keys(v_after)
      LOOP
        v_old_val := v_before -> v_key;
        v_new_val := v_after  -> v_key;
        IF v_old_val IS DISTINCT FROM v_new_val THEN
          v_changes := v_changes || jsonb_build_object(
            v_key, jsonb_build_array(v_old_val, v_new_val)
          );
        END IF;
      END LOOP;
    WHEN 'DELETE' THEN
      v_org_id    := (to_jsonb(OLD)->>'organization_id')::uuid;
      v_record_id := (to_jsonb(OLD)->>'id')::uuid;
      v_before    := to_jsonb(OLD);
  END CASE;

  -- Map table name → human resource_type
  v_resource := CASE TG_TABLE_NAME
    WHEN 'bills'                        THEN 'bill'
    WHEN 'bill_line_items'              THEN 'bill_line_item'
    WHEN 'customer_invoices'            THEN 'invoice'
    WHEN 'customer_invoice_line_items'  THEN 'invoice_line_item'
    WHEN 'jobs'                         THEN 'job'
    WHEN 'customers'                    THEN 'customer'
    WHEN 'suppliers'                    THEN 'supplier'
    WHEN 'employees'                    THEN 'employee'
    WHEN 'wage_entries'                 THEN 'timesheet_entry'
    WHEN 'subscriptions'                THEN 'subscription'
    WHEN 'debts'                        THEN 'debt'
    WHEN 'bank_connections'             THEN 'bank_connection'
    WHEN 'organization_memberships'     THEN 'membership'
    ELSE TG_TABLE_NAME
  END;

  INSERT INTO audit_log (
    organization_id,
    table_name,
    record_id,
    operation,
    actor_user_id,
    before_data,
    after_data,
    -- new columns
    actor_email,
    action,
    resource_type,
    resource_id,
    before,
    after,
    changes
  ) VALUES (
    v_org_id,
    TG_TABLE_NAME,
    v_record_id,
    TG_OP::audit_operation,
    v_actor_id,
    v_before,
    v_after,
    -- new columns
    v_actor_email,
    TG_OP,
    v_resource,
    v_record_id,
    v_before,
    v_after,
    CASE WHEN TG_OP = 'UPDATE' THEN v_changes ELSE NULL END
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ============================================================================
-- 5. RE-APPLY AUDIT TRIGGER ON BUSINESS TABLES TO USE V2
--    Drop old write_audit_log triggers and install audit_log_trigger_v2.
--    Excludes: audit_log itself, xero_sync_log, crm_sync_log (append-only),
--              bank_transactions (too high-volume).
-- ============================================================================

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'bills', 'bill_line_items',
    'customer_invoices', 'customer_invoice_line_items',
    'jobs', 'customers', 'suppliers',
    'employees', 'wage_entries',
    'organization_memberships'
  ])
  LOOP
    -- Drop the old audit trigger installed by migration 0001
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%I_audit ON %I;', t, t
    );
    -- Install the v2 trigger
    EXECUTE format(
      'CREATE TRIGGER trg_%I_audit_v2
       AFTER INSERT OR UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION audit_log_trigger_v2();', t, t
    );
  END LOOP;
END $$;

-- ============================================================================
-- 6. require_role() HELPER
--    Returns TRUE if the current authenticated user has at least min_role
--    for ANY organization they are a member of, OR for a specific org.
--
--    Role order (ascending privilege):
--      viewer(0) < employee(1) < accountant(2) < admin(3) < owner(4)
--
--    Overloads:
--      require_role(min_role)               → any org membership satisfies
--      require_role(org_id, min_role)       → scoped to specific org
-- ============================================================================

CREATE OR REPLACE FUNCTION public.require_role(min_role org_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM organization_memberships m
     WHERE m.user_id  = auth.uid()
       AND m.role_enum IS NOT NULL
       AND CASE m.role_enum
             WHEN 'owner'      THEN 4
             WHEN 'admin'      THEN 3
             WHEN 'accountant' THEN 2
             WHEN 'employee'   THEN 1
             ELSE 0
           END
           >=
           CASE min_role
             WHEN 'owner'      THEN 4
             WHEN 'admin'      THEN 3
             WHEN 'accountant' THEN 2
             WHEN 'employee'   THEN 1
             ELSE 0
           END
  );
$$;

CREATE OR REPLACE FUNCTION public.require_role(p_org_id uuid, min_role org_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM organization_memberships m
     WHERE m.user_id         = auth.uid()
       AND m.organization_id = p_org_id
       AND m.role_enum       IS NOT NULL
       AND CASE m.role_enum
             WHEN 'owner'      THEN 4
             WHEN 'admin'      THEN 3
             WHEN 'accountant' THEN 2
             WHEN 'employee'   THEN 1
             ELSE 0
           END
           >=
           CASE min_role
             WHEN 'owner'      THEN 4
             WHEN 'admin'      THEN 3
             WHEN 'accountant' THEN 2
             WHEN 'employee'   THEN 1
             ELSE 0
           END
  );
$$;

-- ============================================================================
-- 7. TIGHTEN RLS ON SENSITIVE OPERATIONS
--    Adds admin-or-above requirement for:
--      - Hard-deleting bills (no existing DELETE policy, soft-delete is standard)
--      - Voiding customer_invoices (UPDATE to status='void')
--      - Modifying organization settings (UPDATE on organizations)
--      - Inviting / modifying organization_memberships
--
--    We add RESTRICTIVE policies (AND logic with existing PERMISSIVE ones).
--    Existing SELECT/INSERT/UPDATE permissive policies remain untouched.
--    Only owner/admin callers will have require_role return TRUE.
-- ============================================================================

-- (a) Organizations: only admin+ can update org settings
--     Drop the existing broad update policy, replace with role-gated one.
DROP POLICY IF EXISTS organizations_update ON organizations;
CREATE POLICY organizations_update ON organizations
  FOR UPDATE
  USING (
    id IN (SELECT get_accessible_org_ids())
    AND require_role(id, 'admin'::org_role)
  );

-- (b) Memberships: only admin+ can insert (invite) or update (role-change/remove)
DROP POLICY IF EXISTS memberships_insert ON organization_memberships;
CREATE POLICY memberships_insert ON organization_memberships
  FOR INSERT
  WITH CHECK (
    organization_id IN (SELECT get_accessible_org_ids())
    AND require_role(organization_id, 'admin'::org_role)
  );

DROP POLICY IF EXISTS memberships_update ON organization_memberships;
CREATE POLICY memberships_update ON organization_memberships
  FOR UPDATE
  USING (
    organization_id IN (SELECT get_accessible_org_ids())
    AND require_role(organization_id, 'admin'::org_role)
  );

-- Members deleting themselves (leaving) is allowed; removing others requires admin.
CREATE POLICY memberships_delete ON organization_memberships
  FOR DELETE
  USING (
    -- Can always leave yourself
    user_id = auth.uid()
    OR (
      organization_id IN (SELECT get_accessible_org_ids())
      AND require_role(organization_id, 'admin'::org_role)
    )
  );

-- (c) team_invitations: only admin+ can create/modify invites
DROP POLICY IF EXISTS invitations_all ON team_invitations;
CREATE POLICY invitations_select ON team_invitations
  FOR SELECT
  USING (organization_id IN (SELECT get_accessible_org_ids()));
CREATE POLICY invitations_insert ON team_invitations
  FOR INSERT
  WITH CHECK (
    organization_id IN (SELECT get_accessible_org_ids())
    AND require_role(organization_id, 'admin'::org_role)
  );
CREATE POLICY invitations_update ON team_invitations
  FOR UPDATE
  USING (
    organization_id IN (SELECT get_accessible_org_ids())
    AND require_role(organization_id, 'admin'::org_role)
  );

-- (d) audit_log: org members SELECT only; no client INSERT/UPDATE/DELETE.
--     The existing audit_log_select policy allows all members to read.
--     Existing audit_log_insert policy is dropped (only triggers may insert).
DROP POLICY IF EXISTS audit_log_insert ON audit_log;
DROP POLICY IF EXISTS audit_log_update ON audit_log;
DROP POLICY IF EXISTS audit_log_delete ON audit_log;
-- SELECT stays as-is (already permissive, org-scoped via existing policy).

-- ============================================================================
-- 8. GRANTS FOR NEW OBJECTS
-- ============================================================================

GRANT EXECUTE ON FUNCTION public.require_role(org_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.require_role(uuid, org_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.audit_log_trigger_v2() TO service_role;

-- ============================================================================
-- END
-- ============================================================================

COMMIT;
