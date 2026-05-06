# Code Review — Looplet Accounting — 2026-05-06

Scope: commits `c3d0ab4` → `9e80fe7` (migrations 0028–0035, subscriptions-detect,
bank-statement-extract, MoveToOrgButton rollout, Reconciliation invoice side,
Customers/Jobs create modals).

---

## 1. Critical Issues (must fix before next sprint)

### 1.1 — Migration 0030 is half-baked in the file tree

`supabase/migrations/0030_invoices.sql` ends on line 94 with the comment:

> `-- Triggers + RLS policies + v_customer_pnl: see migration body in DB.`

The triggers `invoices_apply_payment` and `invoices_recompute_totals`, the RLS
policies for `invoices`, `invoice_line_items`, and `invoice_payments`, and the
`v_customer_pnl` view are all referenced by the app but **not present in the
checked-in file**. This means:

- A fresh `supabase db push` or a new developer running `supabase db reset` will
  produce a schema where those three tables exist but have **zero RLS policies**
  and **no triggers**. Data will be readable across orgs and invoice totals will
  never reconcile.
- The tenant-isolation test suite is entirely skipped (`describe.skip`), so CI
  will not catch this.

Fix: pull the full DDL from the live DB (`pg_dump --schema-only`) and replace
the stub comment with the real SQL.

### 1.2 — subscriptions-detect accepts any JWT but queries as service-role without checking org membership

`supabase/functions/subscriptions-detect/index.ts` (lines 52–64):

```ts
const authHeader = req.headers.get('Authorization');
if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);
// ...
const admin = createClient(supabaseUrl, serviceKey, ...);
const body = (await req.json()) as RequestBody;
// admin client then queries bank_transactions + subscriptions with body.organization_id
```

The function checks that an `Authorization` header exists, but never calls
`auth.getUser()` and never verifies that the JWT's owner is a member of
`body.organization_id`. Any logged-in user can POST `{ organization_id: "<any uuid>" }`
and the service-role client will happily read 18 months of bank transactions for
that org and write subscription rows into it.

Compare with `bank-sync/index.ts` (lines 62–73) which does the right thing: it
makes a user-JWT client, queries `organizations` through RLS, and 403s if the
org is not accessible.

Apply the same pattern to `subscriptions-detect`.

### 1.3 — bank-sync-all is truly unauthenticated

`bank-sync-all` is deployed `--no-verify-jwt` and performs no token check at
all (lines 29–49). The comment says "the actual work is idempotent" but that is
not a security argument. Anyone who discovers the function URL can trigger a
full Basiq sync for every org simultaneously, creating a thundering-herd toward
the Basiq rate limit and exposing all `organization_id` values in the response
JSON (`{ orgs: N, results: [{org: "uuid", ...}] }`).

Add a hard check: compare the incoming bearer token to the service-role key. If
it does not match, return 401. This is already the documented intent ("The
handler does its own service-role check") but the code never actually does it.

### 1.4 — Reconciliation matchToBill / undoMatch are non-atomic

`src/pages/Reconciliation.tsx` `matchToBill()` (lines 129–146) does two
sequential `supabase` calls — one to update `bank_transactions`, one to update
`bills`. There is no Supabase RPC wrapping them in a transaction. If the user's
connection drops between the two calls, the bank transaction is marked matched
but the bill stays `attached`. The `undoMatch()` function (lines 177–198) has
the same problem in reverse: the bank-txn is cleared first, then the
`invoice_payments` delete. A partial failure leaves an orphaned payment row that
keeps the invoice in `paid` state with no matching bank record.

This is straightforward to fix: move `matchToBill`, `matchToInvoice`, and
`undoMatch` into Postgres functions and call them via `supabase.rpc()`.

---

## 2. RLS / Auth Concerns

### 2.1 — invoices/invoice_line_items/invoice_payments have no confirmed RLS

As noted in 1.1, the RLS policies for the three new invoicing tables are
applied manually in the live DB but are not in the migration file. Until the
migration is reconciled, it is unknown whether the policies match the pattern
used everywhere else (`organization_id IN (SELECT get_accessible_org_ids())`).

### 2.2 — v_bank_match_candidates and v_bank_invoice_match_candidates (0035) are SECURITY INVOKER views but have no org filter enforcement in the view itself

Both views filter on `organization_id` columns, which is correct. Because they
are `SECURITY INVOKER` (the Postgres default) the caller's RLS on
`bank_transactions`, `bills`, and `invoices` does apply. However, the frontend
also passes `.eq('organization_id', currentOrg.id)` as an extra filter, meaning
if a future dev removes that client-side filter the view itself is still safe.
Low risk as-is, but document this dependency explicitly.

### 2.3 — bank-webhook token verification is conditional

`bank-webhook/index.ts` (lines 37–43):

```ts
const expectedToken = Deno.env.get('BASIQ_WEBHOOK_VERIFY_TOKEN');
if (expectedToken) { ... }
```

If `BASIQ_WEBHOOK_VERIFY_TOKEN` is not set in the environment, the check is
silently skipped and the endpoint accepts unauthenticated POST from anyone.
Make the check unconditional and return 500 if the env var is missing.

### 2.4 — MoveToOrgButton trusts client-side org list for authorization

`src/components/MoveToOrgButton.tsx` builds the target org list from
`useOrg().organizations`, which is populated client-side. The actual update
`supabase.from(table).update({ organization_id: targetOrgId })` relies entirely
on RLS to enforce that the user may write into `targetOrgId`. The RLS policy
uses `get_accessible_org_ids()` which checks `organization_memberships`, so the
server-side check is correct. The client-side pre-filter is UX only and cannot
be bypassed to reach an org the RLS would block. This is fine but should be
documented so it is not accidentally "fixed" by removing the RLS policy.

---

## 3. Type Safety

### 3.1 — database.types.ts is an all-any stub

`src/lib/database.types.ts` explicitly stubs every table, view, function, and
enum as `any`. The comment says to run `npm run supabase:types` to generate real
types, but this has never been done. Every query in the codebase that hits
Supabase therefore returns `any` at the Typescript layer. The `as any[]` casts
in `useJobs.ts` (lines 59, 61) and the `as any` in `bank-sync-all/index.ts`
(line 49) are downstream symptoms of this. Until types are generated, the
compiler will not catch a renamed column, a missing field, or a wrong cent
computation.

Priority: run `npx supabase gen types typescript --project-id dxoikltymmknxqpkpyhi`
and commit the output. This is a one-command fix with a large safety dividend.

### 3.2 — CashFlow.tsx casts view rows to any for running balance

`src/pages/reports/CashFlow.tsx` (line 106) casts the row to `any` to access
`.running`, which is a client-computed field added after the Supabase response.
This is tolerable but suggests the result type should be a local interface, not
an inline `as any`.

### 3.3 — bank-sync-all: `r.organization_id` cast via `as any`

Line 49: `(rows ?? []).map((r: any) => r.organization_id)`. With real types this
would be typed automatically.

---

## 4. Trigger Correctness

### 4.1 — bills_autolink_supplier: race condition on concurrent inserts

`0028_suppliers_backfill_and_autocreate.sql` (lines 71–98). The trigger does:

1. SELECT the supplier by normalised name.
2. If not found, INSERT a new supplier.
3. Set `NEW.supplier_id`.

Between steps 1 and 2, a concurrent bill insert for the same org + supplier
name will also find NULL and attempt its own INSERT. One of them will fail on
the `suppliers_org_normalised_name_uniq` unique index. The trigger has no
exception handler for this case, so the bill insert itself will fail with an
unhandled unique-violation. Add:

```sql
BEGIN
  INSERT INTO public.suppliers ...
  RETURNING id INTO matched_id;
EXCEPTION WHEN unique_violation THEN
  SELECT id INTO matched_id FROM public.suppliers
  WHERE organization_id = NEW.organization_id
    AND public.normalise_supplier_name(name) = public.normalise_supplier_name(clean_name)
    AND deleted_at IS NULL;
END;
```

### 4.2 — bills_autolink_supplier: trigger fires on UPDATE OF supplier_name_raw but does not re-fire if name has not changed

The trigger column list is `BEFORE INSERT OR UPDATE OF supplier_name_raw,
supplier_abn`. If a user corrects `supplier_name_raw` to a variant that already
has a supplier in the org, the match will succeed. But if a user updates any
other column (e.g., `status`), the trigger does not run, so a bill that already
has `supplier_name_raw` set but `supplier_id = NULL` (e.g., a bill that existed
before 0028, that the backfill missed) will remain un-linked until the name
column itself is touched. The backfill DO block handles historical data, but any
new bill manually inserted without a supplier_id and without touching
`supplier_name_raw` afterwards will stay unlinked.

### 4.3 — timesheet_recompute_cost: no guard against loaded_hourly_rate_cents = 0

`0033_timesheet_entries.sql` (lines 39–44): `total_cost_cents = ROUND(hours *
loaded_hourly_rate_cents)`. The column defaults to 0. If an operator creates a
timesheet entry without calling `compute_loaded_hourly_rate()` first (which
requires wage_components to be populated), the cost silently stays zero and
`v_job_pnl.cost_wages_cents` underreports. The trigger should raise a WARNING
or the column constraint should require `loaded_hourly_rate_cents > 0`.

### 4.4 — invoices_apply_payment and invoices_recompute_totals triggers are absent from the migration file

Addressed under 1.1. Specifically: `invoices_recompute_totals` is the trigger
that recalculates `subtotal_ex_gst_cents`, `gst_cents`, `total_inc_gst_cents`,
and `balance_due_cents` from `invoice_line_items`. If a user edits a line item
after a partial payment has already been recorded, the trigger must recalculate
`balance_due_cents = total_inc_gst_cents - amount_paid_cents` and not allow
`balance_due_cents` to go negative. Whether it does this correctly is
unverifiable because the trigger body is not in version control.

---

## 5. View Performance

### 5.1 — v_job_pnl: five correlated subqueries per job row

`0003_financial_views.sql` (lines 180–193): `v_job_pnl` contains five
`(SELECT SUM(...) FROM v_job_costs c WHERE c.job_id = j.id ...)` correlated
subqueries. Each of these re-scans `v_job_costs` (itself a UNION ALL of three
base tables) per job. For an org with 200 jobs this is ~1000 sub-scans.

Rewrite as a single lateral join that groups `v_job_costs` by `job_id` once:

```sql
LEFT JOIN LATERAL (
  SELECT
    COALESCE(SUM(total_cents) FILTER (WHERE category='bills'),    0) AS cost_bills_cents,
    COALESCE(SUM(total_cents) FILTER (WHERE category='wages'),    0) AS cost_wages_cents,
    COALESCE(SUM(total_cents) FILTER (WHERE category='overhead'), 0) AS cost_overhead_cents,
    COALESCE(SUM(gst_cents),  0) AS gst_input_credit_cents,
    COALESCE(SUM(total_cents),0) AS total_cost_cents
  FROM v_job_costs c WHERE c.job_id = j.id
) costs ON true
```

`v_organization_realtime_pnl` wraps `v_job_pnl` so the problem multiplies there.

### 5.2 — v_bas_quarterly: CROSS JOIN LATERAL on full table scans

`0032_bas_and_cash_flow_views.sql` (lines 38, 47): both CTEs do a `CROSS JOIN
LATERAL` with `au_bas_quarter()`. The function is `IMMUTABLE` so Postgres can
evaluate it once per row. This is correct but still scans every non-void invoice
and every non-personal, non-null-date bill to classify each into a quarter.
There is no partial index on `(organization_id, issue_date)` narrowed to
`status NOT IN ('void')` on the invoices table. With Supabase RLS applying per
query, adding a supporting index is valuable:

```sql
CREATE INDEX invoices_org_issue_date_active_idx
  ON public.invoices (organization_id, issue_date)
  WHERE deleted_at IS NULL AND status <> 'void';
```

### 5.3 — v_bank_invoice_match_candidates: leading LIKE with variable prefix

`0035_v_bank_invoice_match_candidates.sql` (lines 27, 30): `lower(bt.description)
LIKE '%' || lower(c.name) || '%'`. A leading `%` prevents index use on
`bt.description`. Because this CASE expression is inside the score calculation
(not a WHERE filter), it is evaluated for every row in the join result, not for
filtering. For an org with thousands of transactions and dozens of outstanding
invoices this could become slow. The result set is already constrained to
`abs(bt.amount_cents - i.balance_due_cents) <= 50 AND abs(... days) <= 60` which
limits the join size meaningfully. Tolerable now but worth monitoring; pg_trgm
`similarity()` would be more index-friendly if this becomes a bottleneck.

### 5.4 — v_gst_summary_by_quarter (0003): groups by invoice_date, not by quarter

`0003_financial_views.sql` (lines 215–253): `GROUP BY organization_id, invoice_date`
inside the CTE means the CASE expressions are evaluated per row, which is
correct, but the intermediate CTE produces one row per distinct date before the
outer GROUP BY collapses to per-quarter. This is a pre-aggregation miss — it
should GROUP BY `(organization_id, bas_quarter_key)` inside the CTE. Low impact
at current data volumes but wasteful.

---

## 6. Error Handling

### 6.1 — bank-webhook fires bank-sync fire-and-forget with no observable result

`bank-webhook/index.ts` (line 76–86): `fetch(...).catch((e) =>
console.error(...))`. If the subsequent bank-sync call fails (Basiq 5xx,
network timeout, Deno memory limit), the webhook returns `200 ok` with
`action: 'sync_kicked'` and the failure is only visible in edge function logs.
The Basiq retry will send another webhook event, but if the failure is
persistent (e.g., the bank-sync function itself is mis-deployed), transactions
will not land until someone monitors logs. At minimum, track a
`last_sync_triggered_at` and `last_sync_error` on `bank_connections` so the UI
can surface stale connections.

### 6.2 — subscriptions-detect: insert/update errors are silently dropped

`subscriptions-detect/index.ts` (lines 122–153): both the `admin.from('subscriptions').update()` and
`admin.from('subscriptions').insert()` calls discard their return value. Neither
error is checked. The counters `updated` and `upserted` will increment even when
the DB call fails. Destructure the result and log or surface errors:

```ts
const { error: upErr } = await admin.from('subscriptions').update({...}).eq('id', existing.id);
if (upErr) console.error('sub update failed:', key, upErr.message);
```

### 6.3 — CreateJobForm: job number auto-generation is racy

`src/pages/Jobs.tsx` (lines 200–210): the modal reads the highest existing
`job_number` and proposes `+1`. If two users open the modal simultaneously,
both get the same suggestion and the second insert will fail on the unique
constraint. The error is surfaced (`setErr(error.message)`), which is fine for
UX, but the user has to manually pick a different number. Fix: use a DB
sequence or the same counter-table pattern used for invoices.

---

## 7. Testability

### 7.1 — Tenant isolation suite is entirely skipped

`tests/tenant-isolation.test.ts` is `describe.skip(...)` with all tests as
empty stubs. This is the single most important test category for a multi-tenant
accounting product. Given that RLS is the primary guard and 0030 has missing
policies in version control, the absence of any passing isolation test is a
meaningful risk.

### 7.2 — Trigger logic is untestable without a live DB

The trigger functions (`bills_autolink_supplier`, `timesheet_recompute_cost`,
and the absent invoice triggers) contain business logic but can only be tested
against a real Postgres instance. There are no unit tests using `pgTAP` or a
local Supabase instance in the CI config. The `vitest.config.ts` only covers
frontend code. Add a `supabase test db` step using pgTAP or at minimum document
the manual verification steps in a CI comment.

### 7.3 — Edge function logic is not unit-tested

`subscriptions-detect` contains non-trivial business logic: `canonicaliseDescription`,
`classifyCadence`, `confidenceScore`, `medianOf`. These pure functions are
testable in isolation with Deno's built-in test runner but there are no
`*_test.ts` files next to the function.

---

## 8. Code Smells

### 8.1 — `getBillCount` in Jobs.tsx is a type workaround

`src/pages/Jobs.tsx` (lines 16–21): `getBillCount` exists solely to handle the
`[{ count: number }] | []` union type returned by Supabase's `.select('...(count)')`
shorthand. With real generated types this becomes unnecessary; the type would be
`Array<{ count: number }>` and `.at(0)?.count ?? 0` would suffice.

### 8.2 — bank-sync-all `r: any` cast

Line 49: `(rows ?? []).map((r: any) => r.organization_id)` is a symptom of the
missing generated types (see 3.1).

### 8.3 — The stale-comment dead reference in 0030

The final line of `0030_invoices.sql` directs readers to "see migration body in
DB". This is not version-controlled documentation; it is an admission that the
migration is incomplete. Remove the comment when the full DDL is added.

### 8.4 — v_gst_summary_by_quarter in 0003 references `customer_invoices` but 0030 creates `invoices`

`0003_financial_views.sql` (lines 222, 246) queries a table called
`customer_invoices`; `0030_invoices.sql` creates a table called `invoices`. The
initial schema (0001) also uses `customer_invoices` in the RLS loop. If the
canonical name is `invoices` (as 0030 implies), `v_gst_summary_by_quarter` and
`v_job_revenue` are pointing at a different table. If both tables exist (the old
AR table and the new one), data is silently split. Verify which table name is
authoritative and consolidate.

### 8.5 — `Access-Control-Allow-Origin: '*'` on all edge functions including authenticated ones

`supabase/functions/_shared/cors.ts` sets `*` as the allowed origin for every
function including ones that handle financial data and accept JWTs. In
production this should be restricted to the app domain
(`https://app.loopletaccounting.com.au` or equivalent). A `*` CORS policy does
not defeat JWT auth, but it does allow any website to make preflight-passing
requests and observe error shapes.

---

## Severity Summary

| # | Item | Severity |
|---|------|----------|
| 1.1 | 0030 missing triggers + RLS in VCS | Critical |
| 1.2 | subscriptions-detect org not verified | Critical |
| 1.3 | bank-sync-all unauthenticated | Critical |
| 1.4 | Reconciliation non-atomic writes | Critical |
| 2.3 | Webhook token check conditional | Warning |
| 3.1 | database.types.ts all-any | Warning |
| 4.1 | Autolink trigger race condition | Warning |
| 4.3 | timesheet cost defaults to zero | Warning |
| 4.4 | Invoice trigger bodies not in VCS | Warning |
| 5.1 | v_job_pnl N+1 correlated subqueries | Warning |
| 7.1 | Tenant isolation tests all skipped | Warning |
| 8.4 | customer_invoices vs invoices name split | Warning |
| 2.4 | MoveToOrgButton client-side org list | Info |
| 5.2 | v_bas_quarterly missing index | Info |
| 5.3 | v_bank_invoice_match LIKE full-scan | Info |
| 6.1 | bank-sync fire-and-forget in webhook | Info |
| 6.2 | subscriptions-detect swallowed errors | Info |
| 6.3 | Job number race condition | Info |
| 7.3 | No edge-function unit tests | Info |

The four Critical items are the ones to resolve in the next sprint. Items 1.1
and 8.4 together represent the most acute data-correctness risk; 1.2 and 1.3
are the most acute security risks.
