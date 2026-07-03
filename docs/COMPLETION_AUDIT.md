# Looplet Accounting — Completion Audit

**Date:** 2026-05-06 historical baseline
**Org under test:** Affordable Fencing Gold Coast (`9d5c9b9a-…`)
**Scope:** 25 modules × 12 dimensions, plus pipeline traces and DB-state cross-check.

This document now contains two different score types. They must not be blended:

- **72%** is the historical May 6 product/UI scorecard below. It measured broad
  screen coverage, mobile, empty/error/loading states, CRUD, and live data gaps
  at that point in time.
- **100% local source-contract automation wiring** means the July automation
  spine now has `63 / 63` declared automation strings connected by source/tests.
  It does not mean every production integration has been activated.
- **~85% current production readiness** is the July 2 evidence-based estimate
  after deploying `ato-lodge`, deploying `bas-lodgement-pack`, and adding the
  `LEGAL_INGEST_SECRET` / `LEGAL_SCAN_SECRET` Edge secrets. It is still not
  100% because nine migrations are not yet live-proven from this shell, the
  local `SUPABASE_DB_PASSWORD` is invalid for the linked database, and
  deploy-gated signed-in/RLS tests still need real credentials and fixture IDs.

---

## 2026-07-02 Completion Estimate Addendum

Current evidence-based production readiness estimate: **~85%**. This is not a
claim that all production integrations are live-proven. In
`docs/automation-spine.html`, the current local source-contract automation
wiring score is **63 / 63 connected strings (100%)**, with **0 / 63
disconnected** strings visible on the graph. The completion estimate was lowered
after the 2026-07-02 live Supabase audit found eight target migrations missing
from production and two legal runtime secrets absent. Follow-up remediation has
now deployed the two missing Edge Functions from that audit, `ato-lodge` and
`bas-lodgement-pack`, added the two legal Edge secrets without exposing their
values, and added one further local migration for invoice zero-rated GST
treatment. The remaining hard blockers are migration proof/apply, a valid linked
DB password, signed-in test credentials, and deploy-gated product proof.

Evidence added to reach the 63/63 local source-contract wiring checkpoint:

- BAS lodgement packaging is code-complete via `bas-lodgement-pack`, with
  caller-scoped edge-function contracts and local PDF/bundle tests.
- `docs/automation-spine.html` now opens with the verified/default checklist at
  44 / 51 nodes ticked; only the seven red not-running nodes remain unticked.
  These ticks mean node readiness/accounting, not end-to-end autonomous wiring.
- Cash Flow CSV export is no longer a stale gap: `src/test/pages/CashFlow.test.tsx`
  proves weekly aggregation, `bank_accounts.current_balance_cents` opening
  balance, running balance, and the exact exported CSV rows.
- Verification on 2026-07-02 passed: focused impacted Vitest, `git diff --check`,
  `npm run lint`, `npm run typecheck`, full `npm test -- --reporter=dot`, and
  `npm run build`.
- Additional 2026-07-02 source-contract proof promoted bank post-sync,
  AP review, capital-purchase scheduling, books-close/orchestrator, ABA, and
  super approval-wall strings. Focused verification passed 34 tests across
  `tests/automation-backbone-contract.test.ts`,
  `tests/coding-classifier-contract.test.ts`,
  `tests/accounting-engine-contract.test.ts`, and
  `tests/books-close-orchestrator-contract.test.ts`.
- The accountant orchestrator now has a real engine-dispatch layer for BAS,
  super-batch, and income-tax draft work. It writes durable `compliance_drafts`
  for draft engines, uses a service-only BAS lodgement draft handoff that opens a
  pending hash-bound approval, and explicitly skips unsupported engines instead
  of pretending they are wired.
- A6 Gmail mining now has a durable worker path: the forward migration schedules
  `gmail-mine-refresh` to enqueue `gmail_mine` automation jobs, and
  `automation-worker` owns the `gmail_mine` job kind instead of relying on direct
  cron HTTP calls.
- The legal/advisor/orchestrator loop is locally wired: scheduled Advisor loads
  open `legal_horizon` rows as proposal-only context on `advice_notes`, and the
  accountant orchestrator now reads scheduled draft `advice_notes` into
  `review_advice_note` tasks. Focused Deno tests prove the proposal-only guard
  and the G11 -> G1 decision handoff.
- Income-tax draft dispatch now opens a service-role, hash-bound Tier-2 approval
  for the generated `compliance_drafts` row. This promotes G7 -> H1 while keeping
  true-and-correct declaration and lodgement as explicit external legal walls.
- Specialist compliance dispatch now has safe draft adapters for G6, G8, and G9
  families: TPAR, FBT, EOFY, WorkCover, payroll tax, ASIC annual review, SMSF
  TBAR, trust distributions, Div 7A, SGC, franking-account review, and CGT.
  Focused Deno/Vitest tests prove the mappings, durable `compliance_drafts`
  upserts, service-role RPC grants, and hash-bound Tier-2 approval handoffs.
- BAS worksheet generation now carries posted-GL GST control reconciliation from
  `system_accounts` plus posted `journal_entries`/`journal_lines`, including
  1A/1B control totals, label deltas, and a boolean reconciliation flag. This
  proves E2 -> G4 locally without silently changing BAS label calculations.
- Xero bill/invoice push outcomes now carry immutable GL evidence snapshots in
  `xero_sync_log.response.looplet_gl_evidence`, sourced from posted
  `journal_entries` for the pushed bill/invoice. This proves I7 -> E1 as an
  append-only audit-trail writeback without mutating posted journals.
- Auto-reconcile evidence is now atomic and GL-linked: successful bill and
  invoice matches write `reconciliation_evidence.score_components.gl_evidence`
  from posted `journal_entries` for the matched source record in the same
  transaction as the match. This promotes D5 -> E1 as evidence-to-ledger/audit,
  not as a blind journal-posting shortcut.
- `ato-lodge` now models the H1-approved BAS/ATO handoff explicitly: a
  lodgement attempt requires both `approval_id` and `lodgement_id`, blocks
  without a human true-and-correct declaration, then still stops at the
  fail-closed ATO/EVTE/DSP/SBR operations gate. Focused Deno tests prove both
  H1 -> I2 and H1 -> I1 remain legal-wall handoffs, not auto-lodgement.
- `intake-routing-apply` now exposes its bill ledger handoff to
  `coding-classifier` in the response, and batch mode counts those handoffs.
  Focused source-contract tests prove C2 -> E1 is a visible handoff into the
  sanctioned coding-classifier GL posting path, not a silent fire-and-forget.
- `bank-transaction-classifier` now posts safe bank-only debit classifications
  through the immutable GL helper with `source_type='bank_transaction'`. It
  deliberately skips matched bill/invoice rows, personal rows, inbound/customer
  payment-style rows, and unsupported/legal-wall categories; required GL-post
  failures are held in review instead of marked silently complete. This proves
  D4 -> E1 locally without blind-posting unsafe bank lines.
- STP export/payroll finalisation now carry a structured
  `stp_sbr_transmit` gate with `transmit_enabled=false` and registered
  tax/BAS-agent handoff language. Focused Deno/Vitest tests prove H1 -> I5 stays
  an approval-to-transmit-wall path, not a transmission implementation.
- SMSF/TBAR specialist dispatch now writes structured `external_walls` including
  `smsf_independent_audit` and `tbar_registered_agent_lodgement` into the draft
  payload and approval request. Focused Deno/Vitest tests prove H1 -> I6 stays
  independent-human gated.
- Fresh Playwright render proof for `docs/automation-spine.html` captured
  `tmp/automation-spine-63-of-63-preview.png`: the page rendered an SVG with
  51 visible nodes, legend counts `Connected 63` and `Disconnected 0`, console
  logged `spine-graph strings tagged: 63 / 63`, and no page errors were emitted.
- Live readiness remediation after the Chrome/Supabase audit now proves the
  required Edge Function slugs and required Edge secret names are present:
  `ato-lodge`, `bas-lodgement-pack`, `LEGAL_INGEST_SECRET`, and
  `LEGAL_SCAN_SECRET`. Evidence is recorded in
  `tmp/deploy-ato-lodge.log`, `tmp/deploy-bas-lodgement-pack.log`,
  `tmp/set-legal-edge-secrets.log`, and
  `tmp/supabase-readiness-after-legal-functions.log`.
- Load-error copy is now locally proved across the audited high-traffic and
  secondary surfaces. `formatLoadError` is wired through Customers, Jobs,
  Suppliers, Allocations, Dashboard, Coding Review, Fixed Assets, Payment Runs,
  Quality, SMSF, Trusts, CGT events, registrations, and the allocation queue.
  Focused proof passed 37/37 tests across formatter, page, component, and source
  coverage tests. Evidence: `tmp/secondary-error-copy-tests.log`.
- Loading-state polish advanced beyond core detail pages: business/org profile,
  bank/Gmail/Xero connector panels, connector API keys, onboarding triage,
  activity sessions, team members, approvals, Legal Horizon, Tax Return draft,
  and Quality duplicate checks now use existing skeleton primitives instead of
  plain loading copy. Focused proof passed 32/32 tests. Evidence:
  `tmp/auxiliary-loading-skeleton-tests.log`.
- Long-tail passive loading placeholders are also locally proved: document
  preview, bank coding queue, allocation split popover, Audit Log
  correspondence/drafts/events, Payroll super batch, BAS worksheet, Settings
  automation policies, org selector, and Bill Detail preview/history now use
  skeleton primitives. Focused proof passed 22/22 tests. Evidence:
  `tmp/long-tail-loading-skeleton-tests.log`.
- Settings connector mobile polish now covers Gmail intake and Bank accounts:
  both keep desktop tables and add mobile card decks below the 768px breakpoint,
  with the same operational fields/actions. Focused proof passed 4/4 tests and
  a Playwright mobile check verified `/settings` redirects to `/login` without a
  signed-in session. Evidence: `tmp/settings-connector-responsive-tests.log`,
  `tmp/settings-mobile-playwright-check.log`, and
  `tmp/settings-mobile-unauth-2026-07-02.png`.
- Reconciliation mobile polish now covers the "Recently matched" dense table:
  desktop keeps the audit/evidence table while mobile gets matched-transaction
  cards with date, amount, matched destination, Why, and Undo actions. Focused
  proof passed 3/3 tests. Evidence: `tmp/reconciliation-mobile-card-tests.log`.
- Onboarding Triage mobile polish now covers the staged-sender review table:
  desktop keeps the bulk review table while mobile gets sender cards with sample
  subjects, confidence metrics, category selection, and approve/dismiss actions.
  Focused proof passed 2/2 tests. Evidence: `tmp/triage-mobile-card-tests.log`.
- Settings Xero local polish now covers the connected-state card, skeleton load,
  categorized load-error alert, OAuth start request, and mobile action stacking
  below 768px. Focused proof passed 6/6 tests. Evidence:
  `tmp/xero-connect-responsive-tests.log`.
- Auth mobile polish now covers Login, reset-password, Signup, and the signup
  confirmation state: the screens share reusable responsive auth shell/panel
  classes instead of fixed inline viewport/card styles, labels are associated
  with inputs via `htmlFor`/`id`, and auth-specific mobile CSS applies below
  768px. Focused proof passed 4/4 tests, and a Playwright mobile browser proof
  at 390x844 showed 0 console errors, 0 page errors, no horizontal overflow,
  and a 358px panel inside the 390px viewport on `/login` and `/signup`.
  Because the auth screens are the pre-auth surface, this browser proof is not
  blocked on signed-in credentials. Evidence: `tmp/auth-mobile-tests.log`,
  `tmp/auth-login-mobile.png`, `tmp/auth-signup-mobile.png`,
  `tmp/auth-mobile-browser-proof.json`.
- Onboarding empty states are locally proved for Auto Setup and Triage: no
  organisation selected asks the user to pick one on both pages; Auto Setup
  without a connected Gmail shows the Connect Gmail First card with a working
  `/settings` link and no mining button; Auto Setup with Gmail but zero staged
  entities offers only the initial "1. Run Auto Setup Mining" action (no AI
  classify or triage routes yet); and Triage with zero staged senders shows the
  explanatory empty panel plus the Back to Auto Setup link and no review table.
  Focused proof passed 5/5 tests. Evidence: `tmp/onboarding-empty-tests.log`.
- Onboarding load-error handling is now a real fix, not just polish:
  `useStagedEntities` previously discarded the `error` field from both the
  `staged_entities` select and the `onboarding_progress` RPC, so any load
  failure (RLS block, expired JWT, network) collapsed to an empty list and
  Triage rendered the misleading "No staged senders found yet. Run mailbox
  mining first." empty state — a failure was indistinguishable from a genuinely
  empty inbox. The hook now captures the first query error, clears
  entities/progress, and exposes `error`; Triage renders a categorized
  `formatLoadError('staged senders', …)` alert and suppresses the empty-state
  copy while an error is present. Focused proof passed 11/11 tests across the
  new error suite plus the existing empty/triage suites (RLS classified as an
  access-policy block, JWT classified as auth, and the plain empty state still
  shown when there is genuinely no data and no error). Evidence:
  `tmp/onboarding-error-tests.log`.
- Onboarding mobile is now complete for both onboarding screens. Triage already
  had the desktop-table/mobile-card treatment (`tmp/triage-mobile-card-tests.log`);
  Auto Setup previously relied only on fluid `max-width: 720px` containers and
  `flex-wrap` button rows (mobile-safe from overflow, but the actions did not
  stack for touch). Auto Setup now tags its panel, its mining/AI-classify action
  row, and its triage CTA with responsive classes and a `max-width: 768px`
  breakpoint that collapses the panel to full width and stacks the action
  buttons and triage CTA full width. Focused proof passed 13/13 tests across the
  Auto Setup mobile suite plus the existing onboarding empty/error/triage
  suites. Evidence: `tmp/onboarding-mobile-tests.log`. Remaining proof:
  signed-in mobile screenshot of the populated Auto Setup mining/progress state
  (blocked on auth/test credentials, consistent with the other mobile cells).
- Dashboard P&L mobile had two genuine horizontal-overflow points at 390px, both
  in the P&L header/footer: the Revolut-style account action-pill row
  (Move / Statement / Account details) used `display: flex` with no `flex-wrap`,
  and the real-time P&L formula line (`really_yours = gross_profit -
  gst_set_aside - tax_set_aside`) was a non-wrapping flex row whose `<code>`
  element does not break by default. The KPI/insight grids already collapse via
  `auto-fit minmax(280px)` and the account drawer is full width, so those were
  fine. Both overflow points are now tagged with responsive classes plus a
  `max-width: 768px` breakpoint that wraps the pills to full-width touch targets
  and lets the formula `<code>` wrap. Focused proof passed 10/10 tests
  (8 existing Dashboard tests plus 2 new mobile-layout tests). Evidence:
  `tmp/dashboard-mobile-tests.log`. Remaining proof: signed-in mobile screenshot
  of the populated dashboard (blocked on auth/test credentials).
- Bills list mobile previously relied only on the `.table-premium-container`
  horizontal-scroll fallback for its dense nine-column table — usable but clumsy
  on a 390px screen. It now gets the same desktop-table/mobile-card treatment as
  the other dense lists (Reconciliation, Subscriptions, Triage): a
  `bills-card-view` deck renders one card per bill with supplier (link to
  detail), date/job, non-invoice flag, status, total, confidence, Xero
  status/repush, and a full-width "View document" action, and a
  `max-width: 768px` breakpoint hides the table (`bills-table-view`) and shows
  the card grid. Focused proof passed 6/6 tests (4 existing Bills tests plus 2
  new mobile-layout tests). Evidence: `tmp/bills-mobile-tests.log`. Remaining
  proof: signed-in mobile screenshot of the populated bills list (blocked on
  auth/test credentials).
- Allocations error handling was a real fix, not polish. The queue load path was
  already categorized (`formatLoadError('allocation queue', …)`), but three
  allocation write mutations — reject-suggestion, quick-assign, and bulk-attach —
  discarded the `error` from their `supabase.update()` calls. A failed write
  (RLS, network) silently left the bill in the queue, and the bulk path printed
  "✓ Attached N bills." even when updates failed. All three now capture the
  write error and surface it through a new reusable `formatActionError` helper
  (parallel to `formatLoadError`), and the bulk path reports an honest
  "Attached n of N; M failed." count. Focused proof passed 6/6 tests: the
  Allocations suite now proves a failed reject surfaces a categorized
  access-policy action error instead of failing silently, and the errorMessages
  suite proves `formatActionError` classification. Evidence:
  `tmp/allocations-error-tests.log`.
- Allocations mobile had a real layout break: when the bill PDF preview pane
  opened, the main content section applied `margin-right: 420px` (to make room
  for the fixed 400px side pane), which on a 390px screen shoved the whole queue
  off-screen. The section and pane are now tagged with classes plus a
  `max-width: 768px` breakpoint that clears the content margin
  (`allocations-main`) and full-widths the preview so it overlays instead of
  displacing content (`allocation-preview-pane`). The per-bill cards already
  wrap via flex. Focused proof passed 5/5 tests (preview/load-error/action-error
  plus 2 new mobile tests). Evidence: `tmp/allocations-mobile-tests.log`.
  Remaining proof: signed-in mobile screenshot of the queue with the preview
  open (blocked on auth/test credentials).
- Suppliers error handling: the list load path was already categorized
  (`formatLoadError('suppliers', …)`), but the New supplier create form used the
  load-oriented `formatLoadError('supplier', …)` for an insert failure, so a
  blocked create told the user "Could not load supplier." It now uses the
  reusable `formatActionError('create the supplier', …)` helper, giving the
  correct "Could not create the supplier. …" copy with the same auth/RLS/network
  classification. Focused proof passed 6/6 tests (existing pagination/load-error/
  create-success/cancel tests plus a new failing-create test that proves the
  categorized create action error and no navigation on failure). Evidence:
  `tmp/suppliers-error-tests.log`.
- Suppliers list mobile, like Bills, previously relied only on the
  `.table-premium-container` horizontal-scroll fallback for its seven-column
  table. It now gets the same table-to-card treatment: a `suppliers-card-view`
  deck renders one card per supplier with name (link to detail), email/phone,
  ABN, default account-code badge, and balance-owing / total-spend metrics, and
  a `max-width: 768px` breakpoint hides the table (`suppliers-table-view`) and
  shows the card grid. The shared card CSS is factored so `bill-mobile-card` and
  `supplier-mobile-card` reuse the same grouped rules. Focused proof passed 8/8
  tests (6 existing Suppliers tests plus 2 new mobile-layout tests). Evidence:
  `tmp/suppliers-mobile-tests.log`. Remaining proof: signed-in mobile screenshot
  of the populated suppliers list (blocked on auth/test credentials).
- Customers delete/archive was half-wired: Customer detail already exposed the
  shared `ArchiveButton table="customers"` (soft-deletes via `deleted_at`, and
  the column exists from the initial schema), but `useCustomers` never filtered
  `deleted_at IS NULL`, so an archived customer reappeared in the list — directly
  contradicting the Archive control's "It will be hidden from the active list"
  promise. The list query now filters `deleted_at IS NULL` (matching the Debts
  list pattern), so archive actually hides the row. Focused proof passed 12/12
  tests: a new `useCustomers` hook suite proves the query filters `deleted_at IS
  NULL` and surfaces load errors, alongside the existing Customers page suite.
  Evidence: `tmp/customers-delete-tests.log`. Remaining proof: signed-in
  archive/restore round-trip against live data.
- Customers empty state was a bare one-line sentence with no inline action (the
  only create affordance was the header button). It is now a proper empty state:
  a Users icon, a "No customers yet" heading, refined guidance copy, and an
  inline "Add your first customer" CTA that opens the create form directly.
  Focused proof passed 11/11 tests, including a new test that the empty-state CTA
  opens the New customer form. Evidence: `tmp/customers-empty-tests.log`.
- Customers error handling: the list load was already categorized
  (`formatLoadError('customers', …)`), but the New customer create form surfaced
  insert failures with a raw `error.message` and no `role="alert"`. It now uses
  `formatActionError('create the customer', …)` (same helper as Suppliers) and
  the error region is marked `role="alert"`. Focused proof passed 12/12 tests,
  including a new failing-create test asserting the categorized "Could not create
  the customer…" copy and no navigation on failure. Evidence:
  `tmp/customers-error-tests.log`.
- Customers list mobile, like Bills and Suppliers, previously relied only on the
  `.table-premium-container` horizontal-scroll fallback for its five-column
  table. It now gets the same table-to-card treatment: a `customers-card-view`
  deck renders one card per customer with name (link to detail), email/phone,
  ABN, and billing address, and a `max-width: 768px` breakpoint hides the table
  (`customers-table-view`) and shows the card grid. The shared card CSS now
  groups `bill-`, `supplier-`, and `customer-mobile-card` rules. Focused proof
  passed 14/14 tests (existing Customers tests plus new mobile-layout tests).
  Evidence: `tmp/customers-mobile-tests.log`. Remaining proof: signed-in mobile
  screenshot of the populated customers list (blocked on auth/test credentials).
- Jobs costing pipeline: the Jobs list merges live `v_job_pnl` financials
  (cost_bills/cost_wages/total_cost/revenue/gross_profit, fed upstream by bills
  and timesheets) into each job row, which drives the KPI cards and margin
  charts. Two gaps closed. (1) The `v_job_pnl` query error was silently swallowed
  (`{ data: pnlData }` with no error capture), so a P&L-view failure showed
  all-zero job financials with no signal; `useJobs` now captures it as a
  non-blocking `pnlError` (the job list still renders) and the page shows a
  categorized `formatLoadError('live job P&L', …)` warning that costs/margins may
  be zero until it resolves. (2) The merge itself was untested. A new
  `useJobs` hook suite proves v_job_pnl financials merge into the matching job
  rows, that a P&L failure surfaces `pnlError` without blanking the list (no
  silent zeros), and that a jobs-query failure blanks the list and sets `error`.
  Focused proof passed 8/8 tests across the hook suite and the Jobs page suite.
  Evidence: `tmp/jobs-pipeline-tests.log`. Remaining proof: live data through
  the upstream `v_job_costs`/`v_job_pnl` views (bills + timesheets) against a
  seeded org.
- Jobs error handling: the list load was already categorized
  (`formatLoadError('jobs', …)`), but the New job create form surfaced insert
  failures with a raw `error.message` and no `role="alert"`. It now uses
  `formatActionError('create the job', …)` and marks the alert region. Focused
  proof passed 6/6 tests, including a new failing-create test asserting the
  categorized "Could not create the job…" copy and no navigation on failure.
  While adding the test, a latent test-harness bug surfaced: the `useOrg` mock
  returned a fresh `currentOrg` object per render, so `CreateJobForm`'s
  auto-load `useEffect([currentOrg])` re-ran every render — harmless until a
  null-data response made `custs ?? []` allocate a new array each pass, looping
  to an OOM worker crash. Fixed by giving the mock a stable org reference (also
  hardens the existing Jobs tests). Evidence: `tmp/jobs-error-tests.log`.
- Jobs list mobile, like the other dense lists, previously relied only on the
  `.table-premium-container` horizontal-scroll fallback for its six-column
  table. It now gets the same table-to-card treatment: a `jobs-card-view` deck
  renders one card per job with job number + name (link to detail), status pill,
  created date, and bills-attached / bills-suggested metrics, and a
  `max-width: 768px` breakpoint hides the table (`jobs-table-view`) and shows the
  card grid. The shared card CSS now groups bill/supplier/customer/job rules.
  Focused proof passed 8/8 tests (existing Jobs tests plus new mobile-layout
  tests). Evidence: `tmp/jobs-mobile-tests.log`. Remaining proof: signed-in
  mobile screenshot of the populated jobs list (blocked on auth/test
  credentials).
- Invoices error handling: `useInvoices` captured the load error correctly, but
  the Invoices list rendered the raw `{error}` string (uncategorized, no
  `role="alert"`), unlike the other list pages. It now uses
  `formatLoadError('invoices', error)` in a `role="alert"` region. Focused proof
  passed 3/3 tests, including a new test asserting the categorized "Could not
  load invoices…" copy replaces the bare error string. Evidence:
  `tmp/invoices-error-tests.log`.
- Invoices list mobile, the widest dense list (nine columns), previously relied
  only on the `.table-premium-container` horizontal-scroll fallback. It now gets
  the same table-to-card treatment: an `invoices-card-view` deck renders one card
  per invoice with invoice number (link to detail), customer + job, issued/due
  dates, status pill, and a three-up total/paid/balance metric row, and a
  `max-width: 768px` breakpoint hides the table (`invoices-table-view`) and shows
  the card grid. Focused proof passed 5/5 tests. Evidence:
  `tmp/invoices-mobile-tests.log`. Remaining proof: signed-in mobile screenshot
  of the populated invoices list (blocked on auth/test credentials).
- Bank/Basiq connect pipeline (client half): the callback orchestration in
  `src/pages/BankCallback.tsx` was previously untested and had a real defect —
  `pollForConnection` returned `null` for both a terminal Basiq **job failure**
  and a **timeout**, and the caller showed the same optimistic "Connection is
  still activating on Basiq — check back in 2 minutes" message for both. A failed
  job never resolves via webhook, so the user was told to wait for a connection
  that had already failed. `pollForConnection` now returns a discriminated
  `{ outcome: 'connected' | 'failed' | 'timeout' }`, and the callback surfaces a
  clear "The bank connection failed on Basiq — no accounts were linked" error for
  `failed` (and never runs the exchange step), while keeping the "still
  activating" message only for a genuine `timeout`. Focused proof passed 5/5
  tests covering the whole client pipeline: direct-connectionId → bank-exchange,
  Basiq error param surfaced without any call, jobId → poll-active → exchange,
  job-failed → clear failure (no exchange, no "still activating"), and pending →
  timeout → "still activating". Evidence: `tmp/basiq-pipeline-tests.log`.
  Remaining proof: live Basiq end-to-end (real connection → bank-exchange →
  bank_sync → rows) against the linked project — provider-gated.
- Bank/Basiq connect error handling had the same false-empty-on-error defect plus
  raw action errors. `BankConnect.refresh()` discarded the `.error` from both the
  `bank_connections` and `bank_accounts` queries, so a failed load silently set
  empty arrays and the component fell through to the "+ Connect bank account
  (Basiq)" empty CTA — telling the user no bank is connected when the load
  actually failed. It now captures the query error into a distinct `loadError`,
  renders a categorized `formatLoadError('bank connections', …)` `role="alert"`
  block (instead of the connect CTA), and the connect/sync/disable-feed handlers
  now use `formatActionError('start the bank connection' / 'queue the bank sync'
  / 'disable this bank feed', …)` instead of raw messages (the `BASIQ_API_KEY`
  setup hint still triggers since the raw detail is preserved). Focused proof
  passed 5/5 tests, including a new test that a failed bank-connections load
  shows the categorized alert and hides the connect CTA. Evidence:
  `tmp/basiq-error-tests.log`.
- Bank/Basiq loading + mobile are locally proved, completing the row. Loading:
  `BankConnect` renders an `aria-busy` `SkeletonTable` region while
  `bank_connections`/`bank_accounts` load; a focused test with a never-resolving
  query holds the component in its loading frame and asserts the aria-busy
  skeleton shows (and neither the connect CTA nor an error appears). Mobile:
  `BankConnect` already keeps the desktop `settings-responsive-table` and adds a
  `settings-card-view` bank-connections card deck below the 768px breakpoint,
  proved by the existing "renders bank connections as mobile cards" and
  breakpoint-contract tests. Focused proof passed 6/6 tests. Evidence:
  `tmp/basiq-loading-tests.log`. Remaining proof for the row: live Basiq feed
  end-to-end (provider-gated).
- Scorecard alignment for already-proven mobile cells: several Mobile cells were
  fixed during the earlier responsive-polish pass but the historical scorecard
  was never updated. Re-ran the existing suites (15/15 green) and corrected the
  cells to `3✓`: Bank CSV import (11) and Bank PDF parser (12) mobile via
  `BankImportResponsive.test.tsx` (two-column import forms collapse to one column
  + full-width mobile actions below 768px, `tmp/bank-import-responsive-tests.log`);
  Reconciliation (13) mobile via `Reconciliation.test.tsx`
  (`reconciliation-table-view` → `reconciliation-card-view`,
  `tmp/reconciliation-mobile-card-tests.log`); Settings Gmail (21) mobile via
  `SettingsConnectorResponsive.test.tsx` (Gmail intake card deck); Settings Xero
  (22) mobile via `XeroConnect.test.tsx` (connected-tenant actions stack below
  768px, `tmp/xero-connect-responsive-tests.log`); and Multi-org allocation (25)
  mobile via `AllocationSplitButton.test.tsx` (viewport-safe full-width split
  popover, `tmp/allocation-split-mobile-tests.log`). No code changed — these were
  stale scores, now backed by re-verified green tests.
- Subscriptions error handling: the list load, flag/status updates
  (`Subscriptions.tsx`), the detail load, and the detail save
  (`SubscriptionDetail.tsx`) all surfaced raw `e.message` copy. They now use
  `formatLoadError('subscriptions' / 'this subscription', …)` and
  `formatActionError('update this subscription' / 'set this subscription to …' /
  'save this subscription', …)`, and the list refresh clears stale errors before
  refetching. Focused proof passed 5/5 tests, including a new categorized
  load-error test. Evidence: `tmp/subscriptions-error-tests.log`.
- Debts error handling was a real fix: the Debts list load discarded the `.error`
  from both the `debts` and `debt_payments` queries, so a failed load rendered
  the "No debts tracked yet" empty state — indistinguishable from genuinely
  having no debts. The list now captures the first query error into a
  categorized `formatLoadError('debts', …)` `role="alert"` block (and blanks the
  rows) instead of the false empty state. The add-debt form, debt save, payment
  delete, payment record, and balance update actions also moved from raw
  `e.message` to `formatActionError(…)` copy. Focused proof passed 4/4 tests,
  including a new false-empty-on-error test. Evidence:
  `tmp/debts-error-tests.log`.
- Employees+Timesheets error handling was a real fix: the Employees list load
  discarded the `.error` from all three queries (employees, jobs,
  timesheet_entries), so a failed load rendered the "No employees added yet"
  empty state. The list now captures the first query error into a categorized
  `formatLoadError('employees', …)` `role="alert"` block. The add-employee and
  log-time forms (both on the list page and Employee detail), employee save,
  timesheet update/delete, and leave-balance update/create actions also moved
  from raw `e.message` to `formatActionError(…)` copy, and the Employee detail
  load error is categorized. Focused proof passed 9/9 tests, including a new
  Employees list suite with a false-empty-on-error test. Evidence:
  `tmp/employees-error-tests.log`.
- Reports/BAS error + mobile were closed in one pass. Error: the quarterly
  rollup load error rendered raw (`bas.error.message`) with no reset between
  refreshes; it is now categorized (`formatLoadError('BAS quarters', …)`) in a
  `role="alert"` region and cleared before each refetch. Mobile: the dense
  ten-column BAS table previously relied on horizontal scroll only; it now has a
  `bas-card-view` deck (quarter + FY header, due date with OVERDUE badge, a
  sales/purchases/GST-collected/net-GST metrics grid, and the coverage
  indicator) with a `max-width: 768px` breakpoint swapping table for cards.
  Focused proof passed 9/9 tests (6 existing worksheet/export tests plus 3 new
  mobile/error/breakpoint tests). Evidence: `tmp/bas-error-mobile-tests.log`.
- Settings Org profile error + mobile were closed in one pass across
  `OrgProfile.tsx` and `BusinessProfileForm.tsx`. Error: the org-profile save,
  business-profile load, business-profile save, and auto-detect actions all
  surfaced raw `error.message`; they now use categorized
  `formatLoadError`/`formatActionError` copy. Mobile: the business-profile grid
  used `repeat(2, minmax(280px, 1fr))` — a genuine 560px minimum width that
  overflowed a 390px screen — and the org-profile grids were fixed two-column;
  both now use `business-profile-grid`/`org-profile-grid` classes that collapse
  to one column below 768px. Focused proof passed 4/4 tests (categorized save
  error + responsive-grid breakpoint contract). Evidence:
  `tmp/org-profile-error-mobile-tests.log`.
- Settings Xero Pipeline + Create scorecard cells were stale May-baseline stub
  scores. The July local proof already covers both: Create — `XeroConnect`
  starts `xero-oauth-start` with org/session context and routes callbacks
  through `XeroCallbackPage` (the connection-create entry); Pipeline —
  automation-worker dispatches queued `xero_push`, bill/invoice push bodies and
  idempotency headers are contract-tested, and sync-log GL evidence contracts
  hold. Re-ran the suites fresh: `XeroConnect.test.tsx`,
  `automation-backbone-contract.test.ts`, and
  `accounting-engine-contract.test.ts` passed 34/34. Evidence:
  `tmp/xero-pipeline-rerun.log` (plus the original
  `tmp/xero-local-proof-tests.log`). Remaining proof: real Xero provider
  OAuth/push/sync traces — tracked as the P3 stub-mode/release decision.
- Reports/Cash flow and Quality mobile were closed with the same table-to-card
  treatment. Cash flow: the six-column weekly forecast table gains a
  `cashflow-card-view` deck (week + net header, inflow/outflow/projected-running
  metrics). Quality: the seven-column low-confidence bills table gains a
  `quality-card-view` deck (supplier link, status, invoice/date/total/OCR-engine
  metrics, flagged-issue badges), with the issue-derivation logic extracted into
  a shared `flaggedIssues()` helper so table and cards cannot drift. Both swap at
  the `max-width: 768px` breakpoint. Focused proof passed 8/8 tests. Evidence:
  `tmp/cashflow-quality-mobile-tests.log`.
- Personal/Business split mobile was a stale score: the split's interactive
  surfaces are already mobile-proved. The Subscriptions mobile card test
  explicitly asserts the Biz / Personal / Split classification controls render
  inside each `subscription-mobile-card`; onboarding Triage's personal-category
  selection is proved in its mobile sender cards; and the Bill/Subscription/Debt
  detail split toggles live on fluid single-column detail layouts. Re-ran the
  three suites fresh: 7/7 green. Evidence: `tmp/personal-split-mobile-rerun.log`.
- Bank PDF parser empty state is locally proved: with zero statements selected
  the panel reads "PDF statements (0 selected)" and the Extract & import action
  is disabled (it cannot fire into the parser with nothing chosen), and a
  zero-rows extraction surfaces an explicit "Extracted 0 rows across N pages"
  error rather than silently succeeding. Focused proof passed 4/4 tests.
  Evidence: `tmp/pdf-empty-tests.log`.
- Debts and Employees list mobile got the same table-to-card treatment,
  clearing the final scorecard warnings. Debts: a `debts-card-view` deck renders
  one card per debt (name link, kind/lender/last-4, Personal/Business badge,
  balance/interest/min-payment metrics). Employees: an `employees-card-view`
  deck renders one card per staff member (name link, role/email, active badge,
  base/loaded rate metrics); the recent-timesheets table keeps the standard
  horizontal-scroll container. Subscriptions' stale Mobile score was also
  corrected against its existing card proof. Focused proof passed 8/8 tests.
  Evidence: `tmp/debts-employees-mobile-tests.log`. With this, the historical
  May 6 scorecard has zero remaining ⚠ cells — every cell is ≥3 locally-proven
  or n/a; remaining product risk is tracked as live/signed-in/provider proof,
  not scorecard gaps.
- Bank CSV/PDF import polish now covers the two-column import forms collapsing
  to one column below 768px, full-width import openers/actions on mobile, and
  CSV auth failures displayed as alerts. Focused proof passed 3/3 tests.
  Evidence: `tmp/bank-import-responsive-tests.log`.
- Responsive scorecard alignment reran the existing Settings connector and
  Subscriptions mobile proofs: Gmail intake cards, Bank account cards, and
  subscription cards still pass 5/5 focused tests. Evidence:
  `tmp/settings-subscriptions-responsive-rerun.log`.
- Suppliers now have a local create flow on `/suppliers`: the page exposes a
  New supplier form, inserts normalized supplier contact/account defaults,
  refreshes the list, and navigates to the created supplier detail. Focused
  proof passed 5/5 tests. Evidence: `tmp/suppliers-create-tests.log`.
- Cash Flow now has explicit load-error handling instead of falling through to
  an empty forecast when Supabase blocks or fails the weekly flow/bank balance
  queries. Focused proof passed 2/2 tests. Evidence:
  `tmp/cash-flow-error-tests.log`.
- Multi-org scorecard alignment reran the existing `MoveToOrgButton` proof:
  bill/invoice/job/customer/supplier/subscription/debt detail surfaces render
  the shared move control, and the component proves target filtering, FK
  clearing, update payloads, debt moves, and single-org hiding. Focused proof
  passed 7/7 tests. Evidence: `tmp/move-to-org-rerun.log`.
- Employee archive is now locally proved on Employee detail: the shared
  `ArchiveButton` supports `employees`, archives by setting `deleted_at`,
  navigates back to `/employees`, and remains covered by the existing employee
  detail tests. Focused proof passed 9/9 tests. Evidence:
  `tmp/employee-archive-tests.log`.
- Debt archive is now locally proved with a schema migration:
  `20260702131500_debts_soft_delete.sql` adds `debts.deleted_at`, Debts list
  filters active rows with `.is('deleted_at', null)`, and Debt detail archives
  through the shared `ArchiveButton`. Focused proof passed 7/7 tests. Evidence:
  `tmp/debt-archive-tests.log`. Remaining proof: apply the migration live and
  archive/restore a signed-in debt row.
- Debt pipeline is locally fixed and proved: `20260702134000_expand_debt_kind_enum.sql`
  aligns the DB enum with the current Debt UI options, and
  `20260702134500_bank_accounts_to_debts_pipeline.sql` adds an indexed
  trigger/backfill path from active `bank_accounts` with `account_type` of
  `credit_card` or `loan` into reviewed `debts` rows linked by
  `bank_account_id`. Focused proof passed 5/5 tests. Evidence:
  `tmp/debt-bank-account-pipeline-tests.log`. Remaining proof: live migration
  application, then import/sync a real or seeded credit-card/loan bank account
  and verify the resulting debt row.
- Xero scorecard status is corrected from the stale early stub state:
  `xero-oauth-start`, `xero-oauth-callback`, `xero-push-bill`,
  `xero-push-invoice`, `xero-sync-accounts`, and `xero-sync-payments` exist
  locally; Settings starts OAuth; automation-worker dispatches queued
  `xero_push`; and sync-log/idempotency contracts are tested. Focused proof
  passed 34 tests with 9 live-DB integration tests skipped. Evidence:
  `tmp/xero-local-proof-tests.log`. Remaining proof: real Xero provider OAuth,
  push, account sync, and payment sync traces.
- Multi-org allocation mobile is no longer a broken/stub state locally:
  `AllocationSplitButton` now uses a responsive popover that is viewport-safe on
  mobile and full-width for split actions below 768px. Focused proof passed 1/1.
  Evidence: `tmp/allocation-split-mobile-tests.log`. Remaining proof:
  signed-in mobile screenshots on the Bill, Reconciliation, and Subscription
  surfaces that host the split control.
- Customer pipeline is locally proved through onboarding Triage: approving a
  staged customer sender upserts a `customers` row, inserts an `intake_rules`
  sender-domain rule with `customer_id`, marks the staged entity approved, and
  links `resolved_customer_id`. Focused proof passed 3/3 tests. Evidence:
  `tmp/triage-customer-pipeline-tests.log`. Remaining proof: signed-in browser
  completion of the 399 pending staged entities into live `intake_rules`.
- Employee timesheet pipeline is locally fixed and proved: the UI writes current
  `timesheet_entries`, and `20260702133000_timesheet_entries_job_pnl.sql` now
  feeds active `timesheet_entries` into `v_job_costs` as `wages`, which flows
  into `v_job_pnl.cost_wages_cents`. The period-lock trigger contract now also
  covers `timesheet_entries`. Focused proof passed 11/11 tests. Evidence:
  `tmp/employee-timesheet-pipeline-tests.log`. Remaining proof: live migration
  application and signed-in timesheet rows visible in `v_job_pnl`.
- Employee multi-org move is locally proved with a payroll-safe RPC:
  `20260702135000_move_employee_to_org.sql` moves the employee plus current
  `timesheet_entries`, legacy `wage_entries`, `leave_balances`, and
  `pay_schedules` to the target org, clears org-scoped job links, and blocks the
  move once `pay_slips` or `super_batch_lines` exist. Employee Detail now calls
  that RPC through `EmployeeMoveToOrgButton`. Focused proof passed 11/11 tests.
  Evidence: `tmp/employee-move-org-tests.log`. Remaining proof: live migration
  application and signed-in two-org employee move against a fixture without
  payroll history.
- Basiq connection detail and local disable are locally proved: Bank settings
  now fetches linked `bank_accounts`, renders account name/type/BSB/last-four,
  balance, available balance, primary/active status in desktop and mobile
  layouts, and exposes a `Disable feed` action that sets the connection to
  `revoked` and marks linked accounts inactive. `bank-sync` already selects only
  active Basiq connections, so the local disable path removes the feed from
  future syncs without deleting historical transactions. Focused proof passed
  4/4 tests. Evidence: `tmp/basiq-detail-disable-tests.log`. Remaining proof:
  signed-in browser proof against a real connected feed and any provider-side
  Basiq revocation/re-consent trace required for release.

Known exclusions from this percentage: live Supabase deploy/proof gates, real
Basiq/Xero/Gmail data traces, ATO/SBR lodgement, legal declarations, money
release, and product UI proof remain separate proof, integration, or
human/legal gates.

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
  hardened legal table grants. The corpus now has all six registered official
  FRL Acts live-proven with embeddings and search proof; Legal Horizon still
  needs a real scanner run with valid scanner secret, and Ask still needs a
  signed-in proof that a real answer returns corpus `citations[]`.
- **Legal RAG seed proof:** a fresh source-material/secret check on 2026-06-29
  found no local NotebookLM/legal source text bundle. The linked project now has
  `OPENAI_API_KEY` and `LEGAL_SYNC_SECRET` configured. At that 2026-06-29
  checkpoint it still did not have `LEGAL_INGEST_SECRET` or
  `LEGAL_SCAN_SECRET` configured by those names; that specific secret gap was
  fixed on 2026-07-02 and is recorded in the July addendum above. The
  scanner provider key is present. The `legal-corpus-sync` FRL fetch path now
  resolves official `/latest/text` EPUB HTML documents, strips markup/table of
  sections noise, and extracts compilation-date/version metadata; a local
  live-source proof against the current ITAA 1997 FRL page produced 5,956
  chunks and found `s 8-1 General deductions`. The updated bundle is deployed as
  `legal-corpus-sync` version 23, with `legal-corpus-ingest` active as version
  24, and supports resumable `chunk_offset`/`chunk_limit`
  processing for large Acts. The live FBT sync returned HTTP 200 with
  `chunks=391`, `inserted=385`, `unchanged=6`, and all 391 current FBT corpus
  rows have embeddings. The live GST sync completed across 14 windows:
  `processed=1042`, `inserted=365`, `unchanged=677`, with all 1,042 current GST
  corpus rows embedded. The SIS Act has 798 current embedded rows, ITAA 1936
  has 1,334, TAA 1953 has 1,692, and ITAA 1997 has 6,183. `match_legal_corpus`
  returned the expected section at similarity `1.0000` for FBT `s 47 [1]`, GST
  `s 9-5`, SIS `s 62`, ITAA 1936 `s 109N`, TAA `s 284-75`, and ITAA 1997
  `s 8-1`. The TAA source URL was corrected by `0198_fix_taa_legal_source_url`
  from a dead FRL title shell to the principal `C1953A00001` series, and the
  shared upsert now pages current corpus rows past PostgREST's 1,000-row cap so
  large-source resume does not duplicate existing sections. The generic ATO
  legal database landing page
  remains unsuitable for scheduled sync and is now refused until a specific ATO
  document URL, feed URL, or provided-text path is used intentionally.
- **Repeatable live blocker audit:** `npm run wrap:live-audit` now checks the
  linked project without printing secret values or Supabase secret digests. On
  2026-06-29 it passed: `advisor`, `receipt-webhook`, `legal-corpus-sync`, and
  `gmail-pubsub-push` returned CORS-capable OPTIONS 200; selected functions
  including Advisor, Receipt Hub, Legal Corpus, Legal Horizon, Gmail Pub/Sub,
  and Xero push/sync paths were active; live secret-name presence was true for
  `PERPLEXITY_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GMAIL_CLIENT_ID`,
  `GMAIL_CLIENT_SECRET`, `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_VERIFY_TOKEN`, and
  `GMAIL_WATCH_RENEW_CRON_SECRET`, `BANK_SYNC_ALL_CRON_SECRET`,
  `NOTIFICATIONS_CRON_SECRET`, `ACCOUNTANT_SESSION_DIGEST_CRON_SECRET`, and
  `OPENAI_API_KEY` and `LEGAL_SYNC_SECRET`, and false for
  `LEGAL_INGEST_SECRET` and `LEGAL_SCAN_SECRET` at that date. The July 2
  readiness remediation now reports those two legal Edge secrets present. The
  signed-in Advisor and Receipt Hub smoke tests remain locally unrunnable until
  `SUPABASE_SERVICE_ROLE_KEY`, `TEST_USER_JWT`, and `TEST_ORG_ID` are supplied
  to the test environment.
- **Gmail Pub/Sub:** the May 6 "handler stub" finding is no longer current.
  `gmail-pubsub-push` now replays Gmail history deltas, downloads accepted
  invoice attachments, applies intake rules, creates `bills`, dispatches
  `bills-extract`, shares a Gmail message-id duplicate guard with backfill, and
  only advances `last_history_id` after the delta is durably handled. Focused
  Deno tests cover the duplicate guard and retryable-ingest classification, the
  touched Edge modules pass `deno check`, and the hardened function is active
  live as version 48. The live audit also proves the public push endpoint fails
  closed with HTTP 401 when called without `GMAIL_PUSH_VERIFY_TOKEN`.
- **Bank/notification cron auth:** the May 6/June ledger finding that cron
  functions trusted an unverified JWT payload for `role=service_role` is fixed
  live. A shared exact-match auth helper now gates service-role bearer and cron
  secrets, with focused Deno tests proving forged JWT rejection. `bank-sync` is
  active as version 43, `bank-sync-all` as version 41, and
  `notifications-cron` as version 38. The live audit proves forged
  `bank-sync` service-role JWT returns HTTP 401, unsigned `bank-sync-all` and
  `notifications-cron` return HTTP 403, both cron secret names exist in
  Supabase, and the functions are active. `bank-sync-all` was also rescheduled
  from the old no-auth cron to active cron job 14, which reads a scoped secret
  from Supabase Vault; direct and DB-side `pg_net` probes returned HTTP 200 with
  `ok=true`, `orgs=0`.
- **Accountant digest cron auth:** the prior 10-minute 401 loop is fixed live.
  `accountant-session-digest` is active as version 33 with `verify_jwt=false`;
  cron mode now requires exact `ACCOUNTANT_SESSION_DIGEST_CRON_SECRET` or
  service-role bearer, while browser/on-demand modes still verify the caller JWT
  inside the function before reading sessions or activity. The live audit proves
  unsigned cron-mode POST returns HTTP 403 and the scoped secret name exists in
  Supabase. The live cron was rescheduled to active job 15, which reads a scoped
  secret from Supabase Vault; a DB-side `pg_net` probe returned HTTP 200 with
  `ok=true`, `sent=0`, `failed=0`. The first scheduled post-fix run at
  `2026-06-28T20:00:00Z` also returned HTTP 200 with `sent=0`, `failed=0`.
  A fresh `cron_health_summary()` query at `2026-06-28T20:19:13Z` showed
  `http_failures_24h=41` (`401=35`, `403=6`) from historical failures while
  current cron `last_run_pg_status` values were succeeding where jobs had fired;
  clean-window cron health remains a separate follow-up until that 24-hour
  window ages out.
- **Core cron registration:** the live `bank-sync-all`,
  `notifications-cron-nightly`, and `accountant-digest-cron` schedules are now
  tracked by `0197_track_vault_backed_cron_schedules.sql`. `NOTIFICATIONS_CRON_SECRET`
  was rotated into a fresh scoped value stored in both Edge Function secrets and
  Supabase Vault as `notifications_cron_secret`. Live verification shows all
  three core cron commands are active, use `vault.decrypted_secrets`, use a
  `secret=` parameter, and contain no `<...>` placeholders. Version `0197` is
  recorded in `supabase_migrations.schema_migrations`; the CLI
  `supabase migration list --linked` path remains unavailable locally without
  `SUPABASE_DB_PASSWORD`.
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
- **Fresh live blocker counts:** `legal_sources=7`, `legal_corpus=11440`,
  `legal_change_events=10757`, `legal_horizon=0`, `advice_notes=1`,
  `receipt_events=0`, enabled `receipt_sync_endpoints=0`, and enabled
  `xero_integrations=0`. A focused Receipt Hub check also found
  `receipt_identities=3` and `receipt_sync_jobs=0`; the receipt sync drain cron
  is active, but there is no live receipt chain data yet. The one advice note is
  a `structuring` draft created 2026-06-28; without a signed-in Ask/browser
  trace, it narrows but does not complete the advisor workflow proof.
- **Stale P1 corrections from repo inspection:** the original May 6 P1 list
  still contains several items that are now code-complete. `/customers` has a
  New customer flow, `/jobs` has a New job flow, Triage has bulk
  high-confidence approval/dismissal controls, bill detail has inline edit/save,
  `MoveToOrgButton` is wired on the bill/invoice/job/customer/supplier detail
  pages, and subscription, debt/payment, and employee detail pages exist. These
  still need normal release proof where they touch UI or live data, but they
  should no longer drive rebuild work.
- **Tenant-isolation gate correction:** the May 6 audit item that described
  `tests/tenant-isolation.test.ts` as an inert `describe.skip` is now stale.
  The suite self-seeds two orgs, signs in through anon-key clients, asserts
  cross-tenant invisibility, and `.github/workflows/ci.yml` runs it as a
  dedicated deploy-blocker job. Local no-secret verification on 2026-06-29
  skipped 1 file / 6 tests by design; in CI the test throws before collection if
  the required Supabase env is missing.
- **Local UX proof added:** Dashboard now has a pending onboarding-triage CTA
  backed by a progress-only `onboarding_progress` hook, and OrgProfile has a
  focused component test proving ABN plus `organizations.settings` are written
  back on save. Debt detail now has focused proof for `debt_payments` insert
  payloads plus principal balance reduction, and subscription detail has focused
  proof for status/cadence/notes/personal-classification save payloads. Employee
  detail now has focused proof for inline timesheet updates and new log-time
  inserts, and `MoveToOrgButton` now has focused proof for exact cross-org update
  payloads including FK clearing. Focused tests passed for `OrgProfile.test.tsx`,
  `Dashboard.test.tsx`, `DebtDetail.test.tsx`, `SubscriptionDetail.test.tsx`,
  `EmployeeDetail.test.tsx`, and `MoveToOrgButton.test.tsx` on 2026-06-29; full
  `npm run test` then passed at 36 passed / 16 skipped files and 171 passed / 33
  skipped tests. `npm run build` also passed with the known pdfjs dynamic-import
  and large chunk warnings.
- **Local browser proof added:** `npm run wrap:visual-smoke` now mounts the
  changed local UX surfaces in a deterministic Chromium harness, performs the
  Dashboard triage, OrgProfile save, debt payment, subscription edit, employee
  timesheet/log-time, and multi-org move interactions, and captures screenshots
  under
  `.claude/scratch/wrap-up-local-visual-smoke/2026-06-28T19-21-08-902Z/screenshots/`.
  The run returned all checks true with no browser console or page errors. This
  is local mocked browser proof; signed-in production/browser proof remains
  separate.

## TL;DR

**Current July status:** local source-contract automation wiring is **63 / 63
connected strings (100%)** and evidence-based production readiness is **~85%**.
The old May 6 "code ~70%" statement is superseded by the July addendum above.
The remaining work is concentrated in production activation/proof, signed-in
browser proof, external-provider proof, mobile/polish, and real-data starvation:

- **Real polish:** mobile, pagination, error specificity, export, edit-modes on a few detail pages.
- **External integrations:** Xero bidirectional sync and real-provider proof remain. Basiq Connect callback implementation is no longer the gap: `BankCallback.tsx` handles both `connectionId` and async `jobId`, `bank-job-poll` resolves active connections, and `bank-exchange` queues durable `bank_sync` jobs for the initial transaction pull. Gmail Pub/Sub is now code-complete/live-deployed but still needs a real watched-mailbox event trace before being called end-to-end live-proven. `bank-sync-all` cron auth/scheduling is live-proven, but real bank-feed proof still needs a Basiq feed with transaction backfill.
- **Critical onboarding gaps:** Create-Customer and Create-Job are no longer
  missing; the remaining onboarding gap is guided first-invoice/first-customer
  empty-state flow and signed-in proof that a new user can get from onboarding
  through customer, job, invoice, and payment without SQL.

**Historical May 6 data snapshot: ~10% populated.** Treat the row counts below
as a historical starvation snapshot until live DB access is fixed and the counts
are rerun. The pattern still matters: much of what looked broken was starvation,
not breakage.

- 0 customers, 0 invoices, 0 employees, 0 debts, 0 timesheets, 0 subscriptions, 0 bills marked personal
- 449 staged entities classified by AI but **399 still pending triage** (user hasn't clicked through Triage to create intake_rules)
- 150 bills ingested but only 5 have totals (Gmail mining sweeping up non-bill emails)

The "subscriptions empty" complaint is correct: detection ran, but only 5 bank txns × 1 month is too sparse for a recurring pattern. **The fix is the 7 PDF statements you have queued — once they import, detection will fire and populate.**

---

## Historical May 6 Scorecard - Not Current Overall Readiness

This scorecard is retained as the original May 6 product/UI baseline. Do not
use the **72%** below as the current July completion estimate. Current July
status is summarized at the top of this file: **~85% production readiness** and
**63 / 63 local source-contract automation strings connected**.

Score: 0=missing, 1=stub, 2=partial, 3=working, 4=polished. Cells with `—` are not applicable. ✓ ≥3, ⚠ =2, ✗ ≤1.

| Module                           | Schema | Pipeline | List | Detail | Create | Edit | Del | Multi-org | Empty | Error | Loading | Mobile |
| -------------------------------- | ------ | -------- | ---- | ------ | ------ | ---- | --- | --------- | ----- | ----- | ------- | ------ |
| 1. Auth                          | 4✓     | —        | 4✓   | —      | 4✓     | —    | —   | —         | 3✓    | 3✓    | 3✓      | 3✓     |
| 2. Onboarding (AutoSetup+Triage) | 3✓     | 3✓       | 3✓   | 3✓     | —      | —    | —   | 3✓        | 3✓    | 3✓    | 3✓      | 3✓     |
| 3. Dashboard P&L                 | 4✓     | 4✓       | —    | —      | —      | —    | —   | 3✓        | 3✓    | 3✓    | 3✓      | 3✓     |
| 4. Bills                         | 4✓     | 4✓       | 4✓   | 4✓     | 4✓     | 3✓   | 3✓  | 4✓        | 3✓    | 3✓    | 4✓      | 3✓     |
| 5. Allocations                   | 4✓     | 4✓       | 4✓   | —      | —      | —    | —   | —         | 3✓    | 3✓    | 3✓      | 3✓     |
| 6. Suppliers                     | 4✓     | 4✓       | 4✓   | 4✓     | 3✓     | 4✓   | 3✓  | 3✓        | 3✓    | 3✓    | 3✓      | 3✓     |
| 7. Customers                     | 4✓     | 3✓       | 4✓   | 4✓     | 3✓     | 4✓   | 3✓  | 3✓        | 3✓    | 3✓    | 3✓      | 3✓     |
| 8. Jobs                          | 4✓     | 3✓       | 4✓   | 4✓     | 3✓     | 4✓   | 3✓  | 3✓        | 3✓    | 3✓    | 3✓      | 3✓     |
| 9. Invoices                      | 4✓     | 4✓       | 4✓   | 4✓     | 4✓     | 4✓   | 3✓  | 3✓        | 3✓    | 3✓    | 3✓      | 3✓     |
| 10. Bank — Basiq Connect         | 4✓     | 3✓       | 3✓   | 3✓     | 3✓     | —    | 3✓  | —         | 3✓    | 3✓    | 3✓      | 3✓     |
| 11. Bank — CSV import            | 4✓     | 4✓       | 3✓   | —      | 4✓     | —    | —   | —         | 3✓    | 3✓    | 3✓      | 3✓     |
| 12. Bank — PDF parser            | 4✓     | 3✓       | 3✓   | —      | 4✓     | —    | —   | —         | 3✓    | 3✓    | 3✓      | 3✓     |
| 13. Bank — Reconciliation        | 4✓     | 3✓       | 4✓   | —      | —      | —    | —   | —         | 3✓    | 3✓    | 3✓      | 3✓     |
| 14. Bank — Subscription detect   | 4✓     | 4✓       | —    | —      | —      | —    | —   | —         | 3✓    | 3✓    | 3✓      | —      |
| 15. Subscriptions                | 4✓     | 4✓       | 4✓   | 3✓     | —      | 3✓   | 3✓  | 4✓        | 3✓    | 3✓    | 3✓      | 3✓     |
| 16. Debts                        | 4✓     | 3✓       | 4✓   | 3✓     | 4✓     | 3✓   | 3✓  | 3✓        | 3✓    | 3✓    | 3✓      | 3✓     |
| 17. Employees+Timesheets         | 4✓     | 3✓       | 4✓   | 3✓     | 4✓     | 3✓   | 3✓  | 3✓        | 3✓    | 3✓    | 3✓      | 3✓     |
| 18. Reports — BAS                | 4✓     | 4✓       | 4✓   | —      | —      | —    | —   | —         | 3✓    | 3✓    | 3✓      | 3✓     |
| 19. Reports — Cash flow          | 4✓     | 4✓       | 4✓   | —      | —      | —    | —   | —         | 3✓    | 3✓    | 3✓      | 3✓     |
| 20. Settings — Org profile       | 4✓     | 3✓       | —    | 3✓     | 4✓     | 4✓   | —   | —         | —     | 3✓    | 3✓      | 3✓     |
| 21. Settings — Gmail             | 3✓     | 4✓       | 3✓   | —      | 4✓     | —    | 3✓  | —         | 3✓    | 3✓    | 3✓      | 3✓     |
| 22. Settings — Xero              | 3✓     | 3✓       | —    | —      | 3✓     | —    | —   | —         | —     | 3✓    | 3✓      | 3✓     |
| 23. Quality                      | 4✓     | 4✓       | 4✓   | —      | —      | —    | —   | —         | 4✓    | 3✓    | 3✓      | 3✓     |
| 24. Personal/Business split      | 4✓     | 3✓       | —    | 4✓     | —      | 4✓   | —   | —         | —     | 3✓    | —       | 3✓     |
| 25. Multi-org allocation         | 4✓     | 3✓       | —    | 4✓     | —      | —    | —   | 4✓        | —     | 3✓    | —       | 3✓     |

**Historical May 6 average score across cells with content:** ~2.9 / 4 =
**72% complete for this old product/UI scorecard only**.

---

## Historical May 6 Pipeline Trace Results (Phase D)

| Flow                                         | Result         | Evidence                                                                                                                              |
| -------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Email → Bill → Supplier auto-link**        | ✅ working     | 150 bills ingested; supplier-autolink trigger created 9 suppliers; 14 bills got supplier_id linked                                    |
| **Bills extract → suggested_job**            | ✅ working     | 22 bills have job_id from suggestions, all attached to J0001                                                                          |
| **gmail-mine → AI classify → Triage**        | ⚠ user-blocked | 449 staged_entities exist + classified; **399 still pending** because user hasn't run through Triage. Code works; user behaviour gap. |
| **Bank txn → Reconciliation candidates**     | ⚠ no data      | View `v_bank_match_candidates` exists; 0 matches because no real bills have totals matching the 5 fake txns                           |
| **Bank txn → subscriptions-detect**          | ⚠ no data      | Edge fn deployed; runs after every bank-sync/CSV/PDF; 0 subs detected because only 5 debit txns total (need ≥3 of same merchant)      |
| **Bill marked personal → excluded from BAS** | ⚠ untested     | View filters on `is_personal=false`; 0 bills tagged personal so excluded but not exercised                                            |
| **MoveToOrgButton → row moved**              | ⚠ live-blocked | Local component proof covers update payloads, FK clearing, and debt-row moves; live proof still needs a signed-in user with 2 orgs.   |
| **Timesheet entry → v_job_pnl wages**        | ✅ locally fixed / ⚠ live no data | Employee detail tests cover timesheet edit/log-time payloads; migration `20260702133000_timesheet_entries_job_pnl.sql` wires `timesheet_entries` into `v_job_costs`/`v_job_pnl`; live proof still needs migration apply and real rows. |
| **PDF statement → bank txns + subs**         | ⚠ user-blocked | Pipeline deployed; user hasn't uploaded the 7 queued PDFs                                                                             |

---

## Historical May 6 Database State (Phase C)

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

Historical May 6 list, kept for context. Current wrap-up work should use the
2026-06-29 addendum and `docs/WRAP_UP_COMPLETION_PLAN.md` before treating any
item below as still missing.

Ordered by original user-visible value:

1. **Resolved 2026-06-29: "+ New customer" button on `/customers`** — `src/pages/Customers.tsx` now exposes a New customer flow, and `src/test/pages/Customers.test.tsx` covers the button, form opening, submit path, and cancel path. Remaining proof: signed-in browser flow against live data.
2. **Resolved 2026-06-29; locally proved 2026-07-02: "+ New job" button on `/jobs`** — `src/pages/Jobs.tsx` exposes a New job flow, and `src/test/pages/Jobs.test.tsx` now proves the button, form opening, next-job-number generation, insert payload, refresh/navigation, and cancel path. Remaining proof: signed-in browser flow against live data.
3. **Resolved 2026-06-29: Triage discoverability/bulk controls** — Dashboard now links directly to `/onboarding/triage` through the progress-only `onboarding_progress` hook, and Triage has bulk approval/dismissal controls for high-confidence AI/Sonar picks. Remaining proof: signed-in browser run with live staged entities.
4. **Resolved 2026-06-29; locally proved 2026-07-02: bill detail Edit mode** — `src/pages/BillDetail.tsx` supports inline edit/save for supplier, ABN, invoice number, invoice/due dates, totals, GST share, job reference, and notes. `src/test/pages/BillDetail.test.tsx` now proves the normalized `bills` update payload plus correction feedback capture. Remaining proof: signed-in browser edit against a live bill.
5. **Resolved 2026-06-29: org settings write-through** — `src/components/settings/OrgProfile.tsx` saves ABN and `organizations.settings`, and `src/test/components/OrgProfile.test.tsx` proves the update payload. Remaining proof: signed-in settings save against the live org.
6. **Reconciliation invoice-side** — resolved 2026-06-29. The UI matches bank inflows to invoices, caps settlement at `min(bank inflow, invoice balance)`, and `0196_harden_invoice_reconciliation.sql` hardens the RPC, payment validator, AR grants, triggers, and security-invoker match view. Remaining proof: run a signed-in live invoice/payment smoke with real AR data.
7. **Resolved 2026-06-29: MoveToOrgButton wiring** — the move control is wired on bill, invoice, job, customer, supplier, subscription, and debt detail surfaces. `src/test/components/MoveToOrgButton.test.tsx` proves the update payload, FK clearing, and debt-row move behavior. Remaining proof: signed-in browser move with at least two live orgs.
8. **Resolved 2026-06-29: Subscription detail page** — `/subscriptions/:id` exists and supports detail editing; `src/test/pages/SubscriptionDetail.test.tsx` proves status, cadence, notes, and personal/business classification saves. Remaining proof: signed-in browser edit against live subscription data.
9. **Resolved 2026-06-29: Debt detail/payment recording** — debt detail now records payments; `src/test/pages/DebtDetail.test.tsx` proves the `debt_payments` insert payload and principal balance reduction. Remaining proof: signed-in browser payment against live debt data.
10. **Resolved 2026-06-29: Employee detail/timesheet edit** — employee detail now supports inline timesheet edits and new log-time entries; `src/test/pages/EmployeeDetail.test.tsx` proves cost recomputation, loaded rate, job, entry type, notes, and org/employee IDs. Remaining proof: signed-in browser edit against live employee/timesheet data.
11. **Resolved locally: Basiq Connect callback path** — `bank-link-token` mints, `BankCallback.tsx` handles direct `connectionId` and async `jobId` callback paths, `bank-job-poll` resolves active Basiq connections, and `bank-exchange` queues a durable `bank_sync` automation job for initial transaction backfill instead of fire-and-forget HTTP. Focused proof: `tests/automation-backbone-contract.test.ts` passed 20/20 and includes `bank exchange queues initial sync jobs instead of fire-and-forget HTTP`. Remaining proof: real Basiq provider callback + transaction backfill in a signed-in browser/live project.
12. **gmail-pubsub-push handler is a stub** — resolved 2026-06-29. The live
    version 48 handler replays Gmail history deltas, creates bill rows for
    accepted attachments, dispatches extraction, fails closed without the push
    token, dedupes Gmail message IDs across push/backfill overlap, and leaves
    `last_history_id` unchanged on retryable ingest failures so a later push can
    replay safely. Remaining proof: capture a real watched-mailbox Pub/Sub
    event trace against live Gmail.
13. **Resolved locally: Xero OAuth entry point wired in Settings** — `SettingsPage` renders `XeroConnect`, which starts `xero-oauth-start`, stores the returned OAuth state for CSRF validation, and routes callbacks through `XeroCallbackPage` to `xero-oauth-callback`. Focused proof: `src/test/components/XeroConnect.test.tsx` passed 2/2. Remaining proof: signed-in live Xero OAuth run or accepted stub-mode provider proof; decide whether full bidirectional Xero sync is release-blocking.
14. **Resolved locally 2026-07-02: "+ New supplier" button on `/suppliers`** — `src/pages/Suppliers.tsx` now exposes a New supplier flow, and `src/test/pages/Suppliers.test.tsx` proves the button, form opening, normalized insert payload, refresh/navigation, and cancel path. Remaining proof: signed-in browser flow against live data.

---

## Gaps — P2 (missing polish)

Ordered roughly by frequency-of-friction:

- **Partially stale: global mobile shell is locally proved** — the app shell now
  uses a compact desktop rail, mobile drawer below the 768px breakpoint, hides
  the timeline rail on mobile, and `.table-premium-container` provides
  horizontal table scroll. Bank CSV/PDF imports, Subscriptions, Settings Gmail
  intake, Settings Bank accounts, Settings Xero, Reconciliation recently
  matched rows, and Onboarding Triage staged senders now have local mobile card
  or form layouts. Focused proof:
  `src/test/components/LayoutResponsive.test.tsx`,
  `src/test/components/BankImportResponsive.test.tsx`,
  `src/test/pages/Subscriptions.test.tsx`,
  `src/test/components/SettingsConnectorResponsive.test.tsx`,
  `src/test/pages/Reconciliation.test.tsx`,
  `src/test/components/XeroConnect.test.tsx`, and
  `src/test/pages/Triage.test.tsx` passed. Remaining work:
  page-by-page signed-in mobile screenshots and card/table polish for the rest
  of the dense operational screens.
- **Resolved locally 2026-07-02: Bills/Invoices/Suppliers pagination controls** — the hooks already used `.range(...)`; the missing piece was page controls. `BillsPage`, `InvoicesPage`, and `SuppliersPage` now expose load-more controls backed by `hasMore/loadMore/loadingMore`, and the table remains visible while the next page loads. Focused proof: `src/test/pages/Bills.test.tsx`, `src/test/pages/Invoices.test.tsx`, and `src/test/pages/Suppliers.test.tsx` passed 8/8. Remaining proof: signed-in live run against a table with more than one page of rows.
- **Resolved locally 2026-07-02: passive loading states** —
  `DetailPageSkeleton` now replaces plain loading text on Bill, Invoice,
  Customer, Job, Employee, Debt, Subscription, Supplier, and Pay Run detail
  pages. A second pass also moved business/org profile, bank/Gmail/Xero
  connector panels, connector API keys, onboarding triage, activity sessions,
  team members, approvals, Legal Horizon, Tax Return draft, and Quality
  duplicate checks onto skeleton primitives. A final long-tail pass moved
  document preview, bank coding queue, allocation split popover, Audit Log
  correspondence/drafts/events, Payroll super batch, BAS worksheet, Settings
  automation policies, org selector, and Bill Detail preview/history onto
  skeleton primitives. Focused proof:
  `src/test/components/Skeleton.test.tsx`,
  `src/test/components/LongTailLoadingSkeletons.test.tsx`,
  `src/test/components/XeroConnect.test.tsx`,
  `src/test/components/OrgProfile.test.tsx`,
  `src/test/components/ConnectorApiKeys.test.tsx`,
  `src/test/pages/LegalHorizon.test.tsx`,
  `src/test/pages/TaxReturn.test.tsx`, `src/test/pages/Quality.test.tsx`,
  `src/test/pages/Bas.test.tsx`, `src/test/pages/Payroll.test.tsx`,
  `src/test/pages/BillDetail.test.tsx`,
  `src/test/lib/loadingStateCoverage.test.ts`, and the original core detail
  tests passed. Remaining proof: signed-in browser screenshots. Remaining
  design follow-up: button labels such as "Loading more" and spinner-labelled
  workflow states such as Receipt Hub can remain text-plus-spinner unless a
  separate visual redesign says otherwise.
- **Resolved locally 2026-07-02: audited load errors are categorized** —
  `formatLoadError` now distinguishes auth/permission, row-level-security,
  network, validation, and database failures and is wired through the audited
  high-traffic and secondary surfaces: Customers, Jobs, Suppliers, Allocations,
  Dashboard, Coding Review, Fixed Assets, Payment Runs, Quality, SMSF, Trusts,
  CGT events, registrations, and the allocation queue. Focused proof:
  `src/test/lib/errorMessages.test.ts`,
  `src/test/lib/loadErrorCopyCoverage.test.ts`,
  `src/test/pages/Customers.test.tsx`, `src/test/pages/Jobs.test.tsx`,
  `src/test/pages/Suppliers.test.tsx`, `src/test/pages/Allocations.test.tsx`,
  `src/test/pages/Dashboard.test.tsx`, `src/test/pages/Quality.test.tsx`,
  `src/test/pages/PaymentRuns.test.tsx`, and
  `src/test/components/CgtEventsPanel.test.tsx` passed 37/37. Remaining proof:
  signed-in browser/live Supabase error-state screenshots for real failures.
- **Resolved locally 2026-07-02: archive/restore UI for supported detail records** — `ArchiveButton` toggles `deleted_at` for `suppliers`, `customers`, `jobs`, `bills`, `invoices`, `subscriptions`, `employees`, and `debts`. Customer/Supplier already had it; Bill, Invoice, Job, Subscription, Employee, and Debt detail pages now expose it too. Focused proof: `src/test/components/ArchiveButton.test.tsx` proves archive and restore update payloads, `src/test/pages/SubscriptionDetail.test.tsx` proves subscription archive, `src/test/pages/EmployeeDetail.test.tsx` proves employee archive, and `src/test/pages/DebtDetail.test.tsx` plus `src/test/pages/Debts.test.tsx` prove debt archive/list filtering. Remaining proof: signed-in browser archive/restore against live rows and live application of the new debt soft-delete migration.
- **Partially resolved locally 2026-07-02: report exports** — BAS and Cash
  Flow CSV exports are both locally proved. `src/test/pages/Bas.test.tsx`
  covers BAS CSV filename/rows plus the BAS worksheet/lodge-prep gates, and
  `src/test/pages/CashFlow.test.tsx` proves weekly aggregation, opening
  balance, running balance, and exported CSV rows. BAS worksheet PDF and BAS
  lodgement-pack paths also exist locally, with separate lodgement-pack tests.
  Remaining proof: signed-in browser download checks for CSV/PDF files and live
  BAS lodgement-pack generation against a real draft.
- **Resolved locally 2026-07-02: Job P&L margin trend chart** — `JobDetail`
  already renders `MarginSparkline` with weekly cumulative revenue, cost, and
  margin. Focused proof: `src/test/pages/JobDetail.test.tsx` passed 1/1 and
  exercises the chart with bill and invoice rows in separate weeks. Remaining
  proof: signed-in browser screenshot against a live job with dated bills and
  invoices.
- **Resolved locally 2026-07-02: invoice line-item `zero` GST treatment** — `supabase/migrations/20260702130000_invoice_zero_gst_treatment.sql` adds the enum value, `InvoiceDetail.tsx` preserves `gst_treatment: 'zero'` instead of collapsing it to `free`, and `src/test/pages/InvoiceDetail.test.tsx` proves a zero-rated invoice line insert keeps zero GST. Remaining proof: apply the migration live and create/save a signed-in invoice against production.
- **Cash flow forecast opening balance is covered locally** — the page now seeds from `bank_accounts.current_balance_cents`; focused proof lives in `src/test/pages/CashFlow.test.tsx`. Remaining work is live seeded-org proof, not a missing UI feature.
- **Resolved locally 2026-07-02: Cash Flow load-error state** —
  `CashFlowPage` now stops on failed `v_cash_flow_weekly` or `bank_accounts`
  reads and displays categorized `formatLoadError` copy instead of showing an
  empty forecast. Focused proof: `src/test/pages/CashFlow.test.tsx` passed 2/2.
  Remaining proof: live signed-in error screenshot if a real Supabase failure is
  intentionally induced during product proof.
- **Resolved locally 2026-07-02: allocations bill preview side pane** —
  `AllocationsPage` has a queue-row `Show PDF` action, opens a slide-out
  `Bill PDF preview` pane, fetches bill storage metadata on demand, and renders
  a signed PDF iframe. Focused proof: `src/test/pages/Allocations.test.tsx`
  passed 1/1. Remaining proof: signed-in browser screenshot against a real bill
  attachment in the allocation queue.
- **Resolved locally 2026-07-02: Subscriptions mobile card layout** — desktop
  keeps the existing table, while mobile now switches below 768px to a card
  list with merchant, source, cadence, amount, monthly/annual equivalents,
  status, classification, confidence, split, and move actions. Focused proof:
  `src/test/pages/Subscriptions.test.tsx` passed 2/2 and checks both rendered
  card content and the CSS breakpoint contract. Remaining proof: mobile browser
  screenshot/manual interaction against live subscription rows.
- **Resolved locally 2026-07-02: Settings roadmap link** — Settings now links
  to a real `/roadmap` app route instead of leaving roadmap/future-work text as
  static copy. The roadmap page links to the relevant work surfaces for live
  proof gates, data cleanup, external-provider proof, and product polish.
  Focused proof: `src/test/pages/Settings.test.tsx` passed 1/1 and verifies no
  "Coming next" note remains, the Settings link targets `/roadmap`, and the
  roadmap route renders linked actions. Remaining proof: signed-in browser click
  through in the running app.

---

## Gaps — P3 (deferred / multi-day)

These are big enough to warrant their own sprint, not lumped in here:

- **Xero bidirectional sync live proof / release decision** — push functions, payment sync, account sync, and Settings OAuth entry exist locally; focused proof passed 34 tests with only live-DB automation job tests skipped. Remaining work is live provider proof, accepted stub-mode proof, and deciding whether deeper bidirectional sync is release-blocking.
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
- `gmail-oauth-start`, `gmail-oauth-callback`, `gmail-mine`, `gmail-classify-ai`, `gmail-watch-renew`, `gmail-pubsub-push`
- `bank-link-token`, `bank-exchange`, `bank-sync`, `bank-sync-all`, `bank-webhook`, `bank-csv-import`, `bank-statement-extract`
- `subscriptions-detect` (fires after every bank ingest)
- `xero-oauth-start`, `xero-oauth-callback` (Settings invokes through `XeroConnect`; live OAuth proof still required)

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

Superseded for the 2026-06-29 wrap-up. Use this order now:

1. **Ledger cleanup** — update audit/status docs so stale May 6 P1 items are
   marked code-complete instead of rebuilt. Tenant isolation is now a
   CI-wired/code-complete gate; it still needs a real GitHub run with secrets
   before being called live-proven.
2. **Focused local proof** — verify org settings write-through,
   Dashboard-to-Triage discoverability, debt payment recording, employee detail,
   subscription detail, Jobs creation, and multi-org move behavior. These local
   UX ledgers now have focused test proof; continue with signed-in browser proof
   and live blockers. Latest added proof: `src/test/pages/Jobs.test.tsx`, with
   log `tmp/jobs-page-test.log`.
3. **Signed-in live proof** — run Advisor and Receipt Hub smoke tests with
   `TEST_USER_JWT`, `TEST_ORG_ID`, and service-role cleanup credentials.
4. **Legal proof** — register specific ATO Legal Database documents/feeds or
   formally defer ATO rulings/determinations, prove corpus citations in Ask,
   then run Legal Horizon.
5. **Data-starvation cleanup** — import queued bank statement PDFs, run
   subscription detection, and process pending triage rows into `intake_rules`.
6. **Integration decisions** — complete or explicitly defer Xero bidirectional
   sync and ATO lodgement enablement. Basiq callback/backfill is locally wired
   and now needs real-provider proof rather than implementation work. Gmail
   Pub/Sub also needs real watched-mailbox proof rather than implementation work.
7. **Release gate** — rerun full local gates, browser smoke critical surfaces,
   re-check live row counts, and label every ledger `live-proven`,
   `code-complete`, `external-blocked`, or `deferred`.

After (1-5) the app is usefully end-to-end on real data.
