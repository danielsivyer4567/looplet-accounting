-- SEC-11: a bill may only reference a supplier of its own organisation.
--
-- payment-runs-create copies the payee BSB and account number from the bill's supplier. bills.supplier_id had no
-- same-organisation guard, so anyone who owns an organisation (any sign-up) could point a bill at another
-- organisation's supplier id and copy that supplier's bank details into their own payment run. The supplier auto-link
-- trigger (trg_bills_autolink_supplier, 0081) only ever links within the bill's organisation, so it is unaffected;
-- it fires first (BEFORE triggers run in name order), so a linked supplier_id is checked too. This runs for every
-- role, including the service role. Existing rows are not rewritten; check them before deploying:
--   SELECT b.id FROM bills b JOIN suppliers s ON s.id = b.supplier_id WHERE s.organization_id <> b.organization_id;

CREATE OR REPLACE FUNCTION public.enforce_bill_supplier_same_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.supplier_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.suppliers s WHERE s.id = NEW.supplier_id AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'bill % must reference a supplier of its own organisation', NEW.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bills_supplier_same_org ON public.bills;
CREATE TRIGGER trg_bills_supplier_same_org
  BEFORE INSERT OR UPDATE OF supplier_id, organization_id ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.enforce_bill_supplier_same_org();

REVOKE ALL ON FUNCTION public.enforce_bill_supplier_same_org() FROM PUBLIC, anon, authenticated;
