-- 0050: SECURITY INVOKER RPC for the /ask Q&A bot.
--
-- The ask-bot edge fn generates SQL via Groq, then sends it here for execution.
-- We do strict validation: SELECT only, no semicolons (single statement),
-- no dangerous keywords, must reference an allowlisted relation. SECURITY
-- INVOKER means RLS evaluates against the user's JWT so they can only see
-- rows in orgs they have membership in.

CREATE OR REPLACE FUNCTION public.ask_bot_query(p_sql text, p_max_rows int DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_clean text;
  v_result jsonb;
BEGIN
  IF p_sql IS NULL OR length(trim(p_sql)) = 0 THEN
    RAISE EXCEPTION 'Empty query';
  END IF;

  v_clean := lower(trim(p_sql));

  -- Must be a single SELECT statement
  IF NOT v_clean LIKE 'select %' AND NOT v_clean LIKE 'with %' THEN
    RAISE EXCEPTION 'Only SELECT or WITH queries allowed';
  END IF;

  -- No multi-statement
  IF position(';' in rtrim(v_clean, ';')) > 0 THEN
    RAISE EXCEPTION 'Multi-statement query not allowed';
  END IF;

  -- No dangerous keywords (word-bounded so column names like created_at don't trigger)
  IF v_clean ~ '\y(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|analyze|reindex|cluster|listen|notify|set|reset|declare|fetch|move|prepare|execute|do)\y' THEN
    RAISE EXCEPTION 'Forbidden keyword detected — only pure SELECT/CTE queries allowed';
  END IF;

  -- Must reference an allowlisted relation
  IF NOT v_clean ~ '\y(v_bas_quarterly|v_organization_realtime_pnl|v_job_pnl|v_job_revenue|v_job_costs|v_unpaid_bills_for_payment_run|v_bill_effective_allocations|v_bank_transaction_effective_allocations|v_subscription_effective_allocations|v_xero_pending_pushes|bills|invoices|invoice_line_items|invoice_payments|jobs|customers|suppliers|subscriptions|bank_transactions|intake_categories|intake_rules|payment_runs|payment_run_items|pay_runs|pay_slips|employees|timesheet_entries|allocation_splits|expense_categories|notifications|organizations)\y' THEN
    RAISE EXCEPTION 'Query must reference at least one allowed relation (bills, invoices, jobs, v_bas_quarterly, etc.)';
  END IF;

  -- Cap rows returned (caller should also include LIMIT, but we wrap in case)
  EXECUTE format(
    'SELECT to_jsonb(array_agg(t)) FROM (SELECT * FROM (%s) sub LIMIT %s) t',
    p_sql,
    LEAST(GREATEST(p_max_rows, 1), 500)
  ) INTO v_result;

  RETURN COALESCE(v_result, '[]'::jsonb);
EXCEPTION
  WHEN OTHERS THEN
    -- Surface PG error to caller for the LLM to retry/correct
    RAISE EXCEPTION 'ask_bot_query: % (sqlstate: %)', SQLERRM, SQLSTATE;
END $$;

GRANT EXECUTE ON FUNCTION public.ask_bot_query(text, int) TO authenticated;
