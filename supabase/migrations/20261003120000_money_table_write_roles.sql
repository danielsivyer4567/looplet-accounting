-- SEC-05: writes to money tables need a role, not just membership.
--
-- Until now every policy on these tables only asked "is the caller an accepted member of the organisation?"
-- (organization_id IN get_accessible_org_ids()), so a viewer could change a supplier's payee BSB, unlock a period,
-- edit journals or build a payment run. This migration adds RESTRICTIVE policies, which Postgres ANDs with the
-- existing permissive ones, so reads are unchanged and every write also needs a minimum role via
-- public.can_write_org(organization_id, role), which allows:
--   * a signed-in user whose ACCEPTED membership ranks at or above the role (public.require_role;
--     owner > admin > accountant > employee > viewer);
--   * an accepted owner/admin of the parent agency, in its sub-accounts, for roles up to admin (the same agency rule
--     public.get_accessible_org_ids() already applies);
--   * an organisation-pinned machine token (no user, organization_id claim; minted server-side, e.g. accruals-run
--     posting journals), for its own organisation only, exactly as the permissive policies already allowed.
--
--   bills                                      insert: employee+ (staff capture bills)   update/delete: accountant+
--   invoices, journal_entries, journal_lines,
--   period_locks, suppliers, customers,
--   bank_accounts                              all writes: accountant+
--   employees, payment_runs, payment_run_items,
--   super_batches                              all writes: admin+ (matches pay_runs/pay_slips and the payroll functions)
--
-- The service role and SECURITY DEFINER functions owned by postgres bypass RLS as before; definer functions that
-- users call get the same checks in 20261003121000 (SEC-10).
--
-- It also stops child rows pointing at another organisation's records: a payment run item must reference a payment run
-- and a bill of its own organisation, and a pay slip a pay run and an employee of its own organisation. RLS only checked
-- the child row's own organization_id, so a member of organisation A could attach organisation B's bill to A's run.

CREATE OR REPLACE FUNCTION public.can_write_org(p_org_id uuid, p_min_role public.org_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_org_id IS NULL THEN false
    WHEN auth.uid() IS NULL THEN coalesce(p_org_id = public.integration_org_id(), false)
    ELSE public.require_role(p_org_id, p_min_role)
      OR (p_min_role <= 'admin'::public.org_role AND EXISTS (
            SELECT 1
              FROM public.organizations sa
              JOIN public.organizations agency ON sa.parent_organization_id = agency.id
              JOIN public.organization_memberships m ON m.organization_id = agency.id
             WHERE sa.id = p_org_id
               AND agency.organization_type = 'agency'
               AND sa.organization_type = 'sub_account'
               AND m.user_id = auth.uid()
               AND m.accepted_at IS NOT NULL
               AND m.role IN ('owner', 'admin')))
  END
$$;

COMMENT ON FUNCTION public.can_write_org(uuid, public.org_role) IS
  'TRUE when the caller may write the organisation''s books at p_min_role: an accepted member at or above the role, '
  'an accepted owner/admin of the parent agency (roles up to admin), or an organisation-pinned machine token for its '
  'own organisation. Used by the RESTRICTIVE write policies (SEC-05) and definer write functions (SEC-10).';

REVOKE ALL ON FUNCTION public.can_write_org(uuid, public.org_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_write_org(uuid, public.org_role) TO authenticated, service_role;

DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('bills',             'employee',   'accountant'),
      ('invoices',          'accountant', 'accountant'),
      ('journal_entries',   'accountant', 'accountant'),
      ('period_locks',      'accountant', 'accountant'),
      ('suppliers',         'accountant', 'accountant'),
      ('customers',         'accountant', 'accountant'),
      ('bank_accounts',     'accountant', 'accountant'),
      ('employees',         'admin',      'admin'),
      ('payment_runs',      'admin',      'admin'),
      ('payment_run_items', 'admin',      'admin'),
      ('super_batches',     'admin',      'admin')
    ) AS t(tbl, insert_role, change_role)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec.tbl || '_role_insert', spec.tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec.tbl || '_role_update', spec.tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec.tbl || '_role_delete', spec.tbl);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO public '
      'WITH CHECK (public.can_write_org(organization_id, %L::public.org_role))',
      spec.tbl || '_role_insert', spec.tbl, spec.insert_role);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO public '
      'USING (public.can_write_org(organization_id, %L::public.org_role)) '
      'WITH CHECK (public.can_write_org(organization_id, %L::public.org_role))',
      spec.tbl || '_role_update', spec.tbl, spec.change_role, spec.change_role);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO public '
      'USING (public.can_write_org(organization_id, %L::public.org_role))',
      spec.tbl || '_role_delete', spec.tbl, spec.change_role);
  END LOOP;
END $$;

-- journal_lines has no organization_id of its own; its organisation is the parent journal entry's.
DROP POLICY IF EXISTS journal_lines_role_insert ON public.journal_lines;
DROP POLICY IF EXISTS journal_lines_role_update ON public.journal_lines;
DROP POLICY IF EXISTS journal_lines_role_delete ON public.journal_lines;

CREATE POLICY journal_lines_role_insert ON public.journal_lines AS RESTRICTIVE FOR INSERT TO public
  WITH CHECK (EXISTS (SELECT 1 FROM public.journal_entries je
                       WHERE je.id = journal_lines.journal_entry_id
                         AND public.can_write_org(je.organization_id, 'accountant'::public.org_role)));
CREATE POLICY journal_lines_role_update ON public.journal_lines AS RESTRICTIVE FOR UPDATE TO public
  USING (EXISTS (SELECT 1 FROM public.journal_entries je
                  WHERE je.id = journal_lines.journal_entry_id
                    AND public.can_write_org(je.organization_id, 'accountant'::public.org_role)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.journal_entries je
                       WHERE je.id = journal_lines.journal_entry_id
                         AND public.can_write_org(je.organization_id, 'accountant'::public.org_role)));
CREATE POLICY journal_lines_role_delete ON public.journal_lines AS RESTRICTIVE FOR DELETE TO public
  USING (EXISTS (SELECT 1 FROM public.journal_entries je
                  WHERE je.id = journal_lines.journal_entry_id
                    AND public.can_write_org(je.organization_id, 'accountant'::public.org_role)));

-- Child rows must reference parents in their own organisation. These run for every role, including the service role.
CREATE OR REPLACE FUNCTION public.enforce_payment_run_item_same_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.payment_runs r WHERE r.id = NEW.payment_run_id AND r.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'payment run item % must belong to the organisation of its payment run', NEW.id
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bills b WHERE b.id = NEW.bill_id AND b.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'payment run item % must reference a bill of its own organisation', NEW.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_run_items_same_org ON public.payment_run_items;
CREATE TRIGGER trg_payment_run_items_same_org
  BEFORE INSERT OR UPDATE OF organization_id, payment_run_id, bill_id ON public.payment_run_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_run_item_same_org();

CREATE OR REPLACE FUNCTION public.enforce_pay_slip_same_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pay_runs r WHERE r.id = NEW.pay_run_id AND r.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'pay slip % must belong to the organisation of its pay run', NEW.id
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.id = NEW.employee_id AND e.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'pay slip % must reference an employee of its own organisation', NEW.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pay_slips_same_org ON public.pay_slips;
CREATE TRIGGER trg_pay_slips_same_org
  BEFORE INSERT OR UPDATE OF organization_id, pay_run_id, employee_id ON public.pay_slips
  FOR EACH ROW EXECUTE FUNCTION public.enforce_pay_slip_same_org();

REVOKE ALL ON FUNCTION public.enforce_payment_run_item_same_org() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_pay_slip_same_org() FROM PUBLIC, anon, authenticated;
