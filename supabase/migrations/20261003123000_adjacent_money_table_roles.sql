-- SEC-05 (second part): the tables next to the money tables need a role too, and the agency rule uses role_enum.
--
-- 20261003120000 put role checks on the headline money tables, but a viewer could still change an invoice's total by
-- editing its lines, settle it by inserting a payment, or match a bank transaction by hand, because SECURITY DEFINER
-- triggers carry writes on invoice_line_items, invoice_payments and bank_transactions into invoices. The same gap
-- covered bill lines, allocation splits, the chart of accounts, debts, assets, timesheets, wages, super batch lines,
-- the tax registers (trusts, Div 7A, CGT, franking, FBT, SMSF) and the integration settings. This migration adds the
-- same RESTRICTIVE policies, via public.can_write_org, to every remaining organisation-scoped table that any accepted
-- member could write. Reads are unchanged.
--
--   employee+   timesheet_entries, jobs, bill_line_items (insert only; staff log time and capture bills)
--   accountant+ everything that changes the books or the tax registers
--   admin+      wage_entries, super_batch_lines, business_profile, xero_integrations, gmail_integrations,
--               bank_connections (pay data and connections to outside systems)
--
-- can_write_org's agency branch now reads role_enum (the column every role check uses) instead of the legacy role
-- column, so an agency member whose role_enum was lowered to viewer no longer keeps write access to sub-accounts.

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
               AND m.role_enum IN ('owner'::public.org_role, 'admin'::public.org_role)))
  END
$$;

DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      -- table, insert role, update/delete role
      ('timesheet_entries',             'employee',   'employee'),
      ('jobs',                          'employee',   'employee'),
      ('bill_line_items',               'employee',   'accountant'),
      ('invoice_line_items',            'accountant', 'accountant'),
      ('invoice_payments',              'accountant', 'accountant'),
      ('customer_invoice_line_items',   'accountant', 'accountant'),
      ('bank_transactions',             'accountant', 'accountant'),
      ('allocation_splits',             'accountant', 'accountant'),
      ('chart_of_accounts',             'accountant', 'accountant'),
      ('system_accounts',               'accountant', 'accountant'),
      ('intake_rules',                  'accountant', 'accountant'),
      ('debts',                         'accountant', 'accountant'),
      ('debt_payments',                 'accountant', 'accountant'),
      ('fixed_assets',                  'accountant', 'accountant'),
      ('depreciation_schedules',        'accountant', 'accountant'),
      ('overhead_allocations',          'accountant', 'accountant'),
      ('overhead_profiles',             'accountant', 'accountant'),
      ('subscriptions',                 'accountant', 'accountant'),
      ('bas_payg_instalment_amounts',   'accountant', 'accountant'),
      ('payroll_tax_periods',           'accountant', 'accountant'),
      ('franking_account_entries',      'accountant', 'accountant'),
      ('company_dividend_statements',   'accountant', 'accountant'),
      ('company_officers',              'accountant', 'accountant'),
      ('share_register',                'accountant', 'accountant'),
      ('asic_filings',                  'accountant', 'accountant'),
      ('div7a_loans',                   'accountant', 'accountant'),
      ('div7a_loan_repayments',         'accountant', 'accountant'),
      ('div7a_upe',                     'accountant', 'accountant'),
      ('cgt_events',                    'accountant', 'accountant'),
      ('cgt_retirement_exemption_usage','accountant', 'accountant'),
      ('trusts',                        'accountant', 'accountant'),
      ('trust_beneficiaries',           'accountant', 'accountant'),
      ('trust_distributions',           'accountant', 'accountant'),
      ('trust_deed',                    'accountant', 'accountant'),
      ('family_trust_elections',        'accountant', 'accountant'),
      ('beneficiary_tax_profiles',      'accountant', 'accountant'),
      ('fbt_benefit_inputs',            'accountant', 'accountant'),
      ('smsf_funds',                    'accountant', 'accountant'),
      ('smsf_members',                  'accountant', 'accountant'),
      ('smsf_contributions',            'accountant', 'accountant'),
      ('smsf_investments',              'accountant', 'accountant'),
      ('smsf_pensions',                 'accountant', 'accountant'),
      ('wage_entries',                  'admin',      'admin'),
      ('super_batch_lines',             'admin',      'admin'),
      ('business_profile',              'admin',      'admin'),
      ('bank_connections',              'admin',      'admin'),
      ('xero_integrations',             'admin',      'admin'),
      ('gmail_integrations',            'admin',      'admin')
    ) AS t(tbl, insert_role, change_role)
  LOOP
    -- A table this database does not have (a later repo may drop one) is skipped rather than failing the migration.
    IF to_regclass('public.' || spec.tbl) IS NULL THEN
      RAISE NOTICE 'can_write_org policies: table % not found, skipped', spec.tbl;
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = spec.tbl AND column_name = 'organization_id') THEN
      RAISE EXCEPTION 'can_write_org policies: % has no organization_id column', spec.tbl;
    END IF;

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
