-- 0119_gst_reconciliation.sql — SC-3.B.02 (Phase 3, GST reconciliation)
--
-- v_gst_reconciliation: per-org check that the GST accrued per the BAS matches
-- the GST sitting in the GL GST control accounts. It compares:
--   * bas_net_gst_owed_cents  = SUM(v_bas_quarterly.net_gst_cents) over all
--                               quarters (GST collected on sales - GST paid on
--                               purchases, derived from invoices/bills).
--   * gl_net_gst_owed_cents   = the net "owed" balance of the designated GST
--                               control accounts (system_accounts, 0118) read
--                               from v_trial_balance.
-- variance_cents = bas - gl; is_reconciled when it is zero.
--
-- SIGN: v_trial_balance.net_cents = debit - credit. The gst_collected account is
-- a LIABILITY (collections are credits → negative net_cents) and gst_paid is an
-- ASSET (credits claimed are debits → positive net_cents). "Net GST owed" =
-- collected - paid = -(net_cents_collected + net_cents_paid), so the GL side
-- negates the summed control-account net_cents.
--
-- SECURITY INVOKER: chains RLS through the (already invoker) v_bas_quarterly and
-- v_trial_balance, and the GL side is additionally org-scoped by the join to
-- system_accounts (org-RLS'd) — so a caller only ever sees their own orgs.
--
-- SCOPE/LIMITATION (v1, recorded): this is an all-time, org-level reconciliation
-- (every quarter's net GST vs the cumulative GL control balance). It holds while
-- GST hasn't been remitted; once a BAS payment clears the control account in the
-- GL, the cumulative GL balance drops below the all-time BAS total. Period-aware
-- reconciliation (date-bounded GL movement per quarter, net of remittances) is a
-- later refinement — v_trial_balance is cumulative, which this slice reuses.
--
-- MIGRATION NUMBER: reassigned from the ledger's planned 0110 to 0119 per the
-- drift rule (0108–0115 = legal-RAG; 0116/0117 = SC-3.A; 0118 = SC-3.B.01).

create or replace view public.v_gst_reconciliation
  with (security_invoker = true) as
with bas as (
  select organization_id,
         sum(net_gst_cents)::bigint as bas_net_gst_owed_cents
  from public.v_bas_quarterly
  group by organization_id
),
gl as (
  -- negate: a credit-balance liability (gst_collected) carries negative net_cents,
  -- so -(sum) restores the positive "owed to the ATO" amount.
  select sa.organization_id,
         (- sum(tb.net_cents))::bigint as gl_net_gst_owed_cents
  from public.system_accounts sa
  join public.v_trial_balance tb on tb.account_id = sa.account_id
  where sa.role in ('gst_collected', 'gst_paid')
    and sa.deleted_at is null
  group by sa.organization_id
),
joined as (
  -- Materialise the COALESCEd sides once (a FULL JOIN can null either) so the
  -- variance and is_reconciled below derive from plain columns, not repeated exprs.
  select
    coalesce(bas.organization_id, gl.organization_id) as organization_id,
    coalesce(bas.bas_net_gst_owed_cents, 0) as bas_net_gst_owed_cents,
    coalesce(gl.gl_net_gst_owed_cents, 0) as gl_net_gst_owed_cents
  from bas
  full join gl on gl.organization_id = bas.organization_id
)
select
  organization_id,
  bas_net_gst_owed_cents,
  gl_net_gst_owed_cents,
  bas_net_gst_owed_cents - gl_net_gst_owed_cents as variance_cents,
  (bas_net_gst_owed_cents - gl_net_gst_owed_cents) = 0 as is_reconciled
from joined;

comment on view public.v_gst_reconciliation is
  'Per-org GST reconciliation: BAS-accrued net GST (v_bas_quarterly, all quarters) '
  'vs the GL GST control-account balance (v_trial_balance filtered to the '
  'system_accounts gst_collected/gst_paid designations, 0118). variance_cents=0 '
  'when reconciled. SECURITY INVOKER. All-time org-level (pre-remittance) — see migration header. Pre-lodge BAS check (SC-3.E.01).';

revoke all on public.v_gst_reconciliation from anon;
grant select on public.v_gst_reconciliation to authenticated;
