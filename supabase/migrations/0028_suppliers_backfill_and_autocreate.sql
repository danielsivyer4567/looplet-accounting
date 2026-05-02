-- 0028: Suppliers spine — fill UI columns, backfill from bills, auto-create on future inserts
--
-- Closes the data gap where 124 bills had OCR-extracted supplier_name_raw but
-- 0 supplier records existed. Future bills route through trg_bills_autolink_supplier.

-- 1. Add columns the SuppliersPage already references but never had
ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS current_balance_owing_cents bigint;

-- 2. Normalise function for dedupe
CREATE OR REPLACE FUNCTION public.normalise_supplier_name(raw text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(trim(coalesce(raw, '')), '\s+', ' ', 'g'))
$$;

-- 3. Unique index per-org on normalised name (ignore soft-deleted)
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_org_normalised_name_uniq
  ON public.suppliers (organization_id, public.normalise_supplier_name(name))
  WHERE deleted_at IS NULL;

-- 4. Backfill suppliers from distinct supplier_name_raw values
WITH candidates AS (
  SELECT DISTINCT
    organization_id,
    trim(supplier_name_raw) AS clean_name,
    (array_agg(supplier_abn) FILTER (WHERE supplier_abn IS NOT NULL))[1] AS abn
  FROM public.bills
  WHERE supplier_name_raw IS NOT NULL
    AND length(trim(supplier_name_raw)) >= 3
    AND trim(supplier_name_raw) NOT IN ('(unauthored)', '(unknown)', '(no description)')
    AND deleted_at IS NULL
  GROUP BY organization_id, trim(supplier_name_raw)
)
INSERT INTO public.suppliers (organization_id, name, abn, payment_terms_days)
SELECT organization_id, clean_name, abn, 30
FROM candidates
ON CONFLICT (organization_id, public.normalise_supplier_name(name))
WHERE deleted_at IS NULL
DO NOTHING;

-- 5. Per-row link, skip on bills_org_supplier_invoice_uniq violation (real duplicates)
DO $$
DECLARE
  rec RECORD;
  skipped int := 0;
  linked int := 0;
BEGIN
  FOR rec IN
    SELECT b.id AS bill_id, s.id AS supplier_id
    FROM public.bills b
    JOIN public.suppliers s
      ON s.organization_id = b.organization_id
     AND public.normalise_supplier_name(s.name) = public.normalise_supplier_name(b.supplier_name_raw)
     AND s.deleted_at IS NULL
    WHERE b.supplier_id IS NULL
      AND b.deleted_at IS NULL
  LOOP
    BEGIN
      UPDATE public.bills SET supplier_id = rec.supplier_id WHERE id = rec.bill_id;
      linked := linked + 1;
    EXCEPTION WHEN unique_violation THEN
      skipped := skipped + 1;
      RAISE NOTICE 'Skipping bill % (duplicate invoice_number for supplier %)', rec.bill_id, rec.supplier_id;
    END;
  END LOOP;
  RAISE NOTICE 'Backfill: linked=% skipped=%', linked, skipped;
END $$;

-- 6. BEFORE trigger to auto-create + link supplier on future bill inserts/updates
CREATE OR REPLACE FUNCTION public.bills_autolink_supplier()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  matched_id uuid;
  clean_name text;
BEGIN
  IF NEW.supplier_id IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.supplier_name_raw IS NULL OR length(trim(NEW.supplier_name_raw)) < 3 THEN RETURN NEW; END IF;
  clean_name := trim(NEW.supplier_name_raw);
  IF clean_name IN ('(unauthored)', '(unknown)', '(no description)') THEN RETURN NEW; END IF;

  SELECT id INTO matched_id
  FROM public.suppliers
  WHERE organization_id = NEW.organization_id
    AND public.normalise_supplier_name(name) = public.normalise_supplier_name(clean_name)
    AND deleted_at IS NULL
  LIMIT 1;

  IF matched_id IS NULL THEN
    INSERT INTO public.suppliers (organization_id, name, abn, payment_terms_days)
    VALUES (NEW.organization_id, clean_name, NEW.supplier_abn, 30)
    RETURNING id INTO matched_id;
  END IF;

  NEW.supplier_id := matched_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bills_autolink_supplier ON public.bills;
CREATE TRIGGER trg_bills_autolink_supplier
  BEFORE INSERT OR UPDATE OF supplier_name_raw, supplier_abn ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.bills_autolink_supplier();
