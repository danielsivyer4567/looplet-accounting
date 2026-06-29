-- ============================================================================
-- 0229_credit_notes_product.sql  (P2-CN)
--
-- Product-level AR/AP credit-note workflow:
--   * source-linked customer_credit_notes and supplier_credit_notes document rows
--   * RPC-only create/post path with accountant-role enforcement
--   * canonical GL posting via the existing post_*_credit_note_journal functions
--   * posted journal link stored back on the document row for audit/drilldown
-- ============================================================================

BEGIN;

DO $$
BEGIN
  CREATE TYPE public.credit_note_status AS ENUM ('draft', 'posted', 'void');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.customer_credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  credit_note_number text NOT NULL,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  customer_name text NOT NULL,
  credit_note_date date NOT NULL DEFAULT CURRENT_DATE,
  subtotal_ex_gst_cents bigint NOT NULL CHECK (subtotal_ex_gst_cents >= 0),
  gst_cents bigint NOT NULL CHECK (gst_cents >= 0),
  total_inc_gst_cents bigint NOT NULL CHECK (total_inc_gst_cents > 0),
  revenue_account_code text NOT NULL DEFAULT '4000',
  reason text,
  status public.credit_note_status NOT NULL DEFAULT 'posted',
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  posted_at timestamptz,
  xero_status text,
  xero_credit_note_id text,
  xero_synced_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  CONSTRAINT customer_credit_notes_org_number_uniq UNIQUE (organization_id, credit_note_number),
  CONSTRAINT customer_credit_notes_total_check
    CHECK (total_inc_gst_cents = subtotal_ex_gst_cents + gst_cents)
);

CREATE INDEX IF NOT EXISTS customer_credit_notes_org_date_idx
  ON public.customer_credit_notes (organization_id, credit_note_date DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_credit_notes_invoice_idx
  ON public.customer_credit_notes (invoice_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_credit_notes_journal_idx
  ON public.customer_credit_notes (journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;

COMMENT ON TABLE public.customer_credit_notes IS
  'AR/customer credit note documents. Created through create_customer_credit_note(), '
  'which posts the canonical GL journal and links journal_entry_id.';

CREATE TABLE IF NOT EXISTS public.supplier_credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  credit_note_number text NOT NULL,
  bill_id uuid NOT NULL REFERENCES public.bills(id) ON DELETE RESTRICT,
  supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  supplier_name text NOT NULL,
  credit_note_date date NOT NULL DEFAULT CURRENT_DATE,
  subtotal_ex_gst_cents bigint NOT NULL CHECK (subtotal_ex_gst_cents >= 0),
  gst_cents bigint NOT NULL CHECK (gst_cents >= 0),
  total_inc_gst_cents bigint NOT NULL CHECK (total_inc_gst_cents > 0),
  counter_account_code text NOT NULL DEFAULT '5000',
  counter_account_type public.account_type NOT NULL DEFAULT 'expense'::public.account_type,
  reason text,
  status public.credit_note_status NOT NULL DEFAULT 'posted',
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  posted_at timestamptz,
  xero_status text,
  xero_credit_note_id text,
  xero_synced_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  CONSTRAINT supplier_credit_notes_org_number_uniq UNIQUE (organization_id, credit_note_number),
  CONSTRAINT supplier_credit_notes_total_check
    CHECK (total_inc_gst_cents = subtotal_ex_gst_cents + gst_cents)
);

CREATE INDEX IF NOT EXISTS supplier_credit_notes_org_date_idx
  ON public.supplier_credit_notes (organization_id, credit_note_date DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS supplier_credit_notes_bill_idx
  ON public.supplier_credit_notes (bill_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS supplier_credit_notes_journal_idx
  ON public.supplier_credit_notes (journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;

COMMENT ON TABLE public.supplier_credit_notes IS
  'AP/supplier credit note documents. Created through create_supplier_credit_note(), '
  'which posts the canonical GL journal and links journal_entry_id.';

DROP TRIGGER IF EXISTS customer_credit_notes_set_updated_at
  ON public.customer_credit_notes;
CREATE TRIGGER customer_credit_notes_set_updated_at
  BEFORE UPDATE ON public.customer_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS supplier_credit_notes_set_updated_at
  ON public.supplier_credit_notes;
CREATE TRIGGER supplier_credit_notes_set_updated_at
  BEFORE UPDATE ON public.supplier_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS customer_credit_notes_audit
  ON public.customer_credit_notes;
CREATE TRIGGER customer_credit_notes_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.customer_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

DROP TRIGGER IF EXISTS supplier_credit_notes_audit
  ON public.supplier_credit_notes;
CREATE TRIGGER supplier_credit_notes_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.supplier_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

ALTER TABLE public.customer_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_credit_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customer_credit_notes_select
  ON public.customer_credit_notes;
CREATE POLICY customer_credit_notes_select
  ON public.customer_credit_notes FOR SELECT
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS supplier_credit_notes_select
  ON public.supplier_credit_notes;
CREATE POLICY supplier_credit_notes_select
  ON public.supplier_credit_notes FOR SELECT
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

REVOKE ALL ON public.customer_credit_notes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.supplier_credit_notes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.customer_credit_notes TO authenticated;
GRANT SELECT ON public.supplier_credit_notes TO authenticated;

CREATE OR REPLACE FUNCTION public.create_customer_credit_note(
  p_organization_id uuid,
  p_invoice_id uuid,
  p_credit_note_number text,
  p_credit_note_date date,
  p_subtotal_ex_gst_cents bigint,
  p_gst_cents bigint,
  p_revenue_account_code text DEFAULT '4000',
  p_reason text DEFAULT NULL
)
RETURNS public.customer_credit_notes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice public.invoices%ROWTYPE;
  v_customer_name text;
  v_note public.customer_credit_notes%ROWTYPE;
  v_entry public.journal_entries%ROWTYPE;
  v_number text := upper(btrim(COALESCE(p_credit_note_number, '')));
  v_revenue_code text := COALESCE(NULLIF(btrim(p_revenue_account_code), ''), '4000');
  v_total_cents bigint;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF NOT public.require_role(p_organization_id, 'accountant'::public.org_role) THEN
    RAISE EXCEPTION 'accountant role is required to create customer credit notes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_invoice_id IS NULL THEN
    RAISE EXCEPTION 'invoice_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF v_number = '' THEN
    RAISE EXCEPTION 'credit_note_number is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_credit_note_date IS NULL THEN
    RAISE EXCEPTION 'credit_note_date is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_subtotal_ex_gst_cents IS NULL OR p_gst_cents IS NULL
     OR p_subtotal_ex_gst_cents < 0 OR p_gst_cents < 0 THEN
    RAISE EXCEPTION 'credit note subtotal and GST must be non-negative'
      USING ERRCODE = 'check_violation';
  END IF;

  v_total_cents := p_subtotal_ex_gst_cents + p_gst_cents;
  IF v_total_cents <= 0 THEN
    RAISE EXCEPTION 'credit note total must be positive'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT i, c.name
    INTO v_invoice, v_customer_name
    FROM public.invoices i
    JOIN public.customers c
      ON c.id = i.customer_id
     AND c.organization_id = i.organization_id
   WHERE i.id = p_invoice_id
     AND i.organization_id = p_organization_id
     AND i.deleted_at IS NULL
   FOR UPDATE OF i;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'source invoice % not found for customer credit note %',
      p_invoice_id,
      v_number
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_invoice.status IN ('draft'::public.invoice_status, 'void'::public.invoice_status) THEN
    RAISE EXCEPTION 'customer credit note % cannot post against draft or void invoice %',
      v_number,
      p_invoice_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT *
    INTO v_note
    FROM public.customer_credit_notes
   WHERE organization_id = p_organization_id
     AND credit_note_number = v_number
     AND deleted_at IS NULL
   FOR UPDATE;

  IF FOUND THEN
    IF v_note.invoice_id IS DISTINCT FROM p_invoice_id
       OR v_note.subtotal_ex_gst_cents IS DISTINCT FROM p_subtotal_ex_gst_cents
       OR v_note.gst_cents IS DISTINCT FROM p_gst_cents
       OR v_note.credit_note_date IS DISTINCT FROM p_credit_note_date THEN
      RAISE EXCEPTION 'customer credit note number % already exists with different details',
        v_number
        USING ERRCODE = 'unique_violation';
    END IF;
  ELSE
    INSERT INTO public.customer_credit_notes (
      organization_id,
      credit_note_number,
      invoice_id,
      customer_id,
      customer_name,
      credit_note_date,
      subtotal_ex_gst_cents,
      gst_cents,
      total_inc_gst_cents,
      revenue_account_code,
      reason,
      status,
      created_by
    )
    VALUES (
      p_organization_id,
      v_number,
      p_invoice_id,
      v_invoice.customer_id,
      v_customer_name,
      p_credit_note_date,
      p_subtotal_ex_gst_cents,
      p_gst_cents,
      v_total_cents,
      v_revenue_code,
      NULLIF(btrim(COALESCE(p_reason, '')), ''),
      'draft'::public.credit_note_status,
      auth.uid()
    )
    RETURNING * INTO v_note;
  END IF;

  IF v_note.journal_entry_id IS NULL THEN
    SELECT *
      INTO v_entry
      FROM public.post_customer_credit_note_journal(
        p_organization_id,
        v_number,
        p_credit_note_date,
        p_subtotal_ex_gst_cents,
        p_gst_cents,
        p_invoice_id,
        v_revenue_code,
        p_reason
      );

    UPDATE public.customer_credit_notes
       SET status = 'posted'::public.credit_note_status,
           journal_entry_id = v_entry.id,
           posted_at = now(),
           revenue_account_code = v_revenue_code
     WHERE id = v_note.id
     RETURNING * INTO v_note;
  END IF;

  RETURN v_note;
END;
$$;

COMMENT ON FUNCTION public.create_customer_credit_note(uuid, uuid, text, date, bigint, bigint, text, text) IS
  'Creates a source-linked AR/customer credit note, posts the canonical GL journal '
  'through post_customer_credit_note_journal(), and links journal_entry_id. '
  'SECURITY DEFINER with explicit require_role(org, accountant) guard; direct '
  'table inserts are not granted to authenticated users.';

REVOKE ALL ON FUNCTION public.create_customer_credit_note(
  uuid,
  uuid,
  text,
  date,
  bigint,
  bigint,
  text,
  text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_customer_credit_note(
  uuid,
  uuid,
  text,
  date,
  bigint,
  bigint,
  text,
  text
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_supplier_credit_note(
  p_organization_id uuid,
  p_bill_id uuid,
  p_credit_note_number text,
  p_credit_note_date date,
  p_subtotal_ex_gst_cents bigint,
  p_gst_cents bigint,
  p_counter_account_code text DEFAULT '5000',
  p_counter_account_type public.account_type DEFAULT 'expense'::public.account_type,
  p_reason text DEFAULT NULL
)
RETURNS public.supplier_credit_notes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill public.bills%ROWTYPE;
  v_supplier_name text;
  v_note public.supplier_credit_notes%ROWTYPE;
  v_entry public.journal_entries%ROWTYPE;
  v_number text := upper(btrim(COALESCE(p_credit_note_number, '')));
  v_counter_code text := COALESCE(NULLIF(btrim(p_counter_account_code), ''), '5000');
  v_counter_type public.account_type := COALESCE(
    p_counter_account_type,
    'expense'::public.account_type
  );
  v_total_cents bigint;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF NOT public.require_role(p_organization_id, 'accountant'::public.org_role) THEN
    RAISE EXCEPTION 'accountant role is required to create supplier credit notes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_bill_id IS NULL THEN
    RAISE EXCEPTION 'bill_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF v_number = '' THEN
    RAISE EXCEPTION 'credit_note_number is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_credit_note_date IS NULL THEN
    RAISE EXCEPTION 'credit_note_date is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_subtotal_ex_gst_cents IS NULL OR p_gst_cents IS NULL
     OR p_subtotal_ex_gst_cents < 0 OR p_gst_cents < 0 THEN
    RAISE EXCEPTION 'supplier credit note subtotal and GST must be non-negative'
      USING ERRCODE = 'check_violation';
  END IF;

  v_total_cents := p_subtotal_ex_gst_cents + p_gst_cents;
  IF v_total_cents <= 0 THEN
    RAISE EXCEPTION 'supplier credit note total must be positive'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT b, COALESCE(s.name, b.supplier_name_raw, 'Unknown supplier')
    INTO v_bill, v_supplier_name
    FROM public.bills b
    LEFT JOIN public.suppliers s
      ON s.id = b.supplier_id
     AND s.organization_id = b.organization_id
   WHERE b.id = p_bill_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
   FOR UPDATE OF b;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'source bill % not found for supplier credit note %',
      p_bill_id,
      v_number
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_bill.status = 'void'::public.bill_status THEN
    RAISE EXCEPTION 'supplier credit note % cannot post against void bill %',
      v_number,
      p_bill_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT *
    INTO v_note
    FROM public.supplier_credit_notes
   WHERE organization_id = p_organization_id
     AND credit_note_number = v_number
     AND deleted_at IS NULL
   FOR UPDATE;

  IF FOUND THEN
    IF v_note.bill_id IS DISTINCT FROM p_bill_id
       OR v_note.subtotal_ex_gst_cents IS DISTINCT FROM p_subtotal_ex_gst_cents
       OR v_note.gst_cents IS DISTINCT FROM p_gst_cents
       OR v_note.credit_note_date IS DISTINCT FROM p_credit_note_date THEN
      RAISE EXCEPTION 'supplier credit note number % already exists with different details',
        v_number
        USING ERRCODE = 'unique_violation';
    END IF;
  ELSE
    INSERT INTO public.supplier_credit_notes (
      organization_id,
      credit_note_number,
      bill_id,
      supplier_id,
      supplier_name,
      credit_note_date,
      subtotal_ex_gst_cents,
      gst_cents,
      total_inc_gst_cents,
      counter_account_code,
      counter_account_type,
      reason,
      status,
      created_by
    )
    VALUES (
      p_organization_id,
      v_number,
      p_bill_id,
      v_bill.supplier_id,
      v_supplier_name,
      p_credit_note_date,
      p_subtotal_ex_gst_cents,
      p_gst_cents,
      v_total_cents,
      v_counter_code,
      v_counter_type,
      NULLIF(btrim(COALESCE(p_reason, '')), ''),
      'draft'::public.credit_note_status,
      auth.uid()
    )
    RETURNING * INTO v_note;
  END IF;

  IF v_note.journal_entry_id IS NULL THEN
    SELECT *
      INTO v_entry
      FROM public.post_supplier_credit_note_journal(
        p_organization_id,
        v_number,
        p_credit_note_date,
        p_subtotal_ex_gst_cents,
        p_gst_cents,
        v_counter_code,
        v_counter_type,
        p_bill_id,
        p_reason
      );

    UPDATE public.supplier_credit_notes
       SET status = 'posted'::public.credit_note_status,
           journal_entry_id = v_entry.id,
           posted_at = now(),
           counter_account_code = v_counter_code,
           counter_account_type = v_counter_type
     WHERE id = v_note.id
     RETURNING * INTO v_note;
  END IF;

  RETURN v_note;
END;
$$;

COMMENT ON FUNCTION public.create_supplier_credit_note(uuid, uuid, text, date, bigint, bigint, text, public.account_type, text) IS
  'Creates a source-linked AP/supplier credit note, posts the canonical GL journal '
  'through post_supplier_credit_note_journal(), and links journal_entry_id. '
  'SECURITY DEFINER with explicit require_role(org, accountant) guard; direct '
  'table inserts are not granted to authenticated users.';

REVOKE ALL ON FUNCTION public.create_supplier_credit_note(
  uuid,
  uuid,
  text,
  date,
  bigint,
  bigint,
  text,
  public.account_type,
  text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_supplier_credit_note(
  uuid,
  uuid,
  text,
  date,
  bigint,
  bigint,
  text,
  public.account_type,
  text
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
