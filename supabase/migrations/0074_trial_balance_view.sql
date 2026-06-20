-- ============================================================================
-- 0074: v_trial_balance — the foundation report over POSTED journal lines.
--
-- One row per (organization_id, account) with total debits, total credits and
-- net movement, summed over POSTED journal entries only (draft and void are
-- excluded). This is the single source of truth from which P&L and Balance
-- Sheet are derived going forward (see docs/general-ledger.md):
--
--   net_cents = SUM(debit_cents) - SUM(credit_cents)
--
-- Sign convention (standard double-entry normal balances):
--   * asset / expense accounts have a natural DEBIT balance -> net_cents > 0
--   * liability / equity / income accounts have a natural CREDIT balance ->
--     net_cents < 0
--
-- Reporting layers flip the sign for credit-normal accounts as needed (e.g.
-- income shown as a positive figure on the P&L). Crucially, because revenue
-- here flows from journal postings (GST split into its own 2100 GST payable
-- line), this fixes the audit note that the current P&L mixes GST-inclusive
-- revenue from invoices.
--
-- security_invoker = on: the view runs with the QUERYING user's privileges so
-- RLS on chart_of_accounts / journal_entries / journal_lines applies, keeping
-- the view org-scoped without re-implementing get_accessible_org_ids() here.
-- ============================================================================

CREATE OR REPLACE VIEW public.v_trial_balance
WITH (security_invoker = on) AS
SELECT
  coa.organization_id                              AS organization_id,
  coa.id                                           AS account_id,
  coa.code                                         AS account_code,
  coa.name                                         AS account_name,
  coa.account_type                                 AS account_type,
  COALESCE(SUM(jl.debit_cents), 0)::bigint         AS total_debit_cents,
  COALESCE(SUM(jl.credit_cents), 0)::bigint        AS total_credit_cents,
  (COALESCE(SUM(jl.debit_cents), 0)
   - COALESCE(SUM(jl.credit_cents), 0))::bigint    AS net_cents
FROM public.chart_of_accounts coa
-- LEFT JOIN to lines that belong to a POSTED entry. Folding the posted check
-- into the join (rather than a WHERE filter) keeps every account in the result
-- as a zero row even when it has only draft/void lines or no lines at all, so
-- the full chart of accounts is always visible in the trial balance.
LEFT JOIN public.journal_entries je
       ON je.organization_id = coa.organization_id
      AND je.status = 'posted'
LEFT JOIN public.journal_lines jl
       ON jl.journal_entry_id = je.id
      AND jl.account_id = coa.id
GROUP BY
  coa.organization_id,
  coa.id,
  coa.code,
  coa.name,
  coa.account_type;

COMMENT ON VIEW public.v_trial_balance IS
  'Trial balance per (organization, account) over POSTED journal entries only. total_debit_cents / total_credit_cents and net_cents = debits - credits (debit-positive). Accounts with no postings appear as zero rows. Foundation for GL-derived P&L (income/expense accounts) and Balance Sheet (asset/liability/equity accounts) — replaces the GST-inclusive invoice-based approximations in 0041/0047. security_invoker=on so underlying-table RLS scopes results to the caller''s orgs.';

GRANT SELECT ON public.v_trial_balance TO authenticated;
