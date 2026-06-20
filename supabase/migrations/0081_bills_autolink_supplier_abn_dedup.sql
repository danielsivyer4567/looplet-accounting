-- 0081: Make bills_autolink_supplier() robust to ABN collisions.
--
-- Bug: the trigger looked up an existing supplier ONLY by normalised name, and
-- its INSERT ... ON CONFLICT guarded ONLY the (org, normalised name) index.
-- But suppliers also has a UNIQUE (organization_id, abn) constraint. When OCR
-- re-extracts a bill and returns the SAME abn under a slightly different
-- supplier name (e.g. "Oxworks" vs "Oxworks Pty Ltd"), the name lookup misses,
-- the INSERT fires, and it violates suppliers_organization_id_abn_key — which
-- the name-only ON CONFLICT does not catch. The whole persist then aborts,
-- which is why re-OCR/repair of existing bills failed en masse.
--
-- Fix: (1) also match an existing supplier by abn before inserting, and
-- (2) wrap the INSERT so a unique_violation (abn or otherwise) falls through to
-- a re-select instead of bubbling up. Net effect: the bill links to the
-- existing supplier instead of erroring. Strictly more robust; normal new-
-- supplier inserts are unchanged.

CREATE OR REPLACE FUNCTION public.bills_autolink_supplier()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  matched_id uuid;
  clean_name text;
BEGIN
  IF NEW.supplier_id IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.supplier_name_raw IS NULL OR length(trim(NEW.supplier_name_raw)) < 3 THEN RETURN NEW; END IF;
  clean_name := trim(NEW.supplier_name_raw);
  IF clean_name IN ('(unauthored)', '(unknown)', '(no description)') THEN RETURN NEW; END IF;

  -- Find existing by normalised name.
  SELECT id INTO matched_id
  FROM public.suppliers
  WHERE organization_id = NEW.organization_id
    AND public.normalise_supplier_name(name) = public.normalise_supplier_name(clean_name)
    AND deleted_at IS NULL
  LIMIT 1;

  -- Or by ABN — the same supplier may already exist under a different name.
  IF matched_id IS NULL AND NEW.supplier_abn IS NOT NULL AND length(trim(NEW.supplier_abn)) > 0 THEN
    SELECT id INTO matched_id
    FROM public.suppliers
    WHERE organization_id = NEW.organization_id
      AND abn = NEW.supplier_abn
      AND deleted_at IS NULL
    LIMIT 1;
  END IF;

  IF matched_id IS NULL THEN
    BEGIN
      INSERT INTO public.suppliers (organization_id, name, abn, payment_terms_days)
      VALUES (NEW.organization_id, clean_name, NEW.supplier_abn, 30)
      ON CONFLICT (organization_id, public.normalise_supplier_name(name)) WHERE deleted_at IS NULL
      DO NOTHING;
    EXCEPTION WHEN unique_violation THEN
      -- abn (or any other) unique collision — fall through to the re-select.
      NULL;
    END;

    -- Re-select by name, then by ABN, to pick up whatever now exists.
    SELECT id INTO matched_id
    FROM public.suppliers
    WHERE organization_id = NEW.organization_id
      AND public.normalise_supplier_name(name) = public.normalise_supplier_name(clean_name)
      AND deleted_at IS NULL
    LIMIT 1;

    IF matched_id IS NULL AND NEW.supplier_abn IS NOT NULL AND length(trim(NEW.supplier_abn)) > 0 THEN
      SELECT id INTO matched_id
      FROM public.suppliers
      WHERE organization_id = NEW.organization_id
        AND abn = NEW.supplier_abn
        AND deleted_at IS NULL
      LIMIT 1;
    END IF;
  END IF;

  NEW.supplier_id := matched_id;
  RETURN NEW;
END;
$function$;
