# SQL Review — Looplet Accounting (Postgres 15 / Supabase)
**Reviewed:** 2026-05-06  
**Reviewer:** Claude Code (SQL agent)  
**Scope:** supabase/migrations/ — all 11 files (0001–0035)

---

## 1. v_job_pnl (0003)

### Correctness
The headline formula mixes GST-inclusive revenue with GST-inclusive bill costs.
`gross_profit_cents = revenue_inc_gst_cents - total_cost_cents` where
`total_cost_cents` includes `cost_bills_cents` (which itself is `SUM(total_inc_gst_cents)`
from bills). Revenue is the invoiced gross; costs are the billed gross. Both include GST,
so the net roughly cancels, but it is not a clean ex-GST profit figure. The comment says
"revenue - cost = gross_profit" without clarifying the GST treatment. If the intent is a
trading profit this double-inclusion should be documented explicitly; if it is wrong it will
over-state profit by the net GST margin.

The cost sub-selects hit `v_job_costs` four times per job row (bills, wages, overhead,
gst_input_credit). `v_job_costs` itself is a UNION ALL over three separate CTEs. Each
correlated sub-select re-executes that UNION ALL. For an org with 500 jobs this is 2,000
redundant scans of three tables per query execution.

`overhead_allocations` in `v_job_costs` has no `deleted_at` guard. Overhead rows are
recreated by trigger (delete + re-insert), so no soft-delete column exists on that table,
but if one is added later this view will silently pick up deleted rows.

Jobs with `status = 'cancelled'` are included. A cancelled job showing a non-zero
`gross_profit_cents` in the org-level rollup (`v_organization_realtime_pnl`) is misleading.
Consider filtering or adding a `job_status` column so the UI can suppress them.

### Performance
The four correlated sub-selects against `v_job_costs` are the main hazard. Rewrite as a
single lateral join or a CTE that aggregates `v_job_costs` once per job before joining.
Existing indexes: `idx_bills_job (job_id)`, `idx_wage_entries_job (job_id)` — both partial,
adequate. There is no index on `overhead_allocations(job_id)` for non-null rows beyond
`idx_overhead_alloc_job_date`; that index is sufficient.

### Multi-tenancy
Organisation isolation flows through `jobs.organization_id` and the JOINs to `v_job_costs`
which themselves filter on `organization_id`. RLS on `jobs`, `bills`, `wage_entries` is
enabled. The view is `SECURITY INVOKER`, so authenticated users only see rows their RLS
policies permit. Correct.

### Edge cases
- `v_job_revenue` excludes `status = 'draft'` invoices. A draft invoice inflated by mistake
  will not appear in cost, but also not in revenue — correct.
- No division by zero exposure in this view.

---

## 2. v_organization_realtime_pnl (0003)

### Correctness
`tax_set_aside_cents` is computed as a percentage of `gross_profit_cents`. When
`gross_profit_cents` is negative (loss-making org) the set-aside becomes negative, which is
arithmetically consistent but semantically wrong: a negative set-aside implies the tax
reserve is being released, which is not how PAYG instalments work. A `GREATEST(0, ...)`
floor is needed.

`really_yours_cents` = gross_profit - gst_set_aside - tax_set_aside. When gross_profit is
negative AND gst_set_aside is positive (rare but possible if the org collected more GST than
it spent on creditable purchases in a period with no sales revenue matched to jobs),
`really_yours_cents` goes doubly negative. Again a GREATEST floor on tax_set_aside would
help.

The `system_defaults` sub-select for `default_tax_set_aside_pct` is executed twice inside
the same SELECT list — once for `tax_set_aside_cents` and once for `really_yours_cents`.
These should be a single CTE join or LATERAL.

The view aggregates all jobs, including cancelled ones. Cancelled job costs inflate
`total_cost_cents` without corresponding revenue, worsening the distortion.

### Performance
`v_organization_realtime_pnl` JOINs `v_job_pnl` which executes the 4× correlated
sub-select pattern per job. For an org with 500 jobs this cascades to thousands of
sub-queries per call to this view. This view appears to be the main dashboard data source.
At any meaningful data volume (100+ jobs) this will be noticeably slow without
materialization.

### Multi-tenancy
`organizations.deleted_at IS NULL` filter present. LEFT JOIN to `v_job_pnl` which is
RLS-gated. Users see only their own org. Correct.

### Edge cases
- `system_defaults` key `default_tax_set_aside_pct` missing would cause the sub-select to
  return NULL, making `tax_set_aside_cents` NULL and propagating NULL into
  `really_yours_cents`. The seed data inserts it, but there is no NOT NULL constraint on
  `system_defaults.value` for this specific key.

---

## 3. v_customer_pnl (0030)

**The DDL for this view does not exist in the migration files.** Migration 0030 ends at
line 94 with a comment: "Triggers + RLS policies + v_customer_pnl: see migration body in
DB." The view, its associated triggers (`invoices_assign_number`,
`invoices_recompute_totals`, `invoices_apply_payment`), and the RLS policies for the
`invoices`, `invoice_line_items`, and `invoice_payments` tables are absent from source
control. This means:

- The migration as committed is not idempotent or re-runnable.
- A fresh `supabase db push` from scratch will create the tables but leave them without RLS
  policies, without auto-numbering, without total recomputation, and without the customer
  P&L view.
- The `invoices` table has RLS enabled via `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` but
  no policies — this blocks all authenticated inserts and selects by default in Supabase's
  deny-by-default RLS model.

This is a **must-fix** before this migration is applied to any new environment.

---

## 4. v_bas_quarterly + v_cash_flow_weekly (0032)

### Correctness — v_bas_quarterly
The FULL OUTER JOIN between `inv_per_q` and `bills_per_q` joins on
`(organization_id, fy_start_year, quarter_num)`. When only bills exist in a quarter (no
invoices) the columns `i.quarter_start`, `i.quarter_end`, and `i.due_date` will be NULL
because they come only from the invoice side CTE. These are visible in the output. If the
UI depends on `due_date` to render a lodgement deadline, a bills-only quarter will show NULL
instead of the correct ATO due date. The fix is to compute `quarter_start/end/due_date` from
the bill side too, or derive them from `(fy_start_year, quarter_num)` in the outer SELECT.

`inv_per_q` includes all non-void invoices from the new `invoices` table. The older
`customer_invoices` table (created in 0001) is not included. During the transition period
when both tables exist, BAS output will undercount GST collected for invoices still in the
old table.

`bills_per_q` uses a CROSS JOIN LATERAL against `au_bas_quarter(b.invoice_date)`. Because
`b.invoice_date IS NOT NULL` is asserted in the WHERE clause, the CROSS JOIN is safe —
there is no missing-date risk.

The `au_bas_quarter` function hard-codes the Q4 lodgement due date as July 28. ATO standard
is 28 July. Correct. Q2 due date is February 28; this will be wrong in a leap year (the ATO
moves the date to February 28 even in leap years for electronic lodgement, so this is
acceptable in practice, but worth a comment).

### Correctness — v_cash_flow_weekly
`bill_outflows` uses `COALESCE(due_date, invoice_date)` for the week bucket. Bills with
neither date set would be silently excluded by the `COALESCE(...) IS NOT NULL` filter.
That is intentional per the WHERE clause, but if a bill has `invoice_date` set but
`due_date` is NULL, it uses `invoice_date` as the expected outflow date. Payment terms of
30 days are not applied, so the cash-flow forecast is potentially 30 days early for every
bill without an explicit due date.

`invoice_inflows` uses `due_date` as the expected inflow week. If `due_date` is NULL the
row is excluded. The `invoices` table has `due_date NOT NULL`, so this is safe.

`v_cash_flow_weekly` is a raw UNION ALL — no aggregation by organization_id + week_start in
the view itself. The consuming query must GROUP BY to avoid row-per-source output. If the
frontend queries `SELECT * FROM v_cash_flow_weekly` it will get two rows per week (one
invoice, one bill), not a net figure. This should be documented or the view should
aggregate.

### Performance
`au_bas_quarter` is IMMUTABLE and used in a LATERAL cross join. Postgres can fold this into
the plan efficiently. No issues.

`v_cash_flow_weekly` does full table scans of `invoices` and `bills` filtered by
`deleted_at IS NULL` and status. The partial index `invoices_due_date_idx` on
`(due_date) WHERE deleted_at IS NULL AND status NOT IN ('paid','void')` would be used if
the planner sees it; confirm via EXPLAIN ANALYZE in production.

### Multi-tenancy
Both views GROUP BY `organization_id` but do not filter to a single org. They expose
aggregate rows for every org. An authenticated user querying `v_bas_quarterly` will receive
all org rows because the views are SECURITY INVOKER and no RLS policy is declared on them.
RLS on the underlying tables (`invoices`, `bills`) gates which rows feed into the
aggregation, so the GST figures themselves are scoped correctly — but the view returns one
row per org the user can see, including agency sub-accounts. This is likely intentional but
should be verified: a member user of org A who is also an agency admin could see org B's BAS
figures.

---

## 5. v_bank_match_candidates (0029)

Migration 0029 does not exist in the file listing. The comment at the top of 0035 describes
0035 as "mirror of v_bank_match_candidates for AR side", implying `v_bank_match_candidates`
(the AP / bill matching view) was defined in a migration that has been lost or not committed.
The same note applies: this view is referenced as existing but its DDL is not in source
control.

The `bank_transactions` table itself also has no CREATE TABLE migration in source control —
it is referenced by ALTER TABLE in 0030 and 0031, and queried in the edge functions, but
never defined in the committed migrations. A fresh database deployment from these files would
fail at 0030's ALTER TABLE statement.

---

## 6. v_bank_invoice_match_candidates (0035)

### Correctness
The view joins `bank_transactions` to `invoices` on `organization_id` with no explicit CROSS
JOIN — it is an inner/equi join gated by amount and date tolerances in the WHERE clause.
This is safe.

Score formula: base 0.5 + up to 0.5 for date proximity + 0.2 for name match + 0.3 for
invoice number match = maximum 1.5. Scores above 1.0 are possible. The consuming code
should handle this; if it normalises to [0,1] it will truncate high-confidence matches.

`abs(bt.posted_at::date - i.issue_date)` — this compares the bank posting date against the
invoice **issue** date, not the invoice **due** date. A customer who pays on time 30 days
after issue will appear 30 days away even if they paid exactly on the due date. Matching
against `i.due_date` (which has a NOT NULL constraint) would be more accurate.

The WHERE clause already restricts to `abs(amount) <= 50` cents and `days_diff <= 60`,
which means the CASE expression inside score can never produce 0 for rows that reach the
output — the `ELSE 0` branch is dead code. The WHERE and CASE conditions are duplicated;
removing the CASE and computing the score unconditionally would be cleaner.

### Performance
The join between `bank_transactions` and `invoices` is a full nested-loop on
`organization_id`. Without an index on `bank_transactions(organization_id,
matched_invoice_id, amount_cents)` the planner must scan all unmatched positive transactions
per org then probe invoices. At 10k transactions × 1k invoices this is a 10M-row Cartesian
before filtering. An index on `bank_transactions(organization_id, matched_invoice_id,
matched_bill_id, amount_cents) WHERE matched_invoice_id IS NULL AND matched_bill_id IS NULL
AND amount_cents > 0` would allow a tight index scan on the transaction side before the
join. The invoice side is covered by `invoices_org_status_idx`.

The `LIKE '%' || lower(c.name) || '%'` pattern for customer name matching is a leading-
wildcard LIKE — it cannot use btree or trigram indexes as written (the leading `%` prevents
left-anchored matching). At small scale this is acceptable. At scale, consider replacing
with `lower(bt.description) % lower(c.name)` using `pg_trgm` similarity which is
index-accelerated.

### Multi-tenancy
The join is on `i.organization_id = bt.organization_id`. RLS on both tables gates which
rows each user can read. SECURITY INVOKER (default for views). Correct.

### Edge cases
- A bank transaction with `amount_cents = 1` (one cent) that happens to be within 50 cents
  of an invoice with `balance_due_cents = 0` would not appear because the invoice filter
  `i.balance_due_cents > 0` excludes it. Correct.
- Partially-paid invoices where `balance_due_cents` has been correctly decremented will
  match on the remaining balance. Correct.
- An invoice with `status = 'void'` and `balance_due_cents > 0` (an inconsistent state —
  see edge case note) would be excluded by `status NOT IN ('paid','void')`. Even if the data
  is corrupt, the view handles it safely.

---

## 7. v_personal_expenses + v_personal_bank_expenses (0031)

### Correctness
`v_personal_expenses` aggregates all `bills` per org with `deleted_at IS NULL`, splitting on
`is_personal`. It counts both personal and business bills correctly.

`v_personal_bank_expenses` counts only debit transactions (`amount_cents < 0`) where
`is_personal = true`. Credit transactions that are personal (e.g. a personal refund) are not
counted. If the intent is to show total personal outflow, this is correct; if the intent is
net personal cashflow, credits need to be included. The view name "personal_bank_expenses"
implies outflow-only, so this is likely intentional but should be documented.

Neither view filters `bank_transactions` by `deleted_at`. The `bank_transactions` table
presumably has a `deleted_at` column (standard preamble is applied to all business tables in
0001), but the view does not filter it. If bank transactions can be soft-deleted, personal
outflow totals will include deleted rows.

### Performance
`v_personal_expenses` does a full scan of `bills` per org. The partial index
`bills_is_personal_idx ON bills(organization_id, is_personal) WHERE deleted_at IS NULL AND
is_personal = true` covers the personal side but not the business side (where `is_personal
= false`). A query against this view will use the index for personal bills but scan for
business bills. At this scale this is acceptable.

`v_personal_bank_expenses` has a partial index `bank_txns_is_personal_idx ON
bank_transactions(organization_id, is_personal) WHERE is_personal = true`. The WHERE
condition `amount_cents < 0` is not part of the index. The index narrows to personal
transactions, then applies the amount filter as a heap filter. Acceptable.

### Multi-tenancy
Both views GROUP BY `organization_id` without a user-level filter. Same observation as
v_bas_quarterly: RLS on the base tables scopes the underlying rows correctly, but the view
returns a row per org the authenticated user has access to.

---

## 8. v_duplicate_bills + v_low_confidence_bills (0034)

### Correctness — v_duplicate_bills
Groups on `(organization_id, supplier_id, invoice_date, total_inc_gst_cents)` with
`HAVING COUNT(*) > 1`. This correctly identifies bills with identical supplier + date +
amount. However:

- Bills with the same content but different suppliers (e.g. one linked, one not yet linked)
  will not be flagged. The `supplier_id IS NOT NULL` filter means unlinked bills are never
  flagged as duplicates, even if they are. This is conservative but could miss real
  duplicates in the backfill period.
- Bills from the same supplier on the same date for the same amount but genuinely different
  purchases (two deliveries same day, same price) would be incorrectly flagged. The
  `invoice_number` is not included in the grouping key, meaning two bills with different
  invoice numbers for the same amount and date appear as duplicates. Adding `invoice_number`
  to the key (when not NULL) would reduce false positives.

### Correctness — v_low_confidence_bills
The OR conditions inside the outer parentheses have an operator precedence issue:

```sql
AND (
    ocr_confidence IS NOT NULL AND ocr_confidence < 0.6
    OR supplier_name_raw IS NULL
    OR total_inc_gst_cents IS NULL
    ...
  )
```

`AND` binds tighter than `OR` in SQL. So the first condition is effectively:
`(ocr_confidence IS NOT NULL AND ocr_confidence < 0.6) OR supplier_name_raw IS NULL OR ...`

This is the intended logic — bills with high-confidence OCR but missing supplier name should
still appear. The precedence is correct as written, but explicit parentheses around the first
AND pair would make intent clearer.

The condition `total_inc_gst_cents = 0 AND status != 'void'` will flag zero-dollar bills
(legitimate for some credit adjustments). This is a false positive risk; consider
`total_inc_gst_cents = 0 AND status NOT IN ('void', 'paid')` or check against `gst_cents`
too.

The future-date check `invoice_date > CURRENT_DATE + interval '7 days'` uses a non-stable
expression in a view. This is fine for views (re-evaluated at query time), but note that
materialized views would freeze the date. Not an issue here.

### Performance
Both views do full scans of `bills` with `deleted_at IS NULL`. The existing index
`idx_bills_org_status ON bills(organization_id, status)` is helpful if filtering by org
and status simultaneously, but these views do not filter by status (except the `NOT IN
('paid','void')` exclusion in `v_low_confidence_bills`). Adding a partial index on
`(organization_id) WHERE deleted_at IS NULL AND status NOT IN ('paid','void')` would help
`v_low_confidence_bills` if the table grows large.

### Multi-tenancy
Both views GROUP BY or SELECT with `organization_id`. RLS on `bills` scopes results to
accessible orgs. Correct.

---

## 9. Trigger Reviews

### bills_autolink_supplier (0028)
Fires `BEFORE INSERT OR UPDATE OF supplier_name_raw, supplier_abn`. The trigger only
fires on updates that touch those two columns, so a bulk UPDATE that sets `job_id` but not
`supplier_name_raw` will not re-run the lookup. This is correct and efficient.

**Race condition:** when two concurrent bill inserts arrive with the same
`supplier_name_raw` (e.g. batch OCR), both may find `matched_id IS NULL` and both attempt
`INSERT INTO suppliers`. One will succeed; the other will hit the unique constraint
`suppliers_org_normalised_name_uniq`. The INSERT inside the trigger has no ON CONFLICT
clause, so the second call will raise a unique violation and roll back the entire bill
insert. Fix: add `ON CONFLICT (organization_id, normalise_supplier_name(name)) WHERE
deleted_at IS NULL DO NOTHING RETURNING id` and fall back to a SELECT if the insert
returned nothing.

The trigger function is `SECURITY DEFINER`, meaning it runs as the function owner and
bypasses RLS when inserting into `suppliers`. An authenticated user who can insert a bill
with arbitrary `supplier_name_raw` can therefore create a supplier record in their org
without a direct INSERT policy on `suppliers`. This is intentional (auto-create pattern) but
should be noted in the security model.

### invoices_assign_number / invoices_recompute_totals / invoices_apply_payment (0030)
These triggers are referenced in the migration comment but their DDL does not appear in the
committed file. See the finding under v_customer_pnl (section 3). This is a must-fix.

The `invoice_number_counters` table exists with a `next_number` column but without the
trigger that increments it, any application code that relies on auto-numbering will either
error or produce un-numbered invoices.

### timesheet_recompute_cost (0033)
Simple and correct: `total_cost_cents = ROUND(hours * loaded_hourly_rate_cents)`.

Fires on `BEFORE INSERT OR UPDATE OF hours, loaded_hourly_rate_cents`. An update to
`notes` or `approved_at` will not re-trigger — correct.

The trigger does not validate that `loaded_hourly_rate_cents > 0`. A timesheet entry with
`loaded_hourly_rate_cents = 0` will compute `total_cost_cents = 0` without error, silently
zeroing out labour cost for a job. This should be a CHECK constraint or at minimum a
WARNING-level notice.

`hours` has `CHECK (hours > 0 AND hours <= 24)` at the table level. Combined with
`loaded_hourly_rate_cents >= 0` (existing CHECK), the only silent corruption scenario is
zero rate, which should be addressed.

---

## 10. Index Inventory and Gaps

Indexes present (partial and full) across all migrations:

| Table | Index | Type |
|---|---|---|
| organizations | type, parent, crm | btree partial |
| bills | org_status, job, supplier, invoice_date, xero_pending, allocation_queue, suggested_job, org_sha_cache | btree partial |
| bills | name_trgm on suppliers | GIN |
| customer_invoices (0001) | org_status, job, customer | btree |
| invoices (0030) | org_status, org_customer, org_job, due_date, public_token | btree partial |
| wage_entries | org_date, employee_date, job | btree partial |
| timesheet_entries | org_date, employee, job | btree partial |
| bank_transactions | is_personal | btree partial |
| suppliers | org, crm, name_trgm | btree/GIN |

**Missing indexes identified:**

1. `bank_transactions(organization_id, matched_invoice_id, matched_bill_id, amount_cents) WHERE matched_invoice_id IS NULL AND matched_bill_id IS NULL AND amount_cents > 0` — for `v_bank_invoice_match_candidates` join performance (must-fix at scale).
2. `bills(organization_id) WHERE deleted_at IS NULL AND status NOT IN ('paid','void')` — for `v_low_confidence_bills` at large bill volumes.
3. `overhead_allocations(organization_id, allocation_date)` — the existing index is on `(job_id, allocation_date)` which does not help the `recompute_overhead_for_date` DELETE that filters on `(organization_id, allocation_date)`.
4. `invoice_payments(invoice_id)` exists; `invoice_payments(organization_id)` does not — needed if v_customer_pnl aggregates via org.

---

## 11. Prioritised Findings

### MUST FIX NOW (data loss or wrong numbers or broken deployment)

1. **Migration 0030 is incomplete.** `v_customer_pnl`, `invoices_assign_number`,
   `invoices_recompute_totals`, `invoices_apply_payment`, and all RLS policies for
   `invoices`/`invoice_line_items`/`invoice_payments` are missing from source control. A
   fresh `supabase db push` produces an RLS-locked, trigger-less invoice system. Invoice
   numbers will not auto-assign and totals will not recompute from line items.

2. **Migration 0029 missing.** `v_bank_match_candidates` (AP matching) and the
   `bank_transactions` table DDL are not in source control. The schema cannot be
   bootstrapped from migrations alone.

3. **bills_autolink_supplier race condition (0028).** Two concurrent bill inserts with the
   same supplier name will cause one to raise an unhandled unique violation, rolling back
   the bill insert silently. Add `ON CONFLICT DO NOTHING` to the INSERT inside the trigger
   function.

4. **v_bas_quarterly bills-only quarters produce NULL lodgement dates (0032).** If a
   quarter has bills but no invoices, `quarter_start`, `quarter_end`, and `due_date` columns
   are NULL. Any UI that reads the due date to remind the operator to lodge BAS will silently
   display nothing.

5. **v_organization_realtime_pnl: negative tax_set_aside for loss-making orgs (0003).**
   `tax_set_aside_cents` goes negative when `gross_profit_cents < 0`. Wrap in
   `GREATEST(0, ...)`.

### SHOULD FIX SOON (wrong numbers in edge cases or performance at growth)

6. **v_job_pnl: four correlated sub-selects against v_job_costs per job (0003).** Rewrite
   as a single CTE/LATERAL aggregate to avoid O(jobs × 4) UNION ALL scans of three tables.

7. **v_bank_invoice_match_candidates: match uses issue_date, not due_date (0035).** On-time
   payers appear 30+ days late in the scorer. Change to `i.due_date` where populated.

8. **v_bank_invoice_match_candidates: missing index on bank_transactions for match join
   (0035).** At 10k+ transactions this is a sequential scan. Add the partial composite
   index described in section 10.

9. **v_duplicate_bills: invoice_number not in grouping key (0034).** Two legitimate bills
   from the same supplier on the same day at the same price (different invoice numbers) are
   flagged as duplicates. Include `invoice_number` as a tiebreaker when not NULL.

10. **v_cash_flow_weekly: bill outflow date ignores payment terms (0032).** Bills without
    explicit `due_date` use `invoice_date` as the expected outflow week, making the forecast
    up to 30 days early. Apply `invoice_date + payment_terms_days` as the fallback.

11. **timesheet_recompute_cost: zero rate silently zeroes labour cost (0033).** Add a CHECK
    constraint `loaded_hourly_rate_cents > 0` or a trigger-level RAISE WARNING.

### NICE TO HAVE (quality / maintainability)

12. **v_gst_summary_by_quarter (0003) and v_bas_quarterly (0032) co-exist for the same
    purpose.** They use different source tables (`customer_invoices` vs `invoices`) and
    different quarter-label schemes. Consolidate into one view once the invoice table
    migration is complete.

13. **v_organization_realtime_pnl: system_defaults sub-select executed twice (0003).** Pull
    into a LATERAL or CTE to avoid the double lookup.

14. **v_personal_bank_expenses: no deleted_at filter on bank_transactions (0031).** If soft
    deletes are ever used on that table, personal outflow totals will drift.

15. **v_low_confidence_bills: zero-dollar bill condition may produce false positives
    (0034).** Restrict `total_inc_gst_cents = 0` flag to exclude known zero-value statuses
    more precisely.

16. **compute_loaded_hourly_rate: RAISE EXCEPTION on missing wage_components (0003).** This
    will abort the entire wage_entry INSERT transaction. Consider returning NULL or 0 and
    surfacing the validation error at the application layer rather than via a Postgres
    exception, so that bulk imports do not fail atomically on a single missing employee
    record.
