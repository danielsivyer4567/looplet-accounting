-- ============================================================================
-- 20261003155000_bank_provider_xero.sql  (XERO-02)
--
-- xero-pull-bank-transactions wrote bank_accounts with bank_connection_id NULL
-- and account_type 'bank'. bank_accounts.bank_connection_id is NOT NULL and
-- 'bank' is not a bank_account_type value, so every insert failed and no Xero
-- bank data was stored. The function now files Xero accounts under a real
-- bank_connections row per organisation and Xero tenant. bank_provider had no
-- value for that (plaid, basiq, manual), so this adds 'xero'.
--
-- ADD VALUE is not used in this transaction, so it is safe inside the
-- migration's transaction.
-- ============================================================================

ALTER TYPE public.bank_provider ADD VALUE IF NOT EXISTS 'xero';

COMMENT ON TYPE public.bank_provider IS
  'Bank-feed source of a bank_connections row. xero = accounts pulled from the '
  'organisation''s Xero tenant (tokens stay in xero_integrations).';
