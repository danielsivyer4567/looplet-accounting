-- ============================================================================
-- Migration: 0001_initial_schema
-- Project:   Looplet Accounting v1
-- Author:    Daniel Sivyer
-- Date:      2026-05-01
-- Notes:     Single-file initial migration. Targets a CLEAN Supabase project
--            (the wiped dxoikltymmknxqpkpyhi as of 2026-05-01).
--
--            Multi-tenant from line 1. Org structure copied from Looplet CRM.
--            Money in BIGINT cents, AUD-only v1 (currency_code column included).
--            RLS on every table. Append-only audit log + period lock triggers.
--
--            Apply via: `supabase db push` or
--                        `psql $SUPABASE_DB_URL -f 0001_initial_schema.sql`
-- ============================================================================

BEGIN;

-- ============================================================================
-- A. EXTENSIONS
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;       -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";    -- uuid_generate_v4() (for compat)
CREATE EXTENSION IF NOT EXISTS pg_trgm;        -- text similarity (for OCR matching)

-- ============================================================================
-- B. CUSTOM TYPES
-- ============================================================================

CREATE TYPE organization_type AS ENUM ('standard', 'agency', 'sub_account');
CREATE TYPE membership_role   AS ENUM ('owner', 'admin', 'manager', 'member');
CREATE TYPE invitation_status AS ENUM ('pending', 'accepted', 'expired', 'cancelled');
CREATE TYPE counterparty_type AS ENUM ('customer', 'supplier');
CREATE TYPE intake_source     AS ENUM ('manual_upload', 'gmail', 'contractor_upload', 'staff_order', 'api');
CREATE TYPE bill_status       AS ENUM ('received', 'verified', 'attached', 'paid', 'void');
CREATE TYPE invoice_status    AS ENUM ('draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void');
CREATE TYPE job_status        AS ENUM ('draft', 'active', 'paused', 'completed', 'cancelled');
CREATE TYPE sync_status       AS ENUM ('pending', 'synced', 'failed', 'amended', 'voided');
CREATE TYPE audit_operation   AS ENUM ('INSERT', 'UPDATE', 'DELETE');

-- ============================================================================
-- C. HELPER FUNCTIONS (created here so triggers below can reference them)
-- ============================================================================

-- Updates updated_at column on every UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Blocks UPDATE/DELETE on append-only tables (audit_log, *_sync_log).
CREATE OR REPLACE FUNCTION block_modifications() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% on append-only table % is forbidden', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- D. TENANT INFRASTRUCTURE (copied from CRM pattern)
-- ============================================================================

CREATE TABLE organizations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT NOT NULL,
  abn                      TEXT,
  organization_type        organization_type NOT NULL DEFAULT 'standard',
  parent_organization_id   UUID REFERENCES organizations(id) ON DELETE RESTRICT,
  logo_url                 TEXT,
  settings                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- CRM alignment-prep
  crm_organization_id      UUID,
  -- Standard preamble
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               UUID REFERENCES auth.users(id),
  deleted_at               TIMESTAMPTZ,
  CONSTRAINT chk_sub_account_has_parent
    CHECK ((organization_type = 'sub_account') = (parent_organization_id IS NOT NULL)),
  CONSTRAINT chk_parent_must_be_agency_self_check
    CHECK (parent_organization_id IS DISTINCT FROM id)
);
COMMENT ON TABLE organizations IS 'Tenant container. Hard wall between customers. Agency hierarchy via parent_organization_id.';
CREATE INDEX idx_organizations_type   ON organizations(organization_type);
CREATE INDEX idx_organizations_parent ON organizations(parent_organization_id) WHERE parent_organization_id IS NOT NULL;
CREATE INDEX idx_organizations_crm    ON organizations(crm_organization_id) WHERE crm_organization_id IS NOT NULL;

CREATE TABLE organization_memberships (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role                membership_role NOT NULL DEFAULT 'member',
  is_default          BOOLEAN NOT NULL DEFAULT FALSE,
  -- CRM alignment-prep
  crm_membership_id   UUID,
  joined_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, organization_id)
);
CREATE INDEX idx_memberships_user ON organization_memberships(user_id);
CREATE INDEX idx_memberships_org  ON organization_memberships(organization_id);
CREATE UNIQUE INDEX uq_memberships_default_per_user
  ON organization_memberships(user_id) WHERE is_default = TRUE;

CREATE TABLE team_invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  role            membership_role NOT NULL DEFAULT 'member',
  token           TEXT NOT NULL UNIQUE,
  status          invitation_status NOT NULL DEFAULT 'pending',
  invited_by      UUID NOT NULL REFERENCES auth.users(id),
  expires_at      TIMESTAMPTZ NOT NULL,
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_invitations_org    ON team_invitations(organization_id);
CREATE INDEX idx_invitations_email  ON team_invitations(email);
CREATE INDEX idx_invitations_status ON team_invitations(organization_id, status);

-- ============================================================================
-- E. RLS HELPER FUNCTIONS (depend on tenant tables existing)
-- ============================================================================

-- Returns every organization id the current authenticated user can access.
-- Includes: direct memberships + sub-accounts of any agency they admin.
CREATE OR REPLACE FUNCTION get_accessible_org_ids() RETURNS SETOF UUID AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Direct memberships
  RETURN QUERY
    SELECT m.organization_id
      FROM organization_memberships m
     WHERE m.user_id = v_user_id;

  -- Sub-accounts of agencies the user admins
  RETURN QUERY
    SELECT sa.id
      FROM organizations sa
      JOIN organizations agency
        ON sa.parent_organization_id = agency.id
      JOIN organization_memberships m
        ON m.organization_id = agency.id
     WHERE agency.organization_type = 'agency'
       AND sa.organization_type    = 'sub_account'
       AND m.user_id                = v_user_id
       AND m.role IN ('owner', 'admin');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_agency_user() RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = auth.uid()
      AND o.organization_type = 'agency'
      AND m.role IN ('owner', 'admin')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ============================================================================
-- F. AUDIT INFRASTRUCTURE
-- ============================================================================

CREATE TABLE audit_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL,                  -- not FK to allow logging org deletes
  table_name        TEXT NOT NULL,
  record_id         UUID,
  operation         audit_operation NOT NULL,
  actor_user_id     UUID,
  before_data       JSONB,
  after_data        JSONB,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_id        TEXT,                            -- correlation id from edge fn
  ip_address        INET
);
CREATE INDEX idx_audit_org_time ON audit_log(organization_id, occurred_at DESC);
CREATE INDEX idx_audit_record   ON audit_log(table_name, record_id);
CREATE INDEX idx_audit_actor    ON audit_log(actor_user_id, occurred_at DESC);

-- Append-only enforcement
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION block_modifications();

-- Generic write_audit_log function — applied via trigger on every business table.
CREATE OR REPLACE FUNCTION write_audit_log() RETURNS TRIGGER AS $$
DECLARE
  v_org_id UUID;
  v_record_id UUID;
BEGIN
  -- organization_id can come from NEW (INSERT/UPDATE) or OLD (DELETE)
  v_org_id := COALESCE(
    (CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN (to_jsonb(NEW)->>'organization_id') END)::UUID,
    (CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN (to_jsonb(OLD)->>'organization_id') END)::UUID
  );

  v_record_id := COALESCE(
    (CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN (to_jsonb(NEW)->>'id') END)::UUID,
    (CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN (to_jsonb(OLD)->>'id') END)::UUID
  );

  INSERT INTO audit_log (
    organization_id, table_name, record_id, operation, actor_user_id,
    before_data, after_data
  ) VALUES (
    v_org_id, TG_TABLE_NAME, v_record_id, TG_OP::audit_operation, auth.uid(),
    CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- G. PERIOD LOCKING
-- ============================================================================

CREATE TABLE period_locks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  reason          TEXT NOT NULL,                          -- 'BAS Q1 2026', 'EOFY 2026', etc.
  locked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by       UUID REFERENCES auth.users(id),
  unlocked_at     TIMESTAMPTZ,
  unlocked_by     UUID REFERENCES auth.users(id),
  unlock_reason   TEXT,
  CONSTRAINT chk_period_order CHECK (period_end >= period_start)
);
CREATE INDEX idx_period_locks_org_active
  ON period_locks(organization_id, period_start, period_end)
  WHERE unlocked_at IS NULL;

CREATE OR REPLACE FUNCTION check_period_lock() RETURNS TRIGGER AS $$
DECLARE
  v_record_date DATE;
  v_org_id      UUID;
  v_locked      BOOLEAN;
BEGIN
  v_org_id := (to_jsonb(NEW)->>'organization_id')::UUID;
  -- Try common date column names; tables may have any of these.
  v_record_date := COALESCE(
    (to_jsonb(NEW)->>'invoice_date')::DATE,
    (to_jsonb(NEW)->>'bill_date')::DATE,
    (to_jsonb(NEW)->>'transaction_date')::DATE,
    (to_jsonb(NEW)->>'work_date')::DATE
  );
  IF v_record_date IS NULL OR v_org_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM period_locks
    WHERE organization_id = v_org_id
      AND v_record_date BETWEEN period_start AND period_end
      AND unlocked_at IS NULL
  ) INTO v_locked;

  IF v_locked THEN
    RAISE EXCEPTION 'Cannot modify record dated %: period is locked',
      v_record_date USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- H. DOMAIN TABLES
-- ============================================================================

-- ----- Counterparties (customers + suppliers) -----------------------------

CREATE TABLE customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  abn             TEXT,
  email           TEXT,
  phone           TEXT,
  billing_address JSONB,
  notes           TEXT,
  -- CRM alignment-prep
  crm_contact_id  UUID,
  -- Standard preamble
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES auth.users(id),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX idx_customers_org      ON customers(organization_id);
CREATE INDEX idx_customers_crm      ON customers(crm_contact_id) WHERE crm_contact_id IS NOT NULL;
CREATE INDEX idx_customers_name_trgm ON customers USING GIN (name gin_trgm_ops);

CREATE TABLE suppliers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  abn             TEXT,
  email           TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 30,
  bank_account    JSONB,                          -- BSB + account, encrypted at app layer
  default_account_code TEXT,
  -- CRM alignment-prep
  crm_contact_id  UUID,
  -- Standard preamble
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES auth.users(id),
  deleted_at      TIMESTAMPTZ,
  UNIQUE (organization_id, name),
  UNIQUE (organization_id, abn)
);
CREATE INDEX idx_suppliers_org       ON suppliers(organization_id);
CREATE INDEX idx_suppliers_crm       ON suppliers(crm_contact_id) WHERE crm_contact_id IS NOT NULL;
CREATE INDEX idx_suppliers_name_trgm ON suppliers USING GIN (name gin_trgm_ops);

-- ----- Jobs (the spine) ---------------------------------------------------

CREATE TABLE jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  job_number          TEXT NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  customer_id         UUID REFERENCES customers(id) ON DELETE SET NULL,
  status              job_status NOT NULL DEFAULT 'draft',
  budget_cents        BIGINT NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
  currency_code       CHAR(3) NOT NULL DEFAULT 'AUD',
  start_date          DATE,
  end_date            DATE,
  actual_completed_at TIMESTAMPTZ,
  site_address        JSONB,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- CRM alignment-prep
  crm_project_id      UUID,
  -- Standard preamble
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES auth.users(id),
  deleted_at          TIMESTAMPTZ,
  UNIQUE (organization_id, job_number)
);
CREATE INDEX idx_jobs_org_status ON jobs(organization_id, status);
CREATE INDEX idx_jobs_customer   ON jobs(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_jobs_crm        ON jobs(crm_project_id) WHERE crm_project_id IS NOT NULL;
CREATE INDEX idx_jobs_number_trgm ON jobs USING GIN (job_number gin_trgm_ops);

-- ----- Bills (AP) ---------------------------------------------------------

CREATE TABLE bills (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  supplier_id              UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  job_id                   UUID REFERENCES jobs(id) ON DELETE SET NULL,
  status                   bill_status NOT NULL DEFAULT 'received',
  source                   intake_source NOT NULL,
  -- File evidence
  storage_key              TEXT NOT NULL,                     -- supabase storage path
  original_filename        TEXT NOT NULL,
  mime_type                TEXT NOT NULL,
  file_size_bytes          BIGINT,
  -- Extracted (from OCR or manual entry)
  supplier_name_raw        TEXT,                              -- as printed on the bill
  supplier_abn             TEXT,
  invoice_number           TEXT,
  invoice_date             DATE,
  due_date                 DATE,
  total_inc_gst_cents      BIGINT CHECK (total_inc_gst_cents >= 0),
  gst_cents                BIGINT CHECK (gst_cents >= 0),
  subtotal_ex_gst_cents    BIGINT CHECK (subtotal_ex_gst_cents >= 0),
  currency_code            CHAR(3) NOT NULL DEFAULT 'AUD',
  job_reference_raw        TEXT,                              -- as extracted by OCR before allocation
  notes                    TEXT,
  raw_extracted            JSONB,                              -- full OCR JSON
  ocr_provider             TEXT,
  ocr_confidence           NUMERIC(3,2) CHECK (ocr_confidence BETWEEN 0 AND 1),
  -- Xero state (cached, never authoritative)
  xero_status              sync_status NOT NULL DEFAULT 'pending',
  xero_invoice_id          TEXT,
  xero_synced_at           TIMESTAMPTZ,
  -- Workflow
  attached_at              TIMESTAMPTZ,
  attached_by              UUID REFERENCES auth.users(id),
  paid_at                  TIMESTAMPTZ,
  -- Standard preamble
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               UUID REFERENCES auth.users(id),
  deleted_at               TIMESTAMPTZ,
  UNIQUE (organization_id, supplier_id, invoice_number) -- duplicate detection
);
CREATE INDEX idx_bills_org_status ON bills(organization_id, status);
CREATE INDEX idx_bills_job        ON bills(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_bills_supplier   ON bills(supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX idx_bills_invoice_date ON bills(organization_id, invoice_date);
CREATE INDEX idx_bills_xero_pending ON bills(organization_id) WHERE xero_status = 'pending';

CREATE TABLE bill_line_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  bill_id             UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  line_number         INTEGER NOT NULL,
  description         TEXT NOT NULL,
  quantity            NUMERIC(12,3) NOT NULL DEFAULT 1,
  unit_price_cents    BIGINT NOT NULL DEFAULT 0,
  total_cents         BIGINT NOT NULL DEFAULT 0,
  gst_cents           BIGINT NOT NULL DEFAULT 0,
  account_code        TEXT,
  category            TEXT,                              -- materials | labour | subcontract | equipment | other
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bill_id, line_number)
);
CREATE INDEX idx_bill_lines_bill ON bill_line_items(bill_id);

-- ----- Customer invoices (AR) --------------------------------------------

CREATE TABLE customer_invoices (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id              UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  job_id                   UUID REFERENCES jobs(id) ON DELETE SET NULL,
  invoice_number           TEXT NOT NULL,
  status                   invoice_status NOT NULL DEFAULT 'draft',
  invoice_date             DATE NOT NULL,
  due_date                 DATE,
  total_inc_gst_cents      BIGINT NOT NULL DEFAULT 0 CHECK (total_inc_gst_cents >= 0),
  gst_cents                BIGINT NOT NULL DEFAULT 0,
  subtotal_ex_gst_cents    BIGINT NOT NULL DEFAULT 0,
  amount_paid_cents        BIGINT NOT NULL DEFAULT 0,
  currency_code            CHAR(3) NOT NULL DEFAULT 'AUD',
  notes                    TEXT,
  -- Xero state
  xero_status              sync_status NOT NULL DEFAULT 'pending',
  xero_invoice_id          TEXT,
  xero_synced_at           TIMESTAMPTZ,
  -- Standard preamble
  sent_at                  TIMESTAMPTZ,
  paid_at                  TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               UUID REFERENCES auth.users(id),
  deleted_at               TIMESTAMPTZ,
  UNIQUE (organization_id, invoice_number)
);
CREATE INDEX idx_customer_invoices_org_status ON customer_invoices(organization_id, status);
CREATE INDEX idx_customer_invoices_job        ON customer_invoices(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_customer_invoices_customer   ON customer_invoices(customer_id);

CREATE TABLE customer_invoice_line_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  invoice_id          UUID NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  line_number         INTEGER NOT NULL,
  description         TEXT NOT NULL,
  quantity            NUMERIC(12,3) NOT NULL DEFAULT 1,
  unit_price_cents    BIGINT NOT NULL DEFAULT 0,
  total_cents         BIGINT NOT NULL DEFAULT 0,
  gst_cents           BIGINT NOT NULL DEFAULT 0,
  account_code        TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (invoice_id, line_number)
);
CREATE INDEX idx_customer_invoice_lines_invoice ON customer_invoice_line_items(invoice_id);

-- ----- Employees + wages (loaded hourly rate per ADR 0001) --------------

CREATE TABLE employees (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id             UUID REFERENCES auth.users(id) ON DELETE SET NULL,  -- if they log in
  full_name           TEXT NOT NULL,
  email               TEXT,
  role                TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  -- wage_components keyed by year, see ADR 0001
  wage_components     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- CRM alignment-prep
  crm_user_id         UUID,
  -- Standard preamble
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES auth.users(id),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX idx_employees_org    ON employees(organization_id);
CREATE INDEX idx_employees_active ON employees(organization_id) WHERE is_active = TRUE;

CREATE TABLE wage_entries (
  id                                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                     UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  employee_id                         UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  job_id                              UUID REFERENCES jobs(id) ON DELETE SET NULL,
  work_date                           DATE NOT NULL,
  start_at                            TIMESTAMPTZ NOT NULL,
  end_at                              TIMESTAMPTZ NOT NULL,
  hours                               NUMERIC(6,2) NOT NULL,
  loaded_hourly_rate_at_time_cents    BIGINT NOT NULL CHECK (loaded_hourly_rate_at_time_cents >= 0),
  total_cost_cents                    BIGINT NOT NULL CHECK (total_cost_cents >= 0),
  notes                               TEXT,
  -- Standard preamble
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                          UUID REFERENCES auth.users(id),
  deleted_at                          TIMESTAMPTZ,
  CONSTRAINT chk_time_order CHECK (end_at > start_at)
);
CREATE INDEX idx_wage_entries_org_date     ON wage_entries(organization_id, work_date);
CREATE INDEX idx_wage_entries_employee_date ON wage_entries(employee_id, work_date);
CREATE INDEX idx_wage_entries_job          ON wage_entries(job_id) WHERE job_id IS NOT NULL;

-- ----- Overhead profiles + allocations (per ADR 0002) --------------------

CREATE TABLE overhead_profiles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  effective_from      DATE NOT NULL,
  daily_rate_cents    BIGINT NOT NULL CHECK (daily_rate_cents >= 0),
  components          JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES auth.users(id),
  UNIQUE (organization_id, effective_from)
);
CREATE INDEX idx_overhead_profiles_org_effective
  ON overhead_profiles(organization_id, effective_from DESC);

CREATE TABLE overhead_allocations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id              UUID REFERENCES jobs(id) ON DELETE CASCADE,
  allocation_date     DATE NOT NULL,
  amount_cents        BIGINT NOT NULL CHECK (amount_cents >= 0),
  hours_basis         NUMERIC(6,2),
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- job_id NULL = unallocated bucket (no labour that day)
  UNIQUE (organization_id, job_id, allocation_date)
);
CREATE INDEX idx_overhead_alloc_job_date
  ON overhead_allocations(job_id, allocation_date) WHERE job_id IS NOT NULL;

-- ----- Xero integration --------------------------------------------------

CREATE TABLE xero_integrations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  xero_tenant_id           TEXT NOT NULL,                    -- the linked Xero org
  xero_tenant_name         TEXT NOT NULL,
  access_token_encrypted   TEXT NOT NULL,
  refresh_token_encrypted  TEXT NOT NULL,
  token_expires_at         TIMESTAMPTZ NOT NULL,
  scopes                   TEXT,
  is_enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  last_error               TEXT,
  last_synced_at           TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, xero_tenant_id)
);
CREATE INDEX idx_xero_integrations_enabled
  ON xero_integrations(organization_id) WHERE is_enabled = TRUE;

CREATE TABLE xero_sync_log (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID NOT NULL,
  record_type              TEXT NOT NULL,                    -- 'bill', 'customer_invoice', 'payment', etc.
  record_id                UUID NOT NULL,
  xero_id                  TEXT,
  operation                TEXT NOT NULL,                    -- 'push', 'fetch', 'amend', 'void'
  payload_hash             TEXT,
  request                  JSONB,
  response                 JSONB,
  status                   TEXT NOT NULL,                    -- 'success', 'failed', 'retry'
  error_message            TEXT,
  idempotency_key          UUID NOT NULL,
  occurred_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (idempotency_key)
);
CREATE INDEX idx_xero_sync_log_org_time   ON xero_sync_log(organization_id, occurred_at DESC);
CREATE INDEX idx_xero_sync_log_record     ON xero_sync_log(record_type, record_id);
CREATE TRIGGER xero_sync_log_append_only
  BEFORE UPDATE OR DELETE ON xero_sync_log
  FOR EACH ROW EXECUTE FUNCTION block_modifications();

-- ----- CRM sync (empty until Phase 8) -----------------------------------

CREATE TABLE crm_sync_log (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID,
  event_type               TEXT NOT NULL,
  crm_record_type          TEXT NOT NULL,
  crm_record_id            UUID NOT NULL,
  payload                  JSONB NOT NULL,
  received_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at             TIMESTAMPTZ,
  result                   TEXT,
  idempotency_key          UUID NOT NULL,
  UNIQUE (idempotency_key)
);
CREATE INDEX idx_crm_sync_log_org_time ON crm_sync_log(organization_id, received_at DESC);
CREATE TRIGGER crm_sync_log_append_only
  BEFORE UPDATE OR DELETE ON crm_sync_log
  FOR EACH ROW EXECUTE FUNCTION block_modifications();

-- ----- System defaults (global, not per-tenant) -------------------------

CREATE TABLE system_defaults (
  key             TEXT PRIMARY KEY,
  value           JSONB NOT NULL,
  description     TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_defaults (key, value, description) VALUES
  ('au_super_pct',          '11.5',                                'AU statutory super contribution % FY 2026'),
  ('au_gst_pct',            '10',                                  'AU GST rate'),
  ('default_tax_set_aside_pct', '25',                              'Per ADR 0003: default % of net profit'),
  ('default_payment_terms_days', '30',                             '30-day account default'),
  ('default_annual_leave_hours',   '152',                          '4 weeks × 38hr'),
  ('default_personal_leave_hours', '76',                           '2 weeks × 38hr'),
  ('default_public_holiday_hours', '76',                           '~10 days × 7.6hr'),
  ('default_sick_leave_hours',     '38',                           'industry avg per ADR 0001'),
  ('default_admin_hours',          '96',                           '2hr/wk × 48wk'),
  ('default_contracted_hours',     '1976',                         '38hr × 52wk'),
  ('default_overhead_divisor_days', '22',                          'working days per month');

-- ============================================================================
-- I. APPLY STANDARD TRIGGERS TO EVERY BUSINESS TABLE
-- ============================================================================

-- updated_at + audit on each business table.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'organizations', 'organization_memberships', 'team_invitations',
    'customers', 'suppliers', 'jobs',
    'bills', 'bill_line_items',
    'customer_invoices', 'customer_invoice_line_items',
    'employees', 'wage_entries',
    'overhead_profiles', 'overhead_allocations',
    'xero_integrations'
  ])
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%I_set_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at();', t, t
    );
    EXECUTE format(
      'CREATE TRIGGER trg_%I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION write_audit_log();', t, t
    );
  END LOOP;
END $$;

-- Period lock check on financial tables that have a date column.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['bills', 'customer_invoices', 'wage_entries'])
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%I_period_lock BEFORE INSERT OR UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION check_period_lock();', t, t
    );
  END LOOP;
END $$;

-- ============================================================================
-- J. ROW-LEVEL SECURITY
-- ============================================================================

-- Enable RLS on every business table.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'organizations', 'organization_memberships', 'team_invitations',
    'customers', 'suppliers', 'jobs',
    'bills', 'bill_line_items',
    'customer_invoices', 'customer_invoice_line_items',
    'employees', 'wage_entries',
    'overhead_profiles', 'overhead_allocations',
    'xero_integrations', 'xero_sync_log',
    'crm_sync_log', 'audit_log', 'period_locks'
  ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;

-- Helper: standard tenant policy. Applies to most business tables.
-- Reads: any record in an accessible org.
-- Writes (insert/update): only into accessible orgs.
-- DELETE: forbidden via no policy (soft-delete via deleted_at instead).

CREATE POLICY organizations_select ON organizations
  FOR SELECT USING (id IN (SELECT get_accessible_org_ids()));
CREATE POLICY organizations_insert ON organizations
  FOR INSERT WITH CHECK (TRUE); -- new org creation handled by signup edge fn
CREATE POLICY organizations_update ON organizations
  FOR UPDATE USING (id IN (SELECT get_accessible_org_ids()));

CREATE POLICY memberships_select ON organization_memberships
  FOR SELECT USING (
    user_id = auth.uid()
    OR organization_id IN (SELECT get_accessible_org_ids())
  );
CREATE POLICY memberships_insert ON organization_memberships
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_accessible_org_ids()));
CREATE POLICY memberships_update ON organization_memberships
  FOR UPDATE USING (organization_id IN (SELECT get_accessible_org_ids()));

CREATE POLICY invitations_all ON team_invitations
  FOR ALL USING (organization_id IN (SELECT get_accessible_org_ids()))
  WITH CHECK (organization_id IN (SELECT get_accessible_org_ids()));

-- Apply identical org-scoped SELECT/INSERT/UPDATE policy to remaining tables.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'customers', 'suppliers', 'jobs',
    'bills', 'bill_line_items',
    'customer_invoices', 'customer_invoice_line_items',
    'employees', 'wage_entries',
    'overhead_profiles', 'overhead_allocations',
    'xero_integrations', 'xero_sync_log',
    'audit_log', 'period_locks'
  ])
  LOOP
    EXECUTE format(
      'CREATE POLICY %I_select ON %I
         FOR SELECT USING (organization_id IN (SELECT get_accessible_org_ids()));', t, t
    );
    EXECUTE format(
      'CREATE POLICY %I_insert ON %I
         FOR INSERT WITH CHECK (organization_id IN (SELECT get_accessible_org_ids()));', t, t
    );
    EXECUTE format(
      'CREATE POLICY %I_update ON %I
         FOR UPDATE USING (organization_id IN (SELECT get_accessible_org_ids()));', t, t
    );
  END LOOP;
END $$;

-- crm_sync_log is admin-only for v1 (operator-level, not tenant-level).
-- No tenant policy created; access is via service-role only.

-- ============================================================================
-- K. STORAGE BUCKETS (run via Supabase dashboard or supabase storage CLI;
--    SQL representation below for reference)
-- ============================================================================

-- INSERT INTO storage.buckets (id, name, public) VALUES ('bills', 'bills', false);
-- Storage RLS: object name must start with 'org-{org_id}/' AND that org must
-- be in get_accessible_org_ids(). Authored via Supabase dashboard policies UI
-- (storage RLS uses storage.objects table with name regex, not enforced via
-- this migration file).

-- ============================================================================
-- L. GRANTS (Supabase default roles)
-- ============================================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;        -- RLS still applies
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;

-- ============================================================================
-- END
-- ============================================================================

COMMIT;

-- Acceptance check (run after apply):
--   SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';
--   -- Expect: 17 (18 with system_defaults)
--   SELECT count(*) FROM pg_policies WHERE schemaname = 'public';
--   -- Expect: ~50 (3 policies × 17 tables, minus crm_sync_log which has none)
