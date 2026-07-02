-- ============================================================================
-- 0227_stp_secure_tfn_lifecycle.sql  (P2-STP)
--
-- STP Phase 2 hardening:
--   * employee_tfn_vault stores encrypted TFNs separately from employees JSON
--   * direct table access is revoked; clients get masked status via RPC only
--   * employees.wage_components is scrubbed/guarded against plaintext TFNs
--   * payroll-export-stp records a redacted draft lifecycle row in lodgements
--
-- Actual ATO/STP transmission remains disabled and external-gated.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_tfn_vault (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  tfn_encrypted text NOT NULL CHECK (length(btrim(tfn_encrypted)) > 0),
  tfn_last4 text NOT NULL CHECK (tfn_last4 ~ '^[0-9]{4}$'),
  declaration_status text NOT NULL DEFAULT 'declared'
    CHECK (declaration_status IN ('declared', 'not_provided', 'exemption', 'missing')),
  source_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  CONSTRAINT employee_tfn_vault_one_per_employee UNIQUE (employee_id)
);

COMMENT ON TABLE public.employee_tfn_vault IS
  'Encrypted employee TFN vault for STP. Stores encrypted TFN material and last4 only; '
  'direct client reads are revoked. Masked status is exposed by employee_tfn_status().';

CREATE INDEX IF NOT EXISTS employee_tfn_vault_org_employee_idx
  ON public.employee_tfn_vault (organization_id, employee_id);

CREATE OR REPLACE FUNCTION public.employee_tfn_vault_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.employees e
     WHERE e.id = NEW.employee_id
       AND e.organization_id = NEW.organization_id
       AND e.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'employee % does not belong to organization %', NEW.employee_id, NEW.organization_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.tfn_last4 := right(regexp_replace(COALESCE(NEW.tfn_last4, ''), '\D', '', 'g'), 4);
  IF length(NEW.tfn_last4) <> 4 THEN
    RAISE EXCEPTION 'tfn_last4 must contain exactly four digits'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS employee_tfn_vault_guard
  ON public.employee_tfn_vault;
CREATE TRIGGER employee_tfn_vault_guard
  BEFORE INSERT OR UPDATE ON public.employee_tfn_vault
  FOR EACH ROW EXECUTE FUNCTION public.employee_tfn_vault_guard();

DROP TRIGGER IF EXISTS employee_tfn_vault_audit
  ON public.employee_tfn_vault;
CREATE TRIGGER employee_tfn_vault_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_tfn_vault
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

CREATE OR REPLACE FUNCTION public.strip_employee_tfn_from_wage_components()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.wage_components := COALESCE(NEW.wage_components, '{}'::jsonb)
    - 'tfn'
    - 'tax_file_number'
    - 'taxFileNumber'
    - 'tfn_encrypted';
  RETURN NEW;
END;
$$;

UPDATE public.employees
   SET wage_components = COALESCE(wage_components, '{}'::jsonb)
    - 'tfn'
    - 'tax_file_number'
    - 'taxFileNumber'
    - 'tfn_encrypted'
 WHERE COALESCE(wage_components, '{}'::jsonb)
   ?| ARRAY['tfn', 'tax_file_number', 'taxFileNumber', 'tfn_encrypted'];

DROP TRIGGER IF EXISTS employees_strip_tfn_from_wage_components
  ON public.employees;
CREATE TRIGGER employees_strip_tfn_from_wage_components
  BEFORE INSERT OR UPDATE OF wage_components ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.strip_employee_tfn_from_wage_components();

ALTER TABLE public.employee_tfn_vault ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_tfn_vault_service_only
  ON public.employee_tfn_vault;
CREATE POLICY employee_tfn_vault_service_only
  ON public.employee_tfn_vault
  FOR ALL
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON public.employee_tfn_vault FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.employee_tfn_status(
  p_org uuid,
  p_employee_id uuid DEFAULT NULL
)
RETURNS TABLE (
  employee_id uuid,
  employee_name text,
  has_tfn boolean,
  tfn_masked text,
  declaration_status text,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    e.id AS employee_id,
    e.full_name AS employee_name,
    v.id IS NOT NULL AS has_tfn,
    CASE WHEN v.id IS NULL THEN NULL ELSE '*****' || v.tfn_last4 END AS tfn_masked,
    COALESCE(v.declaration_status, 'missing') AS declaration_status,
    v.updated_at
  FROM public.employees e
  LEFT JOIN public.employee_tfn_vault v
    ON v.employee_id = e.id
   AND v.organization_id = e.organization_id
  WHERE e.organization_id = p_org
    AND e.deleted_at IS NULL
    AND (p_employee_id IS NULL OR e.id = p_employee_id)
    AND public.require_role(p_org, 'admin'::public.org_role)
  ORDER BY e.full_name, e.id;
$$;

COMMENT ON FUNCTION public.employee_tfn_status(uuid, uuid) IS
  'Returns masked TFN vault status for employees in an org. Never returns encrypted or plaintext TFN material.';

REVOKE ALL ON FUNCTION public.employee_tfn_status(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.employee_tfn_status(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
