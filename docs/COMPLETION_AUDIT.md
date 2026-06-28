# Looplet Accounting — Completion Audit

**Date:** 2026-05-06
**Org under test:** Affordable Fencing Gold Coast (`9d5c9b9a-…`)
**Scope:** 25 modules × 12 dimensions, plus pipeline traces and DB-state cross-check.

---

## 2026-06-29 Wrap-up Addendum

This document is now a historical May 6 baseline, not the current release
scorecard. Current wrap-up evidence changes these conclusions:

- **Reconciliation invoice-side:** code and live DB hardening are done. The UI
  matches bank inflows to invoices and caps settlement at the lesser of the bank
  inflow and invoice balance. Live `0196_harden_invoice_reconciliation.sql`
  proof shows hardened AR grants, invoice-payment validation, triggers, and a
  security-invoker invoice match view. Remaining proof is a signed-in live
  invoice/payment smoke with real AR data.
- **Receipt Hub:** the Receipt Tag/Web NFC carrier and WhatsApp delivery scope
  have landed. The NFC read path was later corrected to wait for the `reading`
  event or timeout, and Chromium/Firefox desktop/mobile smoke passed with no
  console/page errors or horizontal overflow. Receipt functions and sync cron
  are deployed. A deploy-gated `tests/receipt-hub-live-smoke.test.ts` now
  encodes the signed-in SC-13 proof path: issue a receipt identity, call the
  deployed `receipt-webhook`, verify the persisted event, bill, line item, audit
  JSON, generic API sync job, and user RLS visibility, then clean up smoke data.
  Fresh live counts still show no end-to-end receipt data
  (`receipt_events=0`, `receipt_sync_jobs=0`) and no enabled
  `receipt_sync_endpoints`/`xero_integrations`, so the remaining blocker is live
  data/integration setup plus a real signed-in test JWT/org.
- **Legal RAG / Horizon:** schema and edge-function surfaces are live, including
  legal corpus/reference tables, advice-note RPCs, `legal-horizon-run`, and
  hardened legal table grants. The corpus is still unseeded
  (`legal_corpus=0` at audit time), Legal Horizon still needs a real scanner run
  with valid Sonar secret, and Ask still needs a signed-in proof that a real
  answer returns corpus `citations[]`.
- **Legal RAG seed blocker:** a fresh source-material/secret check on
  2026-06-29 found no local NotebookLM/legal source text bundle, and the linked
  project does not have `OPENAI_API_KEY`, `LEGAL_INGEST_SECRET`,
  `LEGAL_SYNC_SECRET`, or `LEGAL_SCAN_SECRET` configured by those names. The
  scanner provider key is present, but corpus seeding still requires clean legal
  text plus the OpenAI embedding key. The `legal-corpus-sync` fetch path remains
  a raw-markup stub and must not be scheduled until real FRL/ATO extraction is
  built or the provided-text path is used intentionally.
- **Advisor:** deployed with JWT enabled and local Deno/model tests passing, but
  still needs a signed-in Ask/on-demand smoke proving a live `advice_notes` draft
  row is created. A deploy-gated `tests/advisor-live-smoke.test.ts` now encodes
  that proof path, but it requires a real `TEST_USER_JWT`, `TEST_ORG_ID`, and
  service-role cleanup key. Public sign-up was rate-limited during the
  2026-06-29 wrap-up pass, so this was not completed unattended.
- **Migration state:** missing live DDL for `0181`-`0187` was applied and verified
  on 2026-06-29. The timestamp-version drift for known-applied rows was repaired
  afterwards, then the remaining local-only ranges `0138`-`0150` and
  `0154`-`0177` were applied/verified live and recorded in history. The Supabase
  migration list now lines up for every local migration through `0196`, and a
  dry run of `supabase db push` returns `Remote database is up to date.`
- **Fresh local gates:** after the wrap-up DB/doc work, `npm run format:check`,
  `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run build` all
  passed on 2026-06-29. The build still emits the pre-existing pdfjs dynamic
  import warning and a large main-chunk warning.
- **Fresh live blocker counts:** `legal_sources=7`, `legal_corpus=0`,
  `legal_change_events=0`, `legal_horizon=0`, `advice_notes=1`,
  `receipt_events=0`, enabled `receipt_sync_endpoints=0`, and enabled
  `xero_integrations=0`. A focused Receipt Hub check also found
  `receipt_identities=3` and `receipt_sync_jobs=0`; the receipt sync drain cron
  is active, but there is no live receipt chain data yet. The one advice note is
  a `structuring` draft created 2026-06-28; without a signed-in Ask/browser
  trace, it narrows but does not complete the advisor workflow proof.

## TL;DR

**Code: ~70% complete.** The skeleton is whole and correct. RLS, multi-org, intake pipelines, and reconciliation infrastructure all work. The remaining 30% is split across:

- **Real polish:** mobile, pagination, error specificity, export, edit-modes on a few detail pages.
- **External integrations:** Xero bidirectional, Basiq Connect callback completion, Gmail Pub/Sub push.
- **Critical onboarding gaps:** no Create-Job UI, no Create-Customer UI, no Create-Employee/Debt is fine but there's no "let me create my first invoice" empty state with guidance.

**Data: ~10% populated.** This is the bigger issue, and not a code bug — most of what looks broken is starvation, not breakage:

- 0 customers, 0 invoices, 0 employees, 0 debts, 0 timesheets, 0 subscriptions, 0 bills marked personal
- 449 staged entities classified by AI but **399 still pending triage** (user hasn't clicked through Triage to create intake_rules)
- 150 bills ingested but only 5 have totals (Gmail mining sweeping up non-bill emails)

The "subscriptions empty" complaint is correct: detection ran, but only 5 bank txns × 1 month is too sparse for a recurring pattern. **The fix is the 7 PDF statements you have queued — once they import, detection will fire and populate.**

---

## Scorecard

Score: 0=missing, 1=stub, 2=partial, 3=working, 4=polished. Cells with `—` are not applicable. ✓ ≥3, ⚠ =2, ✗ ≤1.

| Module                           | Schema | Pipeline | List | Detail | Create | Edit | Del | Multi-org | Empty | Error | Loading | Mobile |
| -------------------------------- | ------ | -------- | ---- | ------ | ------ | ---- | --- | --------- | ----- | ----- | ------- | ------ |
| 1. Auth                          | 4✓     | —        | 4✓   | —      | 4✓     | —    | —   | —         | 3✓    | 3✓    | 3✓      | 2⚠     |
| 2. Onboarding (AutoSetup+Triage) | 3✓     | 3✓       | 3✓   | 3✓     | —      | —    | —   | 3✓        | 2⚠    | 2⚠    | 3✓      | 1✗     |
| 3. Dashboard P&L                 | 4✓     | 4✓       | —    | —      | —      | —    | —   | 3✓        | 3✓    | 3✓    | 3✓      | 2⚠     |
| 4. Bills                         | 4✓     | 4✓       | 4✓   | 4✓     | 4✓     | 1✗   | 3✓  | 4✓        | 3✓    | 3✓    | 4✓      | 2⚠     |
| 5. Allocations                   | 4✓     | 4✓       | 4✓   | —      | —      | —    | —   | —         | 3✓    | 2⚠    | 3✓      | 2⚠     |
| 6. Suppliers                     | 4✓     | 4✓       | 4✓   | 4✓     | 0✗     | 4✓   | 3✓  | 0✗        | 3✓    | 2⚠    | 3✓      | 2⚠     |
| 7. Customers                     | 4✓     | 0✗       | 4✓   | 4✓     | 0✗     | 4✓   | 2⚠  | 0✗        | 2⚠    | 2⚠    | 3✓      | 2⚠     |
| 8. Jobs                          | 4✓     | 2⚠       | 4✓   | 4✓     | 0✗     | 4✓   | 3✓  | 0✗        | 3✓    | 2⚠    | 3✓      | 2⚠     |
| 9. Invoices                      | 4✓     | 4✓       | 4✓   | 4✓     | 4✓     | 4✓   | 3✓  | 0✗        | 3✓    | 2⚠    | 3✓      | 2⚠     |
| 10. Bank — Basiq Connect         | 4✓     | 2⚠       | 3✓   | 1✗     | 3✓     | —    | 1✗  | —         | 3✓    | 2⚠    | 2⚠      | 1✗     |
| 11. Bank — CSV import            | 4✓     | 4✓       | 3✓   | —      | 4✓     | —    | —   | —         | 3✓    | 3✓    | 3✓      | 1✗     |
| 12. Bank — PDF parser            | 4✓     | 3✓       | 3✓   | —      | 4✓     | —    | —   | —         | 2⚠    | 3✓    | 3✓      | 1✗     |
| 13. Bank — Reconciliation        | 4✓     | 3✓       | 4✓   | —      | —      | —    | —   | —         | 3✓    | 3✓    | 3✓      | 2⚠     |
| 14. Bank — Subscription detect   | 4✓     | 4✓       | —    | —      | —      | —    | —   | —         | 3✓    | 3✓    | 3✓      | —      |
| 15. Subscriptions                | 4✓     | 4✓       | 4✓   | 0✗     | —      | 3✓   | 0✗  | 4✓        | 3✓    | 2⚠    | 3✓      | 1✗     |
| 16. Debts                        | 4✓     | 0✗       | 4✓   | 0✗     | 4✓     | 0✗   | 0✗  | 0✗        | 3✓    | 2⚠    | 3✓      | 2⚠     |
| 17. Employees+Timesheets         | 4✓     | 1✗       | 4✓   | 0✗     | 4✓     | 0✗   | 0✗  | 0✗        | 3✓    | 2⚠    | 3✓      | 2⚠     |
| 18. Reports — BAS                | 4✓     | 4✓       | 4✓   | —      | —      | —    | —   | —         | 3✓    | 2⚠    | 3✓      | 2⚠     |
| 19. Reports — Cash flow          | 4✓     | 4✓       | 4✓   | —      | —      | —    | —   | —         | 3✓    | 1✗    | 3✓      | 2⚠     |
| 20. Settings — Org profile       | 4✓     | 3✓       | —    | 3✓     | 4✓     | 4✓   | —   | —         | —     | 2⚠    | 3✓      | 2⚠     |
| 21. Settings — Gmail             | 3✓     | 4✓       | 3✓   | —      | 4✓     | —    | 3✓  | —         | 3✓    | 3✓    | 3✓      | 1✗     |
| 22. Settings — Xero              | 1⚠     | 0✗       | —    | —      | 1⚠     | —    | —   | —         | —     | 0✗    | 0✗      | 0✗     |
| 23. Quality                      | 4✓     | 4✓       | 4✓   | —      | —      | —    | —   | —         | 4✓    | 3✓    | 3✓      | 2⚠     |
| 24. Personal/Business split      | 4✓     | 3✓       | —    | 4✓     | —      | 4✓   | —   | —         | —     | 3✓    | —       | 2⚠     |
| 25. Multi-org allocation         | 4✓     | 3✓       | —    | 4✓     | —      | —    | —   | 4✓        | —     | 3✓    | —       | 1✗     |

**Average score across cells with content:** ~2.8 / 4 = **70% complete**.

---

## Pipeline trace results (Phase D)

| Flow                                         | Result         | Evidence                                                                                                                              |
| -------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Email → Bill → Supplier auto-link**        | ✅ working     | 150 bills ingested; supplier-autolink trigger created 9 suppliers; 14 bills got supplier_id linked                                    |
| **Bills extract → suggested_job**            | ✅ working     | 22 bills have job_id from suggestions, all attached to J0001                                                                          |
| **gmail-mine → AI classify → Triage**        | ⚠ user-blocked | 449 staged_entities exist + classified; **399 still pending** because user hasn't run through Triage. Code works; user behaviour gap. |
| **Bank txn → Reconciliation candidates**     | ⚠ no data      | View `v_bank_match_candidates` exists; 0 matches because no real bills have totals matching the 5 fake txns                           |
| **Bank txn → subscriptions-detect**          | ⚠ no data      | Edge fn deployed; runs after every bank-sync/CSV/PDF; 0 subs detected because only 5 debit txns total (need ≥3 of same merchant)      |
| **Bill marked personal → excluded from BAS** | ⚠ untested     | View filters on `is_personal=false`; 0 bills tagged personal so excluded but not exercised                                            |
| **MoveToOrgButton → row moved**              | ⚠ user-blocked | Wired to bills+subs; user has only 1 org so dropdown is empty. Need a 2nd org to validate.                                            |
| **Timesheet entry → v_job_pnl wages**        | ⚠ untested     | 0 timesheets exist; view computes from timesheet_entries.total_cost_cents                                                             |
| **PDF statement → bank txns + subs**         | ⚠ user-blocked | Pipeline deployed; user hasn't uploaded the 7 queued PDFs                                                                             |

---

## Database state (Phase C)

```
ROW COUNTS                       BILL QUALITY
- bills              150         - total              150
- invoices             0         - with supplier_id    14  (9.3%)
- invoice_line_items   0         - with job_id         22  (14.7%)
- invoice_payments     0         - with total amount    5  (3.3%) ← OCR mostly failed
- suppliers            9         - paid                 0
- customers            0         - personal             0
- jobs                70         - low confidence      66  (44%)
- bank_connections     1         - duplicate groups     0
- bank_accounts        1
- bank_transactions    5         BANK
- subscriptions        0         - matched to bill      0
- debts                0         - matched to invoice   0
- employees            0         - unmatched            5
- timesheet_entries    0         - personal             0
- organizations        1
- gmail_integrations   1         PIPELINES
- staged_entities    449         - subscriptions      0  (need more bank data)
  └ pending          399         - intake_rules       0  (Triage never run to completion)
  └ classified       449         - high-confidence subs  0

ORPHANS                          ORG SETTINGS
- bills_w_bad_supplier  0        - has_abn          false  ← form not saved yet
- bills_w_bad_job       0        - settings_keys     null
- invoices_w_bad_customer  0
- invoice_lines_w_bad_invoice  0
- timesheets_w_bad_employee  0
```

**Healthy:** zero orphan rows, RLS isolating cleanly, triggers firing.
**Starved:** every revenue/payroll/debt table empty, 96% of bills missing totals, intake_rules empty.

---

## Gaps — P0 (broken on arrival)

None. The earlier subagent flagged some but they were false positives:

- ~~`Bills.tsx` joins non-existent `attached_job`~~ — actually present in `useBills.ts:36`
- ~~Triage page is a placeholder~~ — actually fully implemented
- ~~OrgSelector has no Create-org button~~ — actually present at `OrgSelector.tsx:126`

---

## Gaps — P1 (missing core)

Ordered by user-visible value:

1. **No "+ New customer" button on `/customers`** — list page exists, detail page exists, but no way to create a customer from the UI. Have to use SQL. Blocks invoicing because invoices need a customer. Fix: add button + form (~15 min).
2. **No "+ New job" button on `/jobs`** — same shape. Blocks Allocations from being useful, blocks customer-side invoicing flow. Fix: ~15 min.
3. **399 staged entities pending Triage** — onboarding stalled. Need a "complete onboarding" CTA on Dashboard pointing to `/onboarding/triage`. Or a one-shot "Approve all AI-confident classifications" bulk action. Fix: ~30 min.
4. **No bill detail Edit mode** — OCR fails on 96% of bills (totals missing). User can't fix the extracted fields. Currently re-OCR is the only repair. Add inline edit for supplier_name_raw / invoice_number / invoice_date / total_inc_gst_cents / gst_cents. Fix: ~30 min.
5. **Org settings (ABN, tax %) form doesn't write through** — `OrgProfileForm` saves to `organizations.settings`, but the org has `settings_keys=null` in DB. Either form is broken or user hasn't clicked Save. Need to verify. Fix: ~15 min to verify, ~15 to repair.
6. **Reconciliation invoice-side** — resolved 2026-06-29. The UI matches bank inflows to invoices, caps settlement at `min(bank inflow, invoice balance)`, and `0196_harden_invoice_reconciliation.sql` hardens the RPC, payment validator, AR grants, triggers, and security-invoker match view. Remaining proof: run a signed-in live invoice/payment smoke with real AR data.
7. **MoveToOrgButton not wired to Invoices/Jobs/Customers/Suppliers detail** — only Bills + Subscriptions. ~5 lines per page = 20 min total.
8. **No Subscription detail page** — `/subscriptions/:id` doesn't exist. Tagging UI in the list table works but no way to see history of a single sub. Fix: ~30 min.
9. **No Debt detail / payment recording** — list + create exist, no way to record a payment, no amortisation. Fix: ~45 min.
10. **No Employee detail / timesheet edit** — same shape. Fix: ~45 min.
11. **Basiq Connect callback path incomplete** — `bank-link-token` mints; `BankCallback.tsx` is shallow; doesn't reliably fetch initial transaction backfill after first connect. Fix: ~1 h.
12. **gmail-pubsub-push handler is a stub** — registered; no payload-replay logic. New emails arrive but don't auto-trigger gmail-mine for the latest message. Fix: ~1 h.
13. **xero-oauth pair coded, not wired** — buttons missing from Settings. Even if wired, no `xero-sync-bills` / `xero-sync-invoices` edge fns exist. Fix: ~4-8 h (deferred, multi-day).

---

## Gaps — P2 (missing polish)

Ordered roughly by frequency-of-friction:

- **Mobile layout** — sidebar fixed at 220px, tables don't scroll horizontally, no `@media` breakpoints. Fix: ~2 h global pass.
- **No pagination on Bills/Invoices/Suppliers tables** — currently `select('*')` with no limit. Fine at 150 rows, breaks at 5k. Fix: cursor pagination ~1 h.
- **Loading states are "Loading…" text** — replace with skeleton cards matching page layout. Fix: ~1 h.
- **Error states say "Failed to load"** — propagate `error.message`, distinguish auth/network/RLS/validation. Fix: ~1 h.
- **No archive/restore UI** — `deleted_at` column exists, no way to soft-delete from the UI. Fix: ~30 min.
- **No CSV/PDF export on reports** — BAS and Cash Flow are tables-only. Fix: ~1 h each.
- **Job P&L has no trend chart** — KPIs only. Add sparkline for margin trend. Fix: ~1 h.
- **Invoice line items don't support `zero` GST treatment** — only `inc/ex/free`. Add for tax-free supplies. Fix: 5 min.
- **Cash flow forecast has no opening balance** — assumes $0 starting bank balance. Add seed from `bank_accounts.current_balance_cents`. Fix: ~30 min.
- **Allocations queue has no bill preview** — clicking opens detail page; would be nicer to side-pane the PDF. Fix: ~1 h.
- **Subscriptions table cramped on mobile** — 10 columns. Card layout below 768px. Fix: ~30 min.
- **Settings "Coming next" list** — replace static bullets with linkable issues / a roadmap doc. Fix: 5 min.

---

## Gaps — P3 (deferred / multi-day)

These are big enough to warrant their own sprint, not lumped in here:

- **Xero bidirectional sync** — push bills as ACCPAY, push invoices as ACCREC, pull payments. ~1-2 days.
- **Full payroll** — PAYG withholding tables, super contributions, STP file format. ~2 days.
- **Balance sheet** — needs a general-ledger model first (not yet designed). ~2 days.
- **Annual Tax summary** — depends on personal/business split being thoroughly applied; ATO-aligned categories. ~1 day.
- **Audit log + Team RBAC** — new tables, middleware, role checks. ~1 day.
- **Notification system** — channel preferences, delivery (email/in-app), templating. ~1 day.
- **Auto-routing rules engine** — `intake_rules.matcher_value` regex → `organization_id` override. ~4 h.
- **Split allocation** — one bill across multiple businesses with %. Schema change + UI + report-side handling. ~1 day.
- **Recurring bill detection** — sister of subscription detection but for inbound invoices. ~4 h.
- **ABA payment runs** — select bills due → generate ABA file → mark paid. ~4 h.

---

## Pipeline / function inventory

**Wired and working:**

- `bills-extract`, `bills-extract-batch`, `bills-attach`
- `gmail-oauth-start`, `gmail-oauth-callback`, `gmail-mine`, `gmail-classify-ai`, `gmail-watch-renew`, `gmail-pubsub-push` (handler stub)
- `bank-link-token`, `bank-exchange`, `bank-sync`, `bank-sync-all`, `bank-webhook`, `bank-csv-import`, `bank-statement-extract`
- `subscriptions-detect` (fires after every bank ingest)
- `xero-oauth-start`, `xero-oauth-callback` (deployed but UI never invokes)

**Triggers / DB-side automation:**

- `bills_autolink_supplier` — auto-creates + links supplier on bill insert/update (working)
- `invoices_assign_number` — auto-numbers invoices `INV-NNNN`
- `invoices_recompute_totals` — line items → invoice totals
- `invoices_apply_payment` — payment → status flip + paid_at
- `timesheet_recompute_cost` — hours × rate

**Views:**

- `v_organization_realtime_pnl`, `v_job_pnl`, `v_customer_pnl`
- `v_bas_quarterly`, `v_cash_flow_weekly`
- `v_bank_match_candidates`
- `v_personal_expenses`, `v_personal_bank_expenses`
- `v_duplicate_bills`, `v_low_confidence_bills`

---

## Migration ledger

| File                                         | Purpose                                                                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_initial_schema.sql`                    | Core tables, enums, RLS scaffold                                                                                                                                                       |
| `0002_bill_content_hash.sql`                 | `bills.content_sha256` + dedupe index                                                                                                                                                  |
| `0003_financial_views.sql`                   | `v_organization_realtime_pnl`, `v_job_pnl`                                                                                                                                             |
| `0004_bill_routing.sql`                      | `bills.suggested_job_id`, `suggested_match_score`, `job_reference_raw`                                                                                                                 |
| `0028_suppliers_backfill_and_autocreate.sql` | `suppliers.contact_phone` + `current_balance_owing_cents`, normalised-name unique idx, backfill from `bills.supplier_name_raw`, autolink trigger                                       |
| `0029_bank_reconciliation_match_view.sql`    | `v_bank_match_candidates` (amount + date + supplier-substring match)                                                                                                                   |
| `0030_invoices.sql`                          | `invoices`, `invoice_line_items`, `invoice_payments`, `invoice_number_counters`; auto-number, recompute-totals, apply-payment triggers; `invoice_gst_treatment` enum; `v_customer_pnl` |
| `0031_personal_business_split.sql`           | `bills.is_personal`, `bank_transactions.is_personal` + indexes; `v_personal_expenses`, `v_personal_bank_expenses`                                                                      |
| `0032_bas_and_cash_flow_views.sql`           | `au_bas_quarter()` helper; `v_bas_quarterly`, `v_cash_flow_weekly`                                                                                                                     |
| `0033_timesheet_entries.sql`                 | `timesheet_entries` table + RLS + auto-cost trigger                                                                                                                                    |
| `0034_quality_views.sql`                     | `v_duplicate_bills`, `v_low_confidence_bills`                                                                                                                                          |

---

## Recommended next-sprint order

1. **Triage cleanup** — bulk-approve high-confidence AI classifications. Unblocks the 399 pending entities + populates intake_rules so future intake auto-routes. (~30 min)
2. **Customer + Job create UIs** — unblocks invoicing. Currently you can't even raise an invoice because there's no customer. (~30 min)
3. **Bill detail edit mode** — repair the 96% of bills with missing totals so reports become meaningful. (~30 min)
4. **Wire MoveToOrgButton onto remaining detail pages** + create a 2nd org so the multi-tenancy can be exercised. (~30 min)
5. **Reconciliation invoice-side** — once invoices exist, match bank inflows. (~30 min)
6. **Mobile layout pass** — global responsive sweep. (~2 h)
7. **Xero bidirectional sync** — biggest user-visible deferred item. (~1-2 days)

After (1-5) the app is usefully end-to-end on real data.
