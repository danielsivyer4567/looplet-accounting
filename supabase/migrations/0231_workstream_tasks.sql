-- ============================================================================
-- 0231_workstream_tasks.sql
--
-- Owner-first Today feed: composite type + RPC that derives plain-language
-- tasks from existing data. Each UNION arm maps one data source to the
-- standard workstream_task shape.
--
-- SECURITY INVOKER — RLS on each underlying table/view scopes the caller.
-- ============================================================================

-- -- Composite type -----------------------------------------------------------

CREATE TYPE public.workstream_task AS (
  id                uuid,
  organization_id   uuid,
  task_kind         text,
  owner_label       text,
  why_now           text,
  source_refs       jsonb,
  suggested_action  text,
  confidence        text,
  impact_cents      bigint,
  due_at            timestamptz,
  blocking_reason   text,
  completion_event  jsonb,
  urgency           integer,
  created_at        timestamptz
);

COMMENT ON TYPE public.workstream_task IS
  'Single row in the owner-facing Today feed. Each row is derived from an '
  'existing data source (bill, tax obligation, bank item, etc.) and rendered '
  'as a plain-language task. Never written directly — always derived.';

-- -- RPC: get_workstream_tasks -------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_workstream_tasks(p_org_id uuid)
RETURNS SETOF public.workstream_task
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = 'pg_catalog', 'public'
AS $$
  -- 1. Onboarding triage — staged senders needing approval
  SELECT
    gen_random_uuid(),
    se.organization_id,
    'onboarding_triage',
    CASE count(*)::int
      WHEN 1 THEN 'Review 1 staged sender'
      ELSE 'Review ' || count(*)::text || ' staged senders'
    END,
    'Staged senders need approval before emails auto-route',
    jsonb_build_array(jsonb_build_object(
      'table', 'staged_entities',
      'count', count(*),
      'url', '/onboarding/triage'
    )),
    'Review and approve or dismiss staged senders',
    'quick_confirm',
    NULL::bigint,
    NULL::timestamptz,
    'Blocks email auto-routing',
    jsonb_build_object(
      'table', 'staged_entities',
      'status_in', jsonb_build_array('pending', 'needs_review'),
      'target_count', 0
    ),
    1,
    now()
  FROM public.staged_entities se
  WHERE se.organization_id = p_org_id
    AND se.status IN ('pending', 'needs_review')
  HAVING count(*) > 0

  UNION ALL

  -- 2. Tax obligations — overdue or due soon
  SELECT
    gen_random_uuid(),
    tc.organization_id,
    'tax_obligation',
    tc.title || ' — ' || tc.period_label,
    CASE
      WHEN tc.days_until_due < 0 THEN abs(tc.days_until_due)::text || ' days OVERDUE'
      WHEN tc.days_until_due = 0 THEN 'Due today'
      ELSE 'Due in ' || tc.days_until_due::text || ' days'
    END,
    jsonb_build_array(jsonb_build_object(
      'table', 'v_tax_calendar',
      'obligation_key', tc.obligation_key,
      'url', '/tax'
    )),
    'Prepare and lodge ' || tc.title,
    CASE WHEN tc.days_until_due < 0 THEN 'advisor_required' ELSE 'quick_confirm' END,
    NULL::bigint,
    tc.due_date::timestamptz AT TIME ZONE 'Australia/Sydney',
    NULL,
    jsonb_build_object(
      'table', 'obligation_status',
      'obligation_key', tc.obligation_key,
      'period_label', tc.period_label,
      'status', 'lodged'
    ),
    2,
    now()
  FROM public.v_tax_calendar tc
  WHERE tc.organization_id = p_org_id
    AND tc.stage IN ('overdue', 'due_soon')
    AND (tc.status IS NULL OR tc.status NOT IN ('done', 'lodged', 'accepted', 'paid'))

  UNION ALL

  -- 3. BAS blockers — books health below threshold
  SELECT
    gen_random_uuid(),
    bh.organization_id,
    'bas_blocker',
    'Books need attention',
    'Books score is ' || bh.score::text || '/100 — below the 80 threshold needed for tax engines',
    jsonb_build_array(jsonb_build_object(
      'table', 'v_books_health',
      'score', bh.score,
      'uncoded', bh.uncoded_count,
      'unreconciled', bh.unreconciled_count,
      'coverage_pct', bh.coverage_pct
    )),
    'Review uncoded transactions and reconcile bank items',
    'blocked_external',
    NULL::bigint,
    NULL::timestamptz,
    'Blocks BAS preparation and period close',
    jsonb_build_object(
      'table', 'v_books_health',
      'blocking', false,
      'target_score', 80
    ),
    3,
    now()
  FROM public.v_books_health bh
  WHERE bh.organization_id = p_org_id AND bh.blocking

  UNION ALL

  -- 4. Unapproved bills — received and waiting
  SELECT
    gen_random_uuid(),
    b.organization_id,
    'unapproved_bill',
    count(*)::text || ' bills need approval',
    count(*)::text || ' received bills have not been approved yet',
    jsonb_build_array(jsonb_build_object(
      'table', 'bills',
      'count', count(*),
      'total_cents', coalesce(sum(b.total_inc_gst_cents), 0),
      'url', '/bills'
    )),
    'Review and approve bills',
    'quick_confirm',
    coalesce(sum(b.total_inc_gst_cents), 0),
    NULL::timestamptz,
    NULL,
    jsonb_build_object('table', 'bills', 'status', 'verified'),
    4,
    now()
  FROM public.bills b
  WHERE b.organization_id = p_org_id
    AND b.status = 'received'
    AND b.deleted_at IS NULL
  HAVING count(*) > 0

  UNION ALL

  -- 5. Overdue invoices
  SELECT
    gen_random_uuid(),
    ci.organization_id,
    'overdue_invoice',
    count(*)::text || ' overdue invoices',
    'Invoices totalling $' || (coalesce(sum(ci.total_inc_gst_cents - ci.amount_paid_cents), 0) / 100)::text || ' are past due',
    jsonb_build_array(jsonb_build_object(
      'table', 'customer_invoices',
      'count', count(*),
      'outstanding_cents', coalesce(sum(ci.total_inc_gst_cents - ci.amount_paid_cents), 0),
      'url', '/invoices'
    )),
    'Follow up on overdue invoices',
    'quick_confirm',
    coalesce(sum(ci.total_inc_gst_cents - ci.amount_paid_cents), 0),
    NULL::timestamptz,
    NULL,
    jsonb_build_object('table', 'customer_invoices', 'status', 'paid'),
    5,
    now()
  FROM public.customer_invoices ci
  WHERE ci.organization_id = p_org_id
    AND ci.status IN ('sent', 'overdue')
    AND ci.due_date < CURRENT_DATE
    AND ci.deleted_at IS NULL
  HAVING count(*) > 0

  UNION ALL

  -- 6. Unmatched bank items
  SELECT
    gen_random_uuid(),
    bt.organization_id,
    'unmatched_bank_item',
    count(*)::text || ' unmatched bank transactions',
    count(*)::text || ' bank items have no matching bill or invoice',
    jsonb_build_array(jsonb_build_object(
      'table', 'bank_transactions',
      'count', count(*),
      'url', '/reconciliation'
    )),
    'Match bank transactions to bills or invoices',
    'review_needed',
    coalesce(sum(abs(bt.amount_cents)), 0),
    NULL::timestamptz,
    CASE WHEN count(*) > 5 THEN 'Large number of unmatched items may indicate missing records' END,
    jsonb_build_object('table', 'bank_transactions', 'matched_bill_id', 'is not null', 'matched_invoice_id', 'is not null'),
    6,
    now()
  FROM public.bank_transactions bt
  WHERE bt.organization_id = p_org_id
    AND bt.matched_bill_id IS NULL
    AND bt.matched_invoice_id IS NULL
  HAVING count(*) > 0

  UNION ALL

  -- 7. Missing documents — data completeness findings
  SELECT
    gen_random_uuid(),
    dcf.organization_id,
    'missing_document',
    dcf.title,
    coalesce(dcf.description, 'Missing required document or information'),
    jsonb_build_array(jsonb_build_object(
      'table', 'data_completeness_findings',
      'id', dcf.id,
      'url', dcf.fix_url
    )),
    coalesce(dcf.fix_action, 'Resolve this finding'),
    CASE dcf.severity
      WHEN 'critical' THEN 'advisor_required'
      ELSE 'review_needed'
    END,
    NULL::bigint,
    NULL::timestamptz,
    CASE WHEN dcf.severity IN ('critical', 'warning') THEN 'Required for compliance' END,
    jsonb_build_object('table', 'data_completeness_findings', 'id', dcf.id, 'resolved', true),
    7,
    dcf.created_at
  FROM public.data_completeness_findings dcf
  WHERE dcf.organization_id = p_org_id
    AND dcf.resolved_at IS NULL
    AND dcf.is_muted = false
    AND dcf.deleted_at IS NULL

  UNION ALL

  -- 8. Pending approvals
  SELECT
    gen_random_uuid(),
    a.organization_id,
    'pending_approval',
    a.resource_type || ' needs approval',
    'A ' || a.resource_type || ' requires approval before it can proceed',
    jsonb_build_array(jsonb_build_object(
      'table', 'approvals',
      'id', a.id,
      'resource_type', a.resource_type,
      'resource_id', a.resource_id,
      'url', '/approvals'
    )),
    'Review and approve or reject the ' || a.resource_type,
    'advisor_required',
    NULL::bigint,
    NULL::timestamptz,
    'Blocks the ' || a.resource_type || ' from proceeding',
    jsonb_build_object('table', 'approvals', 'id', a.id, 'status', 'approved'),
    8,
    a.requested_at
  FROM public.approvals a
  WHERE a.organization_id = p_org_id
    AND a.status = 'pending'
    AND a.deleted_at IS NULL

  ORDER BY urgency, created_at;
$$;

COMMENT ON FUNCTION public.get_workstream_tasks IS
  'Returns derived Today-feed tasks for the given org by unioning queries over '
  'staged_entities, v_tax_calendar, v_books_health, bills, customer_invoices, '
  'bank_transactions, data_completeness_findings, and approvals. Ordered by '
  'urgency then recency. SECURITY INVOKER — each sub-query respects RLS.';

-- -- Grants --------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION public.get_workstream_tasks TO authenticated;

-- Revoke from anon/public for safety.
REVOKE ALL ON FUNCTION public.get_workstream_tasks FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_workstream_tasks FROM anon;
