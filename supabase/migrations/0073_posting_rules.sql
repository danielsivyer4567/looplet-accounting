-- ============================================================================
-- 0073: Posting rules + default AU trades chart-of-accounts template.
--
-- Two pieces:
--   1. post_journal_entry(p_entry_id) — the only sanctioned path to move an
--      entry from draft -> posted. It enforces the double-entry invariant
--      (SUM(debit_cents) = SUM(credit_cents), and at least one line exists)
--      and stamps posted_at. Once posted, an entry feeds v_trial_balance
--      (0074). It refuses to re-post or post a void entry.
--   2. seed_default_chart_of_accounts(p_org_id) — populates a sensible default
--      chart of accounts for an Australian trades business. It is a TEMPLATE
--      function (insert-if-not-exists, keyed on organization_id + code) so it
--      can be called per org at onboarding. We deliberately DO NOT blind-insert
--      against a hardcoded org id in this migration — the caller supplies the
--      org, and the function is idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- post_journal_entry: validate balance, flip draft -> posted.
--
-- SECURITY DEFINER + SET search_path = '' (empty) per the hardened convention:
-- all object references inside are fully schema-qualified. REVOKE FROM PUBLIC,
-- GRANT EXECUTE to authenticated. Org access is still enforced because the
-- function only operates on an entry the caller can see (the RLS check is
-- re-applied explicitly below since SECURITY DEFINER bypasses RLS).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_journal_entry(p_entry_id uuid)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_entry   public.journal_entries;
  v_debits  bigint;
  v_credits bigint;
  v_lines   int;
BEGIN
  -- Lock the header so two concurrent posts can't race.
  SELECT * INTO v_entry
    FROM public.journal_entries
   WHERE id = p_entry_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal entry % not found', p_entry_id;
  END IF;

  -- SECURITY DEFINER bypasses RLS — re-assert org access explicitly so a user
  -- cannot post an entry belonging to an org they cannot access.
  IF v_entry.organization_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'not authorized to post journal entry %', p_entry_id;
  END IF;

  IF v_entry.status = 'posted' THEN
    RAISE EXCEPTION 'journal entry % is already posted', p_entry_id;
  END IF;

  IF v_entry.status = 'void' THEN
    RAISE EXCEPTION 'journal entry % is void and cannot be posted', p_entry_id;
  END IF;

  SELECT COALESCE(SUM(debit_cents), 0),
         COALESCE(SUM(credit_cents), 0),
         COUNT(*)
    INTO v_debits, v_credits, v_lines
    FROM public.journal_lines
   WHERE journal_entry_id = p_entry_id;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'journal entry % has no lines', p_entry_id;
  END IF;

  IF v_debits <> v_credits THEN
    RAISE EXCEPTION
      'journal entry % is unbalanced: debits=% credits=%',
      p_entry_id, v_debits, v_credits;
  END IF;

  UPDATE public.journal_entries
     SET status = 'posted',
         posted_at = now()
   WHERE id = p_entry_id
  RETURNING * INTO v_entry;

  RETURN v_entry;
END;
$$;

REVOKE ALL ON FUNCTION public.post_journal_entry(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_journal_entry(uuid) TO authenticated;

COMMENT ON FUNCTION public.post_journal_entry(uuid) IS
  'Validates that a journal entry balances (SUM debits = SUM credits, >=1 line) and flips its status draft -> posted, stamping posted_at. Raises on unbalanced/empty/already-posted/void entries. SECURITY DEFINER with empty search_path; re-checks org access via get_accessible_org_ids().';

-- ----------------------------------------------------------------------------
-- seed_default_chart_of_accounts: per-org AU trades-business COA template.
--
-- Idempotent: ON CONFLICT (organization_id, code) DO NOTHING. Codes follow the
-- common 1000/2000/3000/4000/5000-6000 banding (assets / liabilities / equity
-- / income / expenses). This is a starting point an operator can rename or
-- extend; it is NOT prescriptive accounting advice.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_default_chart_of_accounts(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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
    (p_org_id, '6900', 'Other expenses',                'expense')
  ON CONFLICT (organization_id, code) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_default_chart_of_accounts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_default_chart_of_accounts(uuid) TO authenticated;

COMMENT ON FUNCTION public.seed_default_chart_of_accounts(uuid) IS
  'Idempotent template that seeds a default Australian trades-business chart of accounts for the given org (insert-if-not-exists on organization_id+code). Call at onboarding. Not prescriptive accounting advice — codes/names are a starting point.';
