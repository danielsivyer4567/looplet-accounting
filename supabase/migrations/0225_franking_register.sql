-- ============================================================================
-- 0225_franking_register.sql  (P2-FRANK)
--
-- Company franking register:
--   * franking_account_entries: credit/debit movements in the franking account
--   * company_dividend_statements: per-member dividend/distribution statements
--   * build_franking_register(org, FY start year) RPC
--   * draft_dividend_statements_from_share_register(...) RPC
--
-- This is a register, statement, and reconciliation builder only. It does not
-- lodge a Franking account tax return or transmit anything to the ATO.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.franking_account_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entry_date date NOT NULL,
  entry_kind text NOT NULL CHECK (
    entry_kind IN (
      'income_tax_payment',
      'franked_distribution',
      'tax_refund',
      'overfranking_tax',
      'other_credit',
      'other_debit'
    )
  ),
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  credit_cents bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  debit_cents bigint NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  source_table text,
  source_id uuid,
  source_reference text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  deleted_at timestamptz,
  CONSTRAINT franking_account_entry_one_sided
    CHECK ((credit_cents > 0 AND debit_cents = 0) OR (debit_cents > 0 AND credit_cents = 0))
);

CREATE INDEX IF NOT EXISTS franking_account_entries_org_date_idx
  ON public.franking_account_entries (organization_id, entry_date, id)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.franking_account_entries IS
  'Company franking account register movements. Credit/debit amounts are money-in-cents '
  'for the franking account itself, not the cash dividend. Draft-only; ATO FATR lodgement '
  'is outside this repo slice.';

CREATE TABLE IF NOT EXISTS public.company_dividend_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  statement_date date NOT NULL,
  dividend_date date NOT NULL,
  fy_start_year integer NOT NULL CHECK (fy_start_year BETWEEN 2000 AND 2100),
  member_name text NOT NULL CHECK (length(btrim(member_name)) > 0),
  share_class text NOT NULL DEFAULT 'ORD',
  shares_held bigint NOT NULL DEFAULT 0 CHECK (shares_held >= 0),
  cash_dividend_cents bigint NOT NULL CHECK (cash_dividend_cents >= 0),
  franking_credit_cents bigint NOT NULL DEFAULT 0 CHECK (franking_credit_cents >= 0),
  franking_percentage_bps integer NOT NULL DEFAULT 0 CHECK (franking_percentage_bps BETWEEN 0 AND 10000),
  company_tax_rate_bps integer NOT NULL DEFAULT 2500 CHECK (company_tax_rate_bps > 0 AND company_tax_rate_bps < 10000),
  statement_status text NOT NULL DEFAULT 'draft' CHECK (statement_status IN ('draft', 'issued', 'void')),
  source_reference text,
  input_hash text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  deleted_at timestamptz,
  CONSTRAINT company_dividend_statement_positive
    CHECK (cash_dividend_cents > 0 OR franking_credit_cents > 0)
);

CREATE INDEX IF NOT EXISTS company_dividend_statements_org_fy_idx
  ON public.company_dividend_statements (organization_id, fy_start_year, dividend_date, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS company_dividend_statements_org_member_idx
  ON public.company_dividend_statements (organization_id, member_name)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.company_dividend_statements IS
  'Per-member company dividend/distribution statement rows. Each row carries the '
  'cash dividend and attached franking credit for one shareholder/member.';

DROP TRIGGER IF EXISTS franking_account_entries_updated_at
  ON public.franking_account_entries;
CREATE TRIGGER franking_account_entries_updated_at
  BEFORE UPDATE ON public.franking_account_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS franking_account_entries_audit
  ON public.franking_account_entries;
CREATE TRIGGER franking_account_entries_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.franking_account_entries
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

DROP TRIGGER IF EXISTS company_dividend_statements_updated_at
  ON public.company_dividend_statements;
CREATE TRIGGER company_dividend_statements_updated_at
  BEFORE UPDATE ON public.company_dividend_statements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS company_dividend_statements_audit
  ON public.company_dividend_statements;
CREATE TRIGGER company_dividend_statements_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.company_dividend_statements
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

ALTER TABLE public.franking_account_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_dividend_statements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS franking_account_entries_select ON public.franking_account_entries;
CREATE POLICY franking_account_entries_select
  ON public.franking_account_entries FOR SELECT
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS franking_account_entries_insert ON public.franking_account_entries;
CREATE POLICY franking_account_entries_insert
  ON public.franking_account_entries FOR INSERT
  TO authenticated
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS franking_account_entries_update ON public.franking_account_entries;
CREATE POLICY franking_account_entries_update
  ON public.franking_account_entries FOR UPDATE
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()))
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS franking_account_entries_delete ON public.franking_account_entries;
CREATE POLICY franking_account_entries_delete
  ON public.franking_account_entries FOR DELETE
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS company_dividend_statements_select ON public.company_dividend_statements;
CREATE POLICY company_dividend_statements_select
  ON public.company_dividend_statements FOR SELECT
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS company_dividend_statements_insert ON public.company_dividend_statements;
CREATE POLICY company_dividend_statements_insert
  ON public.company_dividend_statements FOR INSERT
  TO authenticated
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS company_dividend_statements_update ON public.company_dividend_statements;
CREATE POLICY company_dividend_statements_update
  ON public.company_dividend_statements FOR UPDATE
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()))
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS company_dividend_statements_delete ON public.company_dividend_statements;
CREATE POLICY company_dividend_statements_delete
  ON public.company_dividend_statements FOR DELETE
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

REVOKE ALL ON public.franking_account_entries FROM PUBLIC, anon;
REVOKE ALL ON public.company_dividend_statements FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.franking_account_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_dividend_statements TO authenticated;

CREATE OR REPLACE FUNCTION public.build_franking_register(
  p_org uuid,
  p_fy_start_year integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_period_start date;
  v_period_end date;
  v_profile public.business_profile%ROWTYPE;
  v_entries jsonb := '[]'::jsonb;
  v_statements jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_opening_cents bigint := 0;
  v_credit_cents bigint := 0;
  v_debit_cents bigint := 0;
  v_closing_cents bigint := 0;
  v_statement_cash_cents bigint := 0;
  v_statement_franking_cents bigint := 0;
  v_register_distribution_debit_cents bigint := 0;
  v_statement_vs_register_variance_cents bigint := 0;
  v_gl_dividend_cents bigint := 0;
  v_statement_vs_gl_variance_cents bigint := 0;
  v_benchmark_bps integer := null;
  v_benchmark_variation_count integer := 0;
  v_input_hash text;
BEGIN
  IF p_org IS NULL THEN
    RAISE EXCEPTION 'organization_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_fy_start_year IS NULL OR p_fy_start_year NOT BETWEEN 2000 AND 2100 THEN
    RAISE EXCEPTION 'valid FY start year is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_org NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'not authorized to build franking register for org %', p_org
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_period_start := make_date(p_fy_start_year, 7, 1);
  v_period_end := make_date(p_fy_start_year + 1, 6, 30);

  SELECT *
    INTO v_profile
    FROM public.business_profile
   WHERE organization_id = p_org;

  WITH scoped_entries AS (
    SELECT *
      FROM public.franking_account_entries
     WHERE organization_id = p_org
       AND deleted_at IS NULL
       AND entry_date <= v_period_end
  ),
  entry_totals AS (
    SELECT
      COALESCE(SUM(credit_cents - debit_cents)
        FILTER (WHERE entry_date < v_period_start), 0)::bigint AS opening_cents,
      COALESCE(SUM(credit_cents)
        FILTER (WHERE entry_date BETWEEN v_period_start AND v_period_end), 0)::bigint AS credit_cents,
      COALESCE(SUM(debit_cents)
        FILTER (WHERE entry_date BETWEEN v_period_start AND v_period_end), 0)::bigint AS debit_cents,
      COALESCE(SUM(debit_cents)
        FILTER (
          WHERE entry_date BETWEEN v_period_start AND v_period_end
            AND entry_kind = 'franked_distribution'
        ), 0)::bigint AS distribution_debit_cents
    FROM scoped_entries
  ),
  entry_rows AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', id,
        'entry_date', entry_date,
        'entry_kind', entry_kind,
        'description', description,
        'credit_cents', credit_cents,
        'debit_cents', debit_cents,
        'source_table', source_table,
        'source_id', source_id,
        'source_reference', source_reference
      )
      ORDER BY entry_date, id
    ), '[]'::jsonb) AS rows
    FROM scoped_entries
    WHERE entry_date BETWEEN v_period_start AND v_period_end
  ),
  scoped_statements AS (
    SELECT *
      FROM public.company_dividend_statements
     WHERE organization_id = p_org
       AND deleted_at IS NULL
       AND statement_status <> 'void'
       AND dividend_date BETWEEN v_period_start AND v_period_end
  ),
  statement_rows AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', id,
        'statement_date', statement_date,
        'dividend_date', dividend_date,
        'member_name', member_name,
        'share_class', share_class,
        'shares_held', shares_held,
        'cash_dividend_cents', cash_dividend_cents,
        'franking_credit_cents', franking_credit_cents,
        'franking_percentage_bps', franking_percentage_bps,
        'company_tax_rate_bps', company_tax_rate_bps,
        'statement_status', statement_status,
        'input_hash', input_hash
      )
      ORDER BY dividend_date, member_name, id
    ), '[]'::jsonb) AS rows
    FROM scoped_statements
  ),
  statement_totals AS (
    SELECT
      COALESCE(SUM(cash_dividend_cents), 0)::bigint AS cash_cents,
      COALESCE(SUM(franking_credit_cents), 0)::bigint AS franking_cents,
      COUNT(DISTINCT franking_percentage_bps)::int AS benchmark_variation_count,
      (array_agg(franking_percentage_bps ORDER BY dividend_date, id)
        FILTER (WHERE franking_credit_cents > 0))[1] AS first_benchmark_bps
    FROM scoped_statements
  ),
  gl_dividends AS (
    SELECT COALESCE(SUM(GREATEST(jl.debit_cents - jl.credit_cents, 0)), 0)::bigint AS cash_cents
      FROM public.journal_entries je
      JOIN public.journal_lines jl
        ON jl.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa
        ON coa.id = jl.account_id
     WHERE je.organization_id = p_org
       AND je.status = 'posted'
       AND je.entry_date BETWEEN v_period_start AND v_period_end
       AND coa.account_type = 'equity'::public.account_type
       AND coa.name ~* '\m(dividend|distribution)\M'
  )
  SELECT
    entry_rows.rows,
    statement_rows.rows,
    entry_totals.opening_cents,
    entry_totals.credit_cents,
    entry_totals.debit_cents,
    entry_totals.opening_cents + entry_totals.credit_cents - entry_totals.debit_cents,
    statement_totals.cash_cents,
    statement_totals.franking_cents,
    entry_totals.distribution_debit_cents,
    statement_totals.franking_cents - entry_totals.distribution_debit_cents,
    gl_dividends.cash_cents,
    statement_totals.cash_cents - gl_dividends.cash_cents,
    statement_totals.first_benchmark_bps,
    statement_totals.benchmark_variation_count
    INTO
      v_entries,
      v_statements,
      v_opening_cents,
      v_credit_cents,
      v_debit_cents,
      v_closing_cents,
      v_statement_cash_cents,
      v_statement_franking_cents,
      v_register_distribution_debit_cents,
      v_statement_vs_register_variance_cents,
      v_gl_dividend_cents,
      v_statement_vs_gl_variance_cents,
      v_benchmark_bps,
      v_benchmark_variation_count
  FROM entry_totals, entry_rows, statement_totals, statement_rows, gl_dividends;

  v_input_hash := encode(
    digest(
      jsonb_build_object(
        'organization_id', p_org,
        'fy_start_year', p_fy_start_year,
        'entries', v_entries,
        'statements', v_statements,
        'closing_cents', v_closing_cents
      )::text,
      'sha256'
    ),
    'hex'
  );

  IF v_profile.organization_id IS NULL THEN
    v_warnings := v_warnings || jsonb_build_array(
      'business_profile is missing; confirm entity type before relying on the franking register'
    );
  ELSIF v_profile.entity_type IS DISTINCT FROM 'company' THEN
    v_warnings := v_warnings || jsonb_build_array(
      'business_profile.entity_type is not company; franking applies to company entities'
    );
  END IF;

  IF v_closing_cents < 0 THEN
    v_warnings := v_warnings || jsonb_build_array(
      'franking account closing balance is in deficit; review franking deficit tax exposure'
    );
  END IF;

  IF v_statement_vs_register_variance_cents <> 0 THEN
    v_warnings := v_warnings || jsonb_build_array(
      'dividend statement franking credits do not reconcile to franking account distribution debits'
    );
  END IF;

  IF v_statement_vs_gl_variance_cents <> 0 THEN
    v_warnings := v_warnings || jsonb_build_array(
      'dividend statement cash dividends do not reconcile to posted dividend/distribution equity lines'
    );
  END IF;

  IF v_benchmark_variation_count > 1 THEN
    v_warnings := v_warnings || jsonb_build_array(
      'multiple franking percentages found in the year; review benchmark franking rule compliance'
    );
  END IF;

  RETURN jsonb_build_object(
    'schema_version', 'build_franking_register:v1',
    'organization_id', p_org,
    'fy_start_year', p_fy_start_year,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'summary', jsonb_build_object(
      'opening_balance_cents', v_opening_cents,
      'credit_cents', v_credit_cents,
      'debit_cents', v_debit_cents,
      'closing_balance_cents', v_closing_cents,
      'statement_cash_dividend_cents', v_statement_cash_cents,
      'statement_franking_credit_cents', v_statement_franking_cents,
      'register_distribution_debit_cents', v_register_distribution_debit_cents,
      'statement_vs_register_variance_cents', v_statement_vs_register_variance_cents,
      'gl_dividend_cents', v_gl_dividend_cents,
      'statement_vs_gl_variance_cents', v_statement_vs_gl_variance_cents,
      'benchmark_franking_percentage_bps', v_benchmark_bps,
      'benchmark_variation_count', v_benchmark_variation_count
    ),
    'entries', v_entries,
    'dividend_statements', v_statements,
    'evidence', jsonb_build_object(
      'source_tables', jsonb_build_array(
        'franking_account_entries',
        'company_dividend_statements',
        'share_register',
        'journal_entries',
        'journal_lines',
        'chart_of_accounts',
        'business_profile'
      ),
      'input_hash', v_input_hash,
      'source_version', 'build_franking_register:v1',
      'source_label', 'ATO Franking account tax return and benchmark rule',
      'source_url', 'https://www.ato.gov.au/businesses-and-organisations/corporate-tax-measures-and-assurance/imputation'
    ),
    'warnings', v_warnings,
    'lodgement', jsonb_build_object(
      'enabled', false,
      'reason', 'Franking register and dividend statements are draft/reconciliation artifacts only; FATR lodgement is outside this in-repo finish-line slice'
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.draft_dividend_statements_from_share_register(
  p_org uuid,
  p_dividend_date date,
  p_share_class text,
  p_total_cash_dividend_cents bigint,
  p_franking_percentage_bps integer DEFAULT 10000,
  p_company_tax_rate_bps integer DEFAULT 2500
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_share_class text := COALESCE(NULLIF(btrim(p_share_class), ''), 'ORD');
  v_total_shares bigint := 0;
  v_rows jsonb := '[]'::jsonb;
  v_total_franking bigint := 0;
  v_input_hash text;
BEGIN
  IF p_org IS NULL THEN
    RAISE EXCEPTION 'organization_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_org NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'not authorized to draft dividend statements for org %', p_org
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_dividend_date IS NULL THEN
    RAISE EXCEPTION 'dividend_date is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_total_cash_dividend_cents IS NULL OR p_total_cash_dividend_cents <= 0 THEN
    RAISE EXCEPTION 'total cash dividend must be positive'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_franking_percentage_bps NOT BETWEEN 0 AND 10000 THEN
    RAISE EXCEPTION 'franking percentage must be between 0 and 10000 basis points'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_company_tax_rate_bps <= 0 OR p_company_tax_rate_bps >= 10000 THEN
    RAISE EXCEPTION 'company tax rate must be between 0 and 10000 basis points'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT COALESCE(SUM(number_held), 0)::bigint
    INTO v_total_shares
    FROM public.share_register
   WHERE organization_id = p_org
     AND deleted_at IS NULL
     AND share_class = v_share_class
     AND number_held > 0;

  IF v_total_shares <= 0 THEN
    RAISE EXCEPTION 'no shares found for class %', v_share_class
      USING ERRCODE = 'no_data_found';
  END IF;

  WITH holders AS (
    SELECT
      id,
      member_name,
      share_class,
      number_held,
      SUM(number_held) OVER (ORDER BY member_name, id) AS cumulative_shares
    FROM public.share_register
    WHERE organization_id = p_org
      AND deleted_at IS NULL
      AND share_class = v_share_class
      AND number_held > 0
  ),
  allocations AS (
    SELECT
      id,
      member_name,
      share_class,
      number_held,
      (
        FLOOR(p_total_cash_dividend_cents::numeric * cumulative_shares / v_total_shares)
        - FLOOR(p_total_cash_dividend_cents::numeric * (cumulative_shares - number_held) / v_total_shares)
      )::bigint AS cash_dividend_cents
    FROM holders
  ),
  statement_rows AS (
    SELECT
      id,
      member_name,
      share_class,
      number_held,
      cash_dividend_cents,
      ROUND(
        cash_dividend_cents::numeric
        * p_company_tax_rate_bps
        / (10000 - p_company_tax_rate_bps)
        * p_franking_percentage_bps
        / 10000
      )::bigint AS franking_credit_cents
    FROM allocations
  )
  SELECT
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'share_register_id', id,
        'member_name', member_name,
        'share_class', share_class,
        'shares_held', number_held,
        'cash_dividend_cents', cash_dividend_cents,
        'franking_credit_cents', franking_credit_cents,
        'grossed_up_dividend_cents', cash_dividend_cents + franking_credit_cents,
        'franking_percentage_bps', p_franking_percentage_bps,
        'company_tax_rate_bps', p_company_tax_rate_bps
      )
      ORDER BY member_name, id
    ), '[]'::jsonb),
    COALESCE(SUM(franking_credit_cents), 0)::bigint
    INTO v_rows, v_total_franking
  FROM statement_rows;

  v_input_hash := encode(
    digest(
      jsonb_build_object(
        'organization_id', p_org,
        'dividend_date', p_dividend_date,
        'share_class', v_share_class,
        'total_cash_dividend_cents', p_total_cash_dividend_cents,
        'franking_percentage_bps', p_franking_percentage_bps,
        'company_tax_rate_bps', p_company_tax_rate_bps,
        'rows', v_rows
      )::text,
      'sha256'
    ),
    'hex'
  );

  RETURN jsonb_build_object(
    'schema_version', 'draft_dividend_statements_from_share_register:v1',
    'organization_id', p_org,
    'dividend_date', p_dividend_date,
    'share_class', v_share_class,
    'total_shares', v_total_shares,
    'total_cash_dividend_cents', p_total_cash_dividend_cents,
    'total_franking_credit_cents', v_total_franking,
    'franking_percentage_bps', p_franking_percentage_bps,
    'company_tax_rate_bps', p_company_tax_rate_bps,
    'statements', v_rows,
    'input_hash', v_input_hash,
    'note', 'Draft allocation only. Persist reviewed rows to company_dividend_statements and add matching franking_account_entries distribution debits.'
  );
END;
$$;

COMMENT ON FUNCTION public.build_franking_register(uuid, integer) IS
  'Builds a company franking account register and reconciliation payload for one FY. '
  'Reads franking_account_entries, company_dividend_statements, dividend-like GL '
  'equity lines, and business_profile under SECURITY INVOKER/RLS. Does not lodge.';

COMMENT ON FUNCTION public.draft_dividend_statements_from_share_register(
  uuid,
  date,
  text,
  bigint,
  integer,
  integer
) IS
  'Drafts per-member dividend statement allocations from share_register holdings. '
  'Uses cumulative floor allocation for cents and computes attached franking credits '
  'from cash dividend, company tax rate, and franking percentage. Read-only.';

REVOKE ALL ON FUNCTION public.build_franking_register(uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.build_franking_register(uuid, integer)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.draft_dividend_statements_from_share_register(
  uuid,
  date,
  text,
  bigint,
  integer,
  integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.draft_dividend_statements_from_share_register(
  uuid,
  date,
  text,
  bigint,
  integer,
  integer
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
