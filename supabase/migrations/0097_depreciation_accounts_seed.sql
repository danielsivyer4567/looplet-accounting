-- 0097: Depreciation accounts in the default chart of accounts (ledger SC-1.G.02).
--
-- The depreciation-run edge fn (SC-1.G.02) posts each month's depreciation as
--   Dr 6700 Depreciation expense  /  Cr 1900 Accumulated depreciation
-- but seed_default_chart_of_accounts (0073) never seeded those two accounts, so on
-- every org the post would fail closed forever and the whole 1.G depreciation engine
-- would silently never post. This migration closes that gap two ways:
--
--   1. Extends seed_default_chart_of_accounts so NEW orgs get the two accounts at
--      onboarding (CREATE OR REPLACE, adding two VALUES rows; still idempotent via
--      ON CONFLICT (organization_id, code) DO NOTHING).
--   2. Backfills EXISTING orgs that already have a seeded chart of accounts, so the
--      engine works for them too without a re-seed.
--
-- Account choices (AU trades COA banding, consistent with 0073):
--   * 6700 Depreciation expense — P&L expense (5000-6999 band; 6600/6900 already used).
--   * 1900 Accumulated depreciation — a CONTRA-ASSET. The account_type enum (0071) has
--     no 'contra_asset', so like every simple COA it is typed 'asset' and carries a
--     credit balance; v_trial_balance (0074) nets it against gross fixed assets.
--
-- Live-verified before writing (dxoikltymmknxqpkpyhi): the live seed function is
-- byte-identical to repo 0073 (no out-of-band drift) and neither 6700 nor 1900
-- exists in the live COA; account_type enum = {asset,liability,equity,income,expense}.

-- 1. New orgs: extend the template (full body preserved + two rows added). -------
CREATE OR REPLACE FUNCTION public.seed_default_chart_of_accounts(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Caller must have access to the target org.
  IF p_org_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'not authorized to seed chart of accounts for org %', p_org_id;
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

REVOKE ALL ON FUNCTION public.seed_default_chart_of_accounts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_default_chart_of_accounts(uuid) TO authenticated;

COMMENT ON FUNCTION public.seed_default_chart_of_accounts(uuid) IS
  'Idempotent template that seeds a default Australian trades-business chart of accounts for the given org (insert-if-not-exists on organization_id+code). Includes 6700 Depreciation expense + 1900 Accumulated depreciation (contra-asset) for the depreciation engine (SC-1.G). Call at onboarding. Not prescriptive accounting advice — codes/names are a starting point.';

-- 2. Existing orgs: backfill the two new accounts wherever a COA already exists. --
-- Only orgs that have been seeded (have >=1 account) get them, idempotently.
INSERT INTO public.chart_of_accounts (organization_id, code, name, account_type)
SELECT o.organization_id, v.code, v.name, v.account_type
FROM (SELECT DISTINCT organization_id FROM public.chart_of_accounts) o
CROSS JOIN (
  VALUES
    ('1900', 'Accumulated depreciation', 'asset'::public.account_type),
    ('6700', 'Depreciation expense',     'expense'::public.account_type)
) AS v(code, name, account_type)
ON CONFLICT (organization_id, code) DO NOTHING;
