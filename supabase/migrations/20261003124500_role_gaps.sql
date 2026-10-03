-- Role gaps found by the SEC-05 and SEC-10 verifiers.
--
-- 1. seed_default_chart_of_accounts(uuid) is SECURITY DEFINER and executable by signed-in users, but only checked
--    membership, so a viewer could insert the default accounts into their organisation (chart_of_accounts is
--    accountant+ since 20261003123000). It now applies the same role check.
-- 2. obligation_status, xero_account_codes and bas_worksheet_snapshots are compliance records and the Xero code
--    mapping; any accepted member could still write them. They now need accountant+.
-- 3. get_accessible_org_ids()'s agency branch read the legacy role column while every role check reads role_enum;
--    an agency member lowered to viewer in role_enum kept read access to sub-accounts. It now reads role_enum.
-- Bodies are the current definitions (0098 and 0203) with only those lines changed.

CREATE OR REPLACE FUNCTION public.seed_default_chart_of_accounts(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Caller must have access to the target org.
  -- Seeding writes chart_of_accounts (accountant+ since 20261003123000); SECURITY DEFINER bypasses RLS, so the
  -- same role check is made here. public.can_write_org admits accepted accountant+ members, agency admins and the
  -- organisation's own machine token.
  IF p_org_id NOT IN (SELECT public.get_accessible_org_ids())
     OR NOT public.can_write_org(p_org_id, 'accountant'::public.org_role) THEN
    RAISE EXCEPTION 'not authorized to seed chart of accounts for org %', p_org_id USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.chart_of_accounts (organization_id, code, name, account_type)
  VALUES
    -- Assets (1000-1999)
    (p_org_id, '1000', 'Business bank account',        'asset'),
    (p_org_id, '1010', 'Cash on hand',                 'asset'),
    (p_org_id, '1100', 'Accounts receivable',          'asset'),
    (p_org_id, '1200', 'GST receivable (input credits)','asset'),
    (p_org_id, '1500', 'Tools & equipment',            'asset'),
    (p_org_id, '1600', 'Motor vehicles',               'asset'),
    (p_org_id, '1900', 'Accumulated depreciation',     'asset'),  -- contra-asset (credit balance)
    -- Liabilities (2000-2999)
    (p_org_id, '2000', 'Accounts payable',             'liability'),
    (p_org_id, '2100', 'GST payable (collected)',       'liability'),
    (p_org_id, '2200', 'PAYG withholding payable',      'liability'),
    (p_org_id, '2300', 'Superannuation payable',        'liability'),
    (p_org_id, '2400', 'Credit card',                   'liability'),
    (p_org_id, '2500', 'Loans & finance',               'liability'),
    (p_org_id, '2600', 'Accrued expenses',              'liability'),  -- SC-1.I.02 reversing accruals
    -- Equity (3000-3999)
    (p_org_id, '3000', 'Owner capital',                 'equity'),
    (p_org_id, '3100', 'Owner drawings',                'equity'),
    (p_org_id, '3900', 'Retained earnings',             'equity'),
    -- Income (4000-4999)
    (p_org_id, '4000', 'Job revenue',                   'income'),
    (p_org_id, '4100', 'Materials recharged',           'income'),
    (p_org_id, '4900', 'Other income',                  'income'),
    -- Expenses (5000-6999)
    (p_org_id, '5000', 'Materials & supplies',          'expense'),
    (p_org_id, '5100', 'Subcontractors',                'expense'),
    (p_org_id, '5200', 'Equipment hire',                'expense'),
    (p_org_id, '6000', 'Wages & salaries',              'expense'),
    (p_org_id, '6010', 'Superannuation expense',        'expense'),
    (p_org_id, '6100', 'Fuel & vehicle running',        'expense'),
    (p_org_id, '6200', 'Insurance',                     'expense'),
    (p_org_id, '6300', 'Phone & internet',              'expense'),
    (p_org_id, '6400', 'Software & subscriptions',      'expense'),
    (p_org_id, '6500', 'Accounting & legal',            'expense'),
    (p_org_id, '6600', 'Bank fees & interest',          'expense'),
    (p_org_id, '6700', 'Depreciation expense',          'expense'),
    (p_org_id, '6900', 'Other expenses',                'expense')
  ON CONFLICT (organization_id, code) DO NOTHING;
END;
$$;


CREATE OR REPLACE FUNCTION public.get_accessible_org_ids() RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id     uuid := auth.uid();
  v_integration uuid := public.integration_org_id();
BEGIN
  -- Integration token: scope strictly to the single pinned org. These tokens
  -- have no auth.uid(); they must NEVER inherit a human's broader access.
  -- (Unchanged from 0069; no membership row is involved, so accepted_at N/A.)
  IF v_user_id IS NULL AND v_integration IS NOT NULL THEN
    RETURN NEXT v_integration;
    RETURN;
  END IF;

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Direct memberships — ACCEPTED ONLY. A pending invite (accepted_at IS NULL)
  -- must not grant any access to the org's data.
  RETURN QUERY
    SELECT m.organization_id
      FROM public.organization_memberships m
     WHERE m.user_id     = v_user_id
       AND m.accepted_at IS NOT NULL;

  -- Sub-accounts of agencies the user admins — the admin's membership on the
  -- agency must itself be ACCEPTED to inherit the agency's sub-accounts.
  RETURN QUERY
    SELECT sa.id
      FROM public.organizations sa
      JOIN public.organizations agency
        ON sa.parent_organization_id = agency.id
      JOIN public.organization_memberships m
        ON m.organization_id = agency.id
     WHERE agency.organization_type = 'agency'
       AND sa.organization_type     = 'sub_account'
       AND m.user_id                = v_user_id
       AND m.accepted_at            IS NOT NULL
       AND m.role_enum IN ('owner'::public.org_role, 'admin'::public.org_role);
END;
$$;


DO $$
DECLARE spec record;
BEGIN
  FOR spec IN SELECT * FROM (VALUES ('obligation_status'), ('xero_account_codes'), ('bas_worksheet_snapshots')) AS t(tbl) LOOP
    IF to_regclass('public.' || spec.tbl) IS NULL THEN RAISE NOTICE 'role gaps: % not found, skipped', spec.tbl; CONTINUE; END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec.tbl || '_role_insert', spec.tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec.tbl || '_role_update', spec.tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', spec.tbl || '_role_delete', spec.tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO public WITH CHECK (public.can_write_org(organization_id, %L::public.org_role))', spec.tbl || '_role_insert', spec.tbl, 'accountant');
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO public USING (public.can_write_org(organization_id, %L::public.org_role)) WITH CHECK (public.can_write_org(organization_id, %L::public.org_role))', spec.tbl || '_role_update', spec.tbl, 'accountant', 'accountant');
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO public USING (public.can_write_org(organization_id, %L::public.org_role))', spec.tbl || '_role_delete', spec.tbl, 'accountant');
  END LOOP;
END $$;
