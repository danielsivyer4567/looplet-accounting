-- 0117_gst_treatment_validation.sql — SC-3.A.02 (Phase 3, GST treatment validation)
--
-- v_gst_treatment_exceptions: per-bill-line GST treatment mismatch detector. For
-- each business bill line it resolves the EXPECTED GST treatment (the account-
-- level expectation on chart_of_accounts wins over the supplier-level one — the
-- account is the more specific signal, both added in 0116) and flags the line
-- when the GST actually claimed contradicts that expectation:
--   * GST claimed (gst_cents > 0) but expected GST-free/input-taxed/export/no-GST
--   * no GST claimed but expected taxable (GST / GST on capital)
-- Lines under a supplier/account with NO expectation set are never flagged
-- (expected_treatment IS NULL → skipped), so this is opt-in and quiet by default.
--
-- SECURITY INVOKER: the view carries no RLS of its own; it runs as the querying
-- user so the underlying bills / bill_line_items / suppliers / chart_of_accounts
-- RLS scopes every row to the caller's org (cf. v_bas_quarterly, 0082).
--
-- Reads the expected_gst_treatment columns added in 0116 (SC-3.A.01). Feeds the
-- BAS prep flow (SC-3.E.01) as a pre-lodge blocker. No write side effects.
--
-- MIGRATION NUMBER: reassigned from the ledger's planned 0108 to 0117 per the
-- drift rule (0108–0115 = legal-RAG epic; 0116 = SC-3.A.01).

create or replace view public.v_gst_treatment_exceptions
  with (security_invoker = true) as
with lines as (
  select
    bli.id                          as bill_line_item_id,
    bli.organization_id,
    bli.bill_id,
    bli.line_number,
    bli.description,
    bli.account_code,
    bli.gst_cents                   as line_gst_cents,
    bli.total_cents                 as line_total_cents,
    (bli.gst_cents > 0)             as line_has_gst,
    b.supplier_id,
    b.invoice_number,
    b.invoice_date,
    s.name                          as supplier_name,
    coalesce(coa.expected_gst_treatment, s.expected_gst_treatment) as expected_treatment,
    case when coa.expected_gst_treatment is not null then 'account' else 'supplier' end as expected_source
  from public.bill_line_items bli
  join public.bills b on b.id = bli.bill_id
  left join public.suppliers s on s.id = b.supplier_id
  left join public.chart_of_accounts coa
    on coa.organization_id = bli.organization_id
   and coa.code = bli.account_code
  where b.deleted_at is null
    and b.is_personal = false
    and b.is_probable_bill = true
)
select
  l.organization_id,
  l.bill_id,
  l.bill_line_item_id,
  l.line_number,
  l.description,
  l.invoice_number,
  l.invoice_date,
  l.supplier_id,
  l.supplier_name,
  l.account_code,
  l.line_gst_cents,
  l.line_total_cents,
  l.line_has_gst,
  l.expected_treatment,
  l.expected_source,
  -- The WHERE below has already narrowed rows to exactly the two mismatch shapes,
  -- so the discriminator is simply whether GST was claimed on the line.
  case when not l.line_has_gst
         then 'no_gst_but_expected_taxable'
       else 'gst_claimed_but_expected_free'
  end as exception_type
from lines l
where l.expected_treatment is not null
  and (
    (l.expected_treatment in ('GST', 'GST_ON_CAPITAL') and not l.line_has_gst)
    or
    (l.expected_treatment in ('GST_FREE', 'INPUT_TAXED', 'EXPORT', 'NO_GST') and l.line_has_gst)
  );

comment on view public.v_gst_treatment_exceptions is
  'Per-bill-line GST treatment mismatches: a line whose claimed GST contradicts '
  'the expected_gst_treatment of its account (preferred) or supplier (0116). '
  'SECURITY INVOKER — underlying-table RLS scopes rows to the caller''s org. '
  'Opt-in: lines with no expectation set are not flagged. Pre-lodge BAS check (SC-3.E.01).';

-- Supabase default privileges grant SELECT on new views to anon + authenticated;
-- revoke anon explicitly (this is internal accounting data, no anon surface) and
-- keep only authenticated — security_invoker then RLS-scopes rows per the caller.
revoke all on public.v_gst_treatment_exceptions from anon;
grant select on public.v_gst_treatment_exceptions to authenticated;
