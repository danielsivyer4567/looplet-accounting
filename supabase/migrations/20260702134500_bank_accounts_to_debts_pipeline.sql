-- Promote imported liability bank accounts into tracked debts.
--
-- Basiq, CSV, and PDF statement imports all converge on bank_accounts. When an
-- imported account is a credit card or loan, keep one active debts row linked
-- to that source account so the Debts module, balance sheet, and payment tracker
-- are fed by the bank pipeline instead of relying on manual re-entry.

CREATE UNIQUE INDEX IF NOT EXISTS idx_debts_org_bank_account_active
  ON public.debts (organization_id, bank_account_id)
  WHERE bank_account_id IS NOT NULL
    AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.sync_debt_from_bank_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind public.debt_kind;
  v_lender_name text;
  v_balance_cents bigint;
BEGIN
  IF NEW.is_active IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;

  IF NEW.account_type NOT IN ('credit_card'::public.bank_account_type, 'loan'::public.bank_account_type) THEN
    RETURN NEW;
  END IF;

  v_kind := CASE NEW.account_type
    WHEN 'credit_card'::public.bank_account_type THEN 'credit_card'::public.debt_kind
    ELSE 'business_loan'::public.debt_kind
  END;

  SELECT bc.institution_name
    INTO v_lender_name
    FROM public.bank_connections bc
   WHERE bc.id = NEW.bank_connection_id
     AND bc.organization_id = NEW.organization_id;

  v_balance_cents := abs(coalesce(NEW.current_balance_cents, 0));

  INSERT INTO public.debts (
    organization_id,
    name,
    kind,
    lender_name,
    account_number_last4,
    bank_account_id,
    original_balance_cents,
    current_balance_cents,
    is_personal,
    notes
  )
  VALUES (
    NEW.organization_id,
    coalesce(nullif(trim(NEW.name), ''), initcap(replace(NEW.account_type::text, '_', ' '))),
    v_kind,
    v_lender_name,
    NEW.account_number_last4,
    NEW.id,
    v_balance_cents,
    v_balance_cents,
    false,
    'Created from linked bank account feed; update debt terms after review.'
  )
  ON CONFLICT (organization_id, bank_account_id)
    WHERE bank_account_id IS NOT NULL AND deleted_at IS NULL
  DO UPDATE SET
    name = EXCLUDED.name,
    kind = EXCLUDED.kind,
    lender_name = coalesce(EXCLUDED.lender_name, public.debts.lender_name),
    account_number_last4 = EXCLUDED.account_number_last4,
    current_balance_cents = EXCLUDED.current_balance_cents,
    updated_at = now()
  WHERE public.debts.deleted_at IS NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_debt_from_bank_account ON public.bank_accounts;
CREATE TRIGGER trg_sync_debt_from_bank_account
AFTER INSERT OR UPDATE OF account_type, current_balance_cents, account_number_last4, name, is_active
ON public.bank_accounts
FOR EACH ROW
EXECUTE FUNCTION public.sync_debt_from_bank_account();

INSERT INTO public.debts (
  organization_id,
  name,
  kind,
  lender_name,
  account_number_last4,
  bank_account_id,
  original_balance_cents,
  current_balance_cents,
  is_personal,
  notes
)
SELECT
  ba.organization_id,
  coalesce(nullif(trim(ba.name), ''), initcap(replace(ba.account_type::text, '_', ' '))) AS name,
  CASE ba.account_type
    WHEN 'credit_card'::public.bank_account_type THEN 'credit_card'::public.debt_kind
    ELSE 'business_loan'::public.debt_kind
  END AS kind,
  bc.institution_name AS lender_name,
  ba.account_number_last4,
  ba.id AS bank_account_id,
  abs(coalesce(ba.current_balance_cents, 0)) AS original_balance_cents,
  abs(coalesce(ba.current_balance_cents, 0)) AS current_balance_cents,
  false AS is_personal,
  'Created from linked bank account feed; update debt terms after review.' AS notes
FROM public.bank_accounts ba
LEFT JOIN public.bank_connections bc
  ON bc.id = ba.bank_connection_id
 AND bc.organization_id = ba.organization_id
WHERE ba.is_active = true
  AND ba.account_type IN ('credit_card'::public.bank_account_type, 'loan'::public.bank_account_type)
  AND NOT EXISTS (
    SELECT 1
      FROM public.debts d
     WHERE d.organization_id = ba.organization_id
       AND d.bank_account_id = ba.id
       AND d.deleted_at IS NULL
  );

REVOKE ALL ON FUNCTION public.sync_debt_from_bank_account() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.sync_debt_from_bank_account() IS
  'Maintains a reviewed debt row for active imported credit-card/loan bank_accounts.';
