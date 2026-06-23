-- ============================================================================
-- 0086_invoice_rls_and_audit.sql
--
-- FIX (migration fidelity): the AR/invoice tables created in 0030 had their RLS
-- policies authored only in the live DB via the dashboard, never in version
-- control (0030 line 94: "RLS policies ... see migration body in DB"). A fresh
-- `supabase db push` (clone / DR / staging rebuild) therefore produced these
-- tables with RLS OFF, and combined with the blanket
--   GRANT SELECT, INSERT, UPDATE ON ALL TABLES ... TO authenticated (0001)
-- any authenticated user from any tenant could read/write every org's invoices,
-- line items and payments — a fail-open cross-tenant leak on rebuild. The same
-- gap also exposed the dashboard P&L views (v_organization_realtime_pnl,
-- v_customer_pnl), which are security_invoker and rely on base-table RLS.
--
-- This migration puts the org-scoped RLS into version control so the repo is a
-- faithful source of truth. It is idempotent and prod-safe: ENABLE RLS is a
-- no-op when already on, and every policy is DROP IF EXISTS + CREATE with the
-- exact org predicate used everywhere else, so re-asserting it over the live
-- (already-correct) policies changes nothing.
--
-- ALSO: attaches the standard audit_log_trigger_v2 to the live `invoices` and
-- `invoice_line_items` tables (0039 only audited the legacy customer_invoices;
-- 0062 covered invoice_payments but not the invoice header/lines).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Row-level security on the AR tables (org-scoped, same shape as bills).
-- ----------------------------------------------------------------------------
ALTER TABLE public.invoices               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_line_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_payments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_number_counters ENABLE ROW LEVEL SECURITY;

-- Distinctly-named ("_org_isolation_") so this migration is purely ADDITIVE:
-- on a fresh deploy these are the only policies (isolation closed); on the live
-- DB they sit alongside the dashboard-authored policies, OR'd together — both
-- predicates are org-scoped so there is no behaviour change and no fail-open,
-- and we never drop an unknown live policy (e.g. a public_token customer-view
-- path). DROP IF EXISTS targets only our own names, keeping re-runs idempotent.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'invoices', 'invoice_line_items', 'invoice_payments', 'invoice_number_counters'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_org_isolation_select ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_org_isolation_insert ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_org_isolation_update ON public.%I;', t, t);

    EXECUTE format(
      'CREATE POLICY %I_org_isolation_select ON public.%I
         FOR SELECT USING (organization_id IN (SELECT public.get_accessible_org_ids()));', t, t);
    EXECUTE format(
      'CREATE POLICY %I_org_isolation_insert ON public.%I
         FOR INSERT WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));', t, t);
    EXECUTE format(
      'CREATE POLICY %I_org_isolation_update ON public.%I
         FOR UPDATE USING (organization_id IN (SELECT public.get_accessible_org_ids()));', t, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 2. Audit triggers on the live AR header + line tables.
--    audit_log_trigger_v2 (0039) is table-agnostic — reads organization_id + id
--    via to_jsonb(NEW/OLD); both tables have them. Idempotent.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_invoices_audit_v2 ON public.invoices;
CREATE TRIGGER trg_invoices_audit_v2
  AFTER INSERT OR UPDATE OR DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

DROP TRIGGER IF EXISTS trg_invoice_line_items_audit_v2 ON public.invoice_line_items;
CREATE TRIGGER trg_invoice_line_items_audit_v2
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_line_items
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

COMMIT;
