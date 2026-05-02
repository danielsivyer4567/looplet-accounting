-- 0030: Customer-side invoicing — AR mirror of bills.
-- Tables: invoices, invoice_line_items, invoice_payments, invoice_number_counters
-- Triggers: auto-number, recompute totals from line items, apply payments
-- View: v_customer_pnl per-customer aggregate
-- invoice_status enum is pre-existing from 0001 (draft, sent, partially_paid, paid, overdue, void).

DO $$ BEGIN
  CREATE TYPE public.invoice_gst_treatment AS ENUM ('inc', 'ex', 'free');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.invoice_number_counters (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  next_number integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  invoice_number text NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  issue_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date NOT NULL,
  terms_days integer NOT NULL DEFAULT 14,
  subtotal_ex_gst_cents bigint NOT NULL DEFAULT 0,
  gst_cents bigint NOT NULL DEFAULT 0,
  total_inc_gst_cents bigint NOT NULL DEFAULT 0,
  amount_paid_cents bigint NOT NULL DEFAULT 0,
  balance_due_cents bigint NOT NULL DEFAULT 0,
  status public.invoice_status NOT NULL DEFAULT 'draft',
  currency_code char(3) NOT NULL DEFAULT 'AUD',
  notes text,
  internal_notes text,
  sent_at timestamptz,
  viewed_at timestamptz,
  paid_at timestamptz,
  public_token uuid NOT NULL DEFAULT gen_random_uuid(),
  xero_status text,
  xero_invoice_id text,
  xero_synced_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  CONSTRAINT invoices_org_number_uniq UNIQUE (organization_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS invoices_org_status_idx ON public.invoices (organization_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS invoices_org_customer_idx ON public.invoices (organization_id, customer_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS invoices_org_job_idx ON public.invoices (organization_id, job_id) WHERE deleted_at IS NULL AND job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoices_due_date_idx ON public.invoices (due_date) WHERE deleted_at IS NULL AND status NOT IN ('paid','void');
CREATE INDEX IF NOT EXISTS invoices_public_token_idx ON public.invoices (public_token) WHERE deleted_at IS NULL;

DO $$ BEGIN
  ALTER TABLE public.bank_transactions
    ADD CONSTRAINT bank_transactions_matched_invoice_fkey
    FOREIGN KEY (matched_invoice_id) REFERENCES public.invoices(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.invoice_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  line_number integer NOT NULL,
  description text NOT NULL,
  quantity numeric(12,3) NOT NULL DEFAULT 1,
  unit_price_cents bigint NOT NULL,
  gst_treatment public.invoice_gst_treatment NOT NULL DEFAULT 'ex',
  line_total_ex_gst_cents bigint NOT NULL,
  line_gst_cents bigint NOT NULL DEFAULT 0,
  line_total_inc_gst_cents bigint NOT NULL,
  account_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT line_items_invoice_line_uniq UNIQUE (invoice_id, line_number)
);
CREATE INDEX IF NOT EXISTS line_items_invoice_idx ON public.invoice_line_items (invoice_id);

CREATE TABLE IF NOT EXISTS public.invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  paid_at timestamptz NOT NULL DEFAULT now(),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  method text,
  reference text,
  bank_transaction_id uuid REFERENCES public.bank_transactions(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS invoice_payments_invoice_idx ON public.invoice_payments (invoice_id);

-- Triggers + RLS policies + v_customer_pnl: see migration body in DB. Same shape as bills RLS using public.get_accessible_org_ids().
