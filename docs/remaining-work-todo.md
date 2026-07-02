# Looplet Accounting Remaining Work Todo

Last updated: 2026-07-02

This is the practical todo list behind `docs/automation-spine.html`. Keep this
file honest: it tracks what still needs proof before the app can be called
complete.

Current state:

- Verified automation wiring score: 63 / 63 connected strings = 100% local source-contract wiring.
- Remaining disconnected strings: 0 / 63.
- Spine node checklist: 44 / 51 nodes accounted for.
- Not-running nodes: 7.
- Needs-trigger nodes: 13.
- Human/legal gate nodes: 8.
- Latest local proof run: `docs/proof-run-2026-07-02.md`.
- Latest live Supabase audit: `docs/live-supabase-production-audit-2026-07-02.md`.
- Evidence-based completion estimate after the latest live audit and follow-up
  remediation: about 85%
  overall product readiness. Local source-contract wiring is 100%, but live
  Supabase, signed-in product, external-provider, and red-node activation proof
  is still incomplete.
- Live Supabase/product autonomy: not complete until the live proof suite below
  passes against the linked project.

The key point: the app should not be described as "finished" without qualifying
the metric. Local graph wiring is now 100%. Production readiness is lower
because several nodes are not running, several flows still need live triggers,
and the live Supabase/product proof suite has not been completed end to end.

## Remaining At A Glance

These are the highest-signal gaps right now.

- [x] Finish the 4 disconnected graph strings:
  `C2 -> E1`, `D4 -> E1`, `H1 -> I5`, and `H1 -> I6`.
- [x] Resolve `C2 -> E1` as an explicit handoff into `C1 -> E1`; the
  intake-routing endpoint now returns a visible coding/ledger handoff and fails
  observably if `coding-classifier` fails.
- [x] Resolve `D4 -> E1` as safe bank-only debit posting through the immutable
  GL helper, with matched/personal/inbound/legal-wall cases skipped and GL
  failures held in review.
- [x] Prove `H1 -> I5` as an approved-but-transmit-gated STP/payroll path.
- [x] Prove `H1 -> I6` as an approved-but-independent-human-gated SMSF audit
  path.
- [x] Capture a fresh browser screenshot of the spine after the latest graph
  status changes: `tmp/automation-spine-63-of-63-preview.png`.
- [ ] Run the live Supabase activation suite after secrets, migrations, cron
  jobs, and Edge Function env are stable.
- [ ] Run signed-in UI/product proof for the remaining operational screens.
- [x] Run local Chromium visual smoke for the wrapped product screens:
  dashboard, BAS coverage gate, quality repair, Gmail disconnect notification,
  org profile, connector keys, debt payment, subscription edit, employee log
  time, and MoveToOrg. Evidence:
  `.claude/scratch/wrap-up-local-visual-smoke/2026-07-01T17-54-18-203Z/`.
- [x] Deploy the two Edge Functions the live audit found missing:
  `ato-lodge` and `bas-lodgement-pack`. Evidence:
  `tmp/deploy-ato-lodge.log`, `tmp/deploy-bas-lodgement-pack.log`, and
  `tmp/supabase-readiness-after-legal-functions.log`.
- [x] Add the two missing legal Edge secrets without exposing values:
  `LEGAL_INGEST_SECRET` and `LEGAL_SCAN_SECRET`. Evidence:
  `tmp/set-legal-edge-secrets.log` and
  `tmp/supabase-readiness-after-legal-functions.log`.
- [ ] Keep every legal/money/lodgement wall explicit: ATO/SBR lodgement, true
  and correct declaration, ABA release, super send, STP transmit, and SMSF
  independent audit must not become silent automation.

## Executive Todo Board

Use this as the working queue. Only tick items after source proof, tests, logs,
or live Supabase evidence exist.

- [x] Stage 1 - Re-verify the current spine render:
  parser shows 63 / 63 connected strings and 0 disconnected strings. Fresh
  Playwright screenshot captured at `tmp/automation-spine-63-of-63-preview.png`
  with no page errors.
- [x] Stage 2 - Connect the legal/advisor loop:
  prove G10 legal-horizon output feeds G11 advisor, then prove G11 advisor
  signals feed G1 accountant-orchestrator decisions.
- [x] Stage 3 - Decide and implement GL posting boundaries:
  C2 is an explicit handoff into coding-classifier's GL path. D4 now posts only
  safe bank-only debit categories through E1 and keeps unsafe/failing cases out
  of blind posting. D5 and I7 are already locally proved as evidence paths.
- [x] Stage 4 - Reconcile BAS to GL:
  wire E2 GST/BAS control-account totals into G4 BAS worksheet/draft generation
  and prove worksheet totals reconcile to immutable journals.
- [x] Stage 5 - Finish or defer specialist compliance engines:
  extend G3 dispatch for G6, G8, and G9, or mark each unsupported draft family
  explicitly deferred with accountant sign-off requirements.
- [x] Stage 6 - Add approval-gate handoffs:
  H1 -> I1, H1 -> I2, H1 -> I5, and H1 -> I6 are locally proved as legal-wall
  handoffs, not transmission/audit automation.
- [ ] Stage 7 - Run live Supabase activation proof:
  deploy/apply the nine currently tracked pending migrations and prove Gmail,
  ingest, worker, OCR,
  bank-classifier, auto-reconcile, BAS pack, Xero push, tenant isolation, and
  cron/secret behavior against the linked project. Current blocker from the
  2026-07-02 live audit: `SUPABASE_DB_PASSWORD` is present but invalid for the
  linked remote DB, and this shell lacks `SUPABASE_SERVICE_ROLE_KEY`,
  `TEST_USER_JWT`, `TEST_ORG_ID`, and fixture IDs for deploy-gated tests.
- [ ] Stage 8 - Product proof and polish:
  complete signed-in UI proof for the remaining operational screens, then run
  page-level mobile/card/table polish, auxiliary loading-state cleanup,
  live error-state screenshots, live archive/restore proof, report export, and
  large-table passes. The global responsive shell itself is locally proved by
  `src/test/components/LayoutResponsive.test.tsx`; core detail-page loading
  states are locally proved by `DetailPageSkeleton` tests; supported
  archive/restore update payloads are locally proved by `ArchiveButton` tests;
  audited generic load-error copy is locally proved by
  `tmp/secondary-error-copy-tests.log`; Onboarding Triage table-to-card mobile
  behavior is locally proved by `tmp/triage-mobile-card-tests.log`; Onboarding
  Auto Setup/Triage empty states (no org, no Gmail, zero staged entities) are
  locally proved by `tmp/onboarding-empty-tests.log`; Onboarding Triage
  load-error handling (a real `useStagedEntities` fix so failed loads no longer
  masquerade as an empty inbox) is locally proved by
  `tmp/onboarding-error-tests.log`; Onboarding Auto Setup mobile action stacking
  below 768px is locally proved by `tmp/onboarding-mobile-tests.log`; Dashboard
  P&L mobile overflow fixes (wrapping account action pills and the P&L formula
  code below 768px) are locally proved by `tmp/dashboard-mobile-tests.log`;
  Bills list table-to-card mobile layout is locally proved by
  `tmp/bills-mobile-tests.log`; Allocations silent-write error handling (a real
  fix so reject/quick-assign/bulk-attach failures surface categorized
  `formatActionError` copy instead of failing silently) is locally proved by
  `tmp/allocations-error-tests.log`; Allocations mobile (preview pane overlays
  instead of shoving the queue off-screen below 768px) is locally proved by
  `tmp/allocations-mobile-tests.log`; Suppliers create-error copy (failed inserts
  now use `formatActionError` instead of load-oriented copy) is locally proved by
  `tmp/suppliers-error-tests.log`; Suppliers list table-to-card mobile layout is
  locally proved by `tmp/suppliers-mobile-tests.log`; Customers delete/archive
  list-hide (the list now filters `deleted_at IS NULL` so archived customers
  disappear) is locally proved by `tmp/customers-delete-tests.log`; Customers
  actionable empty state (icon + inline create CTA) is locally proved by
  `tmp/customers-empty-tests.log`; Customers create-error copy (raw insert error
  → categorized `formatActionError`) is locally proved by
  `tmp/customers-error-tests.log`; Customers list table-to-card mobile layout is
  locally proved by `tmp/customers-mobile-tests.log`; Jobs costing pipeline
  (v_job_pnl merge into job rows + non-blocking `pnlError` instead of silent
  zeros) is locally proved by `tmp/jobs-pipeline-tests.log`; Jobs create-error
  copy (raw insert error → categorized `formatActionError`) is locally proved by
  `tmp/jobs-error-tests.log`; Jobs list table-to-card mobile layout is locally
  proved by `tmp/jobs-mobile-tests.log`; Invoices list load-error copy (raw
  `{error}` → categorized `formatLoadError`) is locally proved by
  `tmp/invoices-error-tests.log`; Invoices list table-to-card mobile layout is
  locally proved by `tmp/invoices-mobile-tests.log`; Bank/Basiq connect callback
  pipeline (failed-vs-timeout distinction so a failed job no longer reads as
  "still activating") is locally proved by `tmp/basiq-pipeline-tests.log`;
  Bank/Basiq connect error handling (failed load shows a categorized alert
  instead of the false "connect a bank" CTA) is locally proved by
  `tmp/basiq-error-tests.log`; Bank/Basiq loading skeleton + table-to-card mobile
  are locally proved by `tmp/basiq-loading-tests.log` (completing the Basiq row
  locally); Subscriptions list/detail error copy (raw messages → categorized
  `formatLoadError`/`formatActionError`) is locally proved by
  `tmp/subscriptions-error-tests.log`; Debts false-empty-on-error fix + action
  error copy is locally proved by `tmp/debts-error-tests.log`; Employees
  false-empty-on-error fix + action error copy is locally proved by
  `tmp/employees-error-tests.log`; Reports/BAS categorized error + table-to-card
  mobile is locally proved by `tmp/bas-error-mobile-tests.log`; Settings Org
  profile categorized errors + responsive grids (fixing a real 390px overflow in
  the business-profile form) are locally proved by
  `tmp/org-profile-error-mobile-tests.log`; Cash flow + Quality table-to-card
  mobile layouts are locally proved by `tmp/cashflow-quality-mobile-tests.log`;
  Debts + Employees table-to-card mobile layouts are locally proved by
  `tmp/debts-employees-mobile-tests.log` (the historical scorecard now has zero
  remaining ⚠ cells — outstanding risk is live/signed-in/provider proof only);
  Settings
  Xero responsive/error states are locally proved by
  `tmp/xero-connect-responsive-tests.log`; bank CSV/PDF import responsive form
  behavior is locally proved by `tmp/bank-import-responsive-tests.log`.

## Immediate Work Order

- [x] Extend the new G1 -> G3 dispatch layer beyond BAS, super, and income-tax:
  G6, G8, and G9 still need safe adapters or explicit deferral.
- [x] Decide whether C2 and D4 are meant to post journals directly to E1, only
  produce evidence, or remain review-gated handoffs. C2 is a coding-classifier
  handoff; D4 is narrow safe bank-only GL posting with review-safe failure.
- [x] Wire E2 BAS/GST control totals into G4 BAS worksheet/draft generation.
- [x] Connect G10 legal-horizon output into G11 advisor, then G11 into G1
  orchestrator signals.
- [x] Add explicit H1-bound approval gates for I5 and I6. I1 and I2 are already
  locally proved as legal-wall handoffs.
- [x] Add Xero push result/evidence writeback to E1/audit trail or mark I7 -> E1
  as intentionally out of scope.
- [ ] Run the live Supabase proof suite after deploy secrets/env are stable:
  Gmail, Basiq/bank webhook, ingest -> worker -> OCR, bank classifier,
  auto-reconcile, BAS pack, Xero push, and tenant isolation.

## P0 - Keep The Status Honest

- [x] Keep `docs/automation-spine.html` split into separate metrics:
  local code/test estimate, node readiness, and automation wiring score.
- [x] After each completed stage, update this file and the spine counts/statuses.
- [ ] Do not tick a disconnected string as connected until there is runtime proof
  or a focused test that proves the handoff cannot silently fail.
- [ ] Keep legal/human gates explicit. Do not convert I1-I6 into automation work
  unless ATO/DSP/SBR/legal requirements are actually satisfied.
- [ ] Consolidate lane branches/worktrees only after reviewing diffs and running
  the relevant local gates.

## P1 - Red Nodes To Build Or Activate

- [ ] F3 `depreciation-run (monthly)`:
  build or wire the scheduled depreciation runner, post through E1 GL, and prove
  fixed-asset depreciation rows cannot auto-post incorrectly.
- [ ] F4 `accruals-run (monthly)`:
  build or wire the scheduled accrual runner, post through E1 GL, and prove
  reversal/period handling.
- [ ] G1 `accountant-orchestrator (scheduler)`:
  deploy/live-prove the orchestrator dispatch path so tax calendar / books-health
  / advisor signals create draft-generation work in Supabase.
- [ ] G3 `Engine-dispatch layer (decide -> invoke draft)`:
  deploy/live-prove the current BAS/super/income-tax/G6/G8/G9 dispatch and
  record durable status/evidence for every supported engine.
- [ ] G7 `Income-tax return draft`:
  implement or explicitly defer entity-aware income-tax return draft generation.
- [ ] G8 `FBT-instalment / payroll-tax / ASIC-annual drafts`:
  safe draft adapters now exist locally; deploy/live-prove each adapter and
  retain accountant sign-off requirements.
- [ ] G9 `Div 7A / SGC / franking / CGT`:
  safe draft adapters now exist locally; deploy/live-prove each adapter and
  require accountant sign-off before trusting outputs.

## P1 - Trigger Nodes To Make Operational

- [ ] A2 `Gmail backfill`:
  activate safe scheduled catch-up, prove it feeds B1, and avoid long-lived
  service-role cron reliance where a scoped secret can work.
- [ ] A6 `Gmail mine + AI triage`:
  deploy/live-prove the new queued recent-window refresh. Full first-scrape can
  remain onboarding-only unless a cursor-state worker is added later.
- [ ] B2 `bills-extract (OCR + fallback)`:
  run a representative bill sample / repair batch and prove amount plus GST
  coverage reaches the target.
- [ ] C1 `coding-classifier`:
  deploy/live-prove classification, GL/GST proposal, high-confidence auto-post,
  and low-confidence review fallback.
- [ ] C4 `Capital-purchase detect + propose`:
  prove capital candidates draft fixed-asset proposals instead of expense
  auto-posts.
- [ ] E2 `GST/BAS control posting`:
  wire GST/BAS control-account posting onto E1 immutable journals and prove
  BAS worksheet totals reconcile to GL.
- [ ] F5 `Period-close preflight`:
  collapse duplicated preflight logic into one server-side path and prove close
  readiness reads the real checks.
- [ ] G4 `BAS worksheet + lodgement draft`:
  deploy and live-prove the BAS worksheet, lodgement draft, approval row, and
  BAS pack download against a seeded org.
- [ ] G5 `Super batch assemble`:
  finish/live-prove draft super batch assembly and approval-gated release flow.
- [ ] G6 `FBT / TPAR / EOFY / workcover / trust / SMSF / TBAR`:
  safe draft adapters now exist locally; deploy/live-prove each adapter and
  retain accountant sign-off requirements.
- [ ] G10 `Legal-corpus sync + horizon`:
  register specific ATO Legal Database documents/feeds or provided-text sources,
  then prove sync, embeddings, horizon scanning, and refusal of generic sources.
- [ ] G11 `Advisor proactive engine`:
  prove scheduled/secret mode dispatches advisor work and surfaces drafts/tasks.
- [ ] I7 `Xero push (bill / invoice)`:
  local source-contract proof now covers bill/invoice push bodies, idempotency
  headers, queued dispatch, and GL/audit evidence. Remaining work is a real or
  accepted stub-mode Xero integration trace for OAuth, push, account sync, and
  payment sync.

## P1 - Live Proof And Activation

- [ ] Run the already-deployed BAS lodgement pack live test
  `tests/bas-lodgement-pack.test.ts` with real env:
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `TEST_USER_JWT`,
  `TEST_BAS_LODGEMENT_ID`.
- [ ] Run live GL proof: seed chart of accounts, post a balanced fixture through
  `post_journal_entry`, verify trial balance, statutory statements, equity, and
  cash-flow outputs.
- [ ] Run live BAS proof: apply current BAS migrations to a real org, include a
  `GST_ON_CAPITAL` fixture, verify G1/G10/G11/1A/1B/W labels.
- [ ] Run tenant-isolation deploy gate with real Supabase CI secrets.
- [x] Apply pending audit migrations live (2026-07-02, via Supabase MCP): the
  5 genuinely-pending `20260702*` migrations are now applied + verified on prod
  — `debts_soft_delete`, `timesheet_entries_job_pnl` (v_job_costs now unions
  `timesheet_entries` and is `security_invoker=on`),
  `expand_debt_kind_enum`, `bank_accounts_to_debts_pipeline`,
  `move_employee_to_org`. The other 8 were already live under `20260701*`
  timestamps. Details in `docs/proof-run-2026-07-02.md` → "Live apply — Stage 7
  partial". Remaining: SIGNED-IN row proof (needs a fresh TEST_USER_JWT) that
  timesheets feed `v_job_pnl`, a real credit-card/loan feed lands a debt row,
  and an employee move runs the RPC end to end.
- [ ] Run signed-in live smoke for Advisor and Receipt Hub.
- [ ] Capture real Gmail watched-mailbox Pub/Sub event evidence.
- [ ] Capture positive Basiq-style `bank-webhook` event proof.
- [ ] Run ingest + automation-worker positive e2e proof:
  connector document -> bill row -> bill_extract job -> extraction state.
- [ ] Run connector payment positive proof:
  connector payment -> single idempotent invoice payment row.
- [ ] Run auto-reconcile positive proof over real or seeded candidate data.
- [ ] Run bank-transaction classifier positive proof after MiniMax/key/provider
  config is healthy.
- [ ] Run subscription auto-confirm proof with recurring debits.

## P1 - Disconnected Automation Strings

These are the strings that started this pass dull/disconnected on the spine.
Checked items were promoted on 2026-07-02 after focused source-contract proof.
No disconnected strings remain in the local spine.

- [x] A1 -> B1: Gmail Pub/Sub creates durable queue work.
- [x] A2 -> B1: Gmail backfill creates durable queue work.
- [x] A6 -> B1: Gmail mine/triage creates durable queue work or triage tasks.
- [x] B1 -> B2: automation-worker drains extraction jobs reliably.
- [x] B2 -> C1: extracted bills reach coding-classifier.
- [x] C2 -> E1: intake routing hands bill outcomes to coding-classifier's GL
  posting path and exposes that ledger handoff in the response.
- [x] C1 -> E1: coding-classifier posts high-confidence journals.
- [x] C1 -> C3: low-confidence coding reaches review queue.
- [x] C1 -> C4: capital candidates reach fixed-asset proposal path.
- [x] C4 -> F3: capital purchases feed depreciation scheduling.
- [x] D3 -> D4: bank post-sync invokes bank classifier.
- [x] D3 -> D5: bank post-sync invokes auto-reconcile.
- [x] D4 -> E1: classified safe bank-only debit transactions post through the
  immutable GL helper; matched, personal, inbound, and unsafe categories do not
  blind-post.
- [x] D5 -> E1: reconciled matches post evidence/journals to GL.
- [x] E1 -> E2: GST/BAS control posting goes through the immutable journal wrapper.
- [x] B1 -> I7: worker dispatches Xero push jobs with correct body.
- [x] F2 -> G1: books-health feeds the accountant orchestrator.
- [x] F3 -> E1: depreciation posts to GL.
- [x] F4 -> E1: accruals post to GL.
- [x] F5 -> F6: period-close preflight gates close_period.
- [x] F2 -> F5: books-health feeds period-close preflight.
- [x] G2 -> G1: tax calendar feeds orchestrator.
- [x] G1 -> G3: orchestrator dispatches through engine-dispatch.
- [x] G3 -> G4: dispatch invokes BAS draft engine.
- [x] G3 -> G5: dispatch invokes super batch draft engine.
- [x] G3 -> G6: dispatch invokes specialist compliance draft engines.
- [x] G3 -> G7: dispatch invokes income-tax draft engine.
- [x] G3 -> G8: dispatch invokes FBT/payroll-tax/ASIC draft engines.
- [x] G3 -> G9: dispatch invokes Div7A/SGC/franking/CGT engines.
- [x] E2 -> G4: GST/BAS control totals feed BAS worksheet/draft.
- [x] G10 -> G11: legal horizon feeds advisor engine.
- [x] G11 -> G1: advisor proactive signals feed orchestrator.
- [x] G4 -> H1: BAS drafts open hash-bound approval.
- [x] G5 -> H1: super batch drafts open hash-bound approval.
- [x] G6 -> H1: specialist drafts open hash-bound approval.
- [x] G7 -> H1: income-tax drafts open hash-bound approval.
- [x] H1 -> I1: approved lodgement drafts remain held at ATO/SBR wall.
- [x] H1 -> I2: approved drafts require true-and-correct declaration.
- [x] H1 -> I3: approved ABA runs remain release-gated.
- [x] H1 -> I4: approved super batches remain send-gated.
- [x] H1 -> I5: approved payroll/STP remains transmit-gated.
- [x] H1 -> I6: SMSF audit remains independent-human gated.
- [x] G4 -> I1: BAS draft packaging reaches lodgement wall, not auto-lodge.
- [x] G5 -> I4: super batch assembly reaches send wall, not auto-send.
- [x] C3 -> E1: approved AP review outcomes post to GL.
- [x] I7 -> E1: Xero push outcome/evidence posts back to GL/audit trail.

## P2 - Data And Signed-In Product Proof

- [ ] Import the queued bank statement PDFs and rerun subscription detection.
- [ ] Clear or batch-process staged triage rows into reusable intake rules.
  Local proof now covers staged customer approval into `customers` +
  customer-linked `intake_rules`; remaining work is signed-in/live processing of
  the pending rows.
- [ ] Seed or capture real customers, jobs, invoices, bills, payments, employees,
  subscriptions, debts, and timesheets for signed-in proof.
- [ ] Signed-in proof for customer creation.
- [ ] Signed-in proof for supplier creation.
- [ ] Signed-in proof for job creation.
- [ ] Signed-in proof for bill detail edit/save.
- [ ] Signed-in proof for MoveToOrg across at least two live orgs.
- [ ] Signed-in proof for subscription detail edit.
- [ ] Signed-in proof for debt payment.
- [ ] Signed-in proof for employee timesheet/log-time.
  Local source-contract proof now covers `timesheet_entries` -> `v_job_pnl`;
  remaining work is live migration apply plus signed-in row evidence.
- [ ] Signed-in proof for Cash Flow export with live seeded bank accounts.
- [ ] Signed-in proof for BAS CSV, worksheet PDF, and BAS pack download after
  live BAS draft creation.

## P2 - Product Polish

- [ ] Finish page-by-page mobile polish: global shell/table overflow and Bank
  CSV/PDF imports, Subscriptions, Settings Gmail intake, Settings Bank accounts,
  Settings Xero, Reconciliation recently matched rows, Onboarding Triage staged
  senders, and the multi-org allocation split popover now have local mobile
  card/form/action layouts and CSS breakpoint tests. Auth
  (login/reset-password/signup/confirmation) is done end to end: focused tests
  passed 4/4 and an unauthenticated 390x844 Playwright browser proof showed no
  errors or horizontal overflow (`tmp/auth-mobile-tests.log`,
  `tmp/auth-mobile-browser-proof.json`), so the pre-auth surface has no
  signed-in remainder. Remaining dense pages still need signed-in mobile
  screenshot/manual checks.
- [x] Add pagination controls for Bills, Invoices, and Suppliers locally; focused
  page tests prove load-more behavior. Extend pagination to any newly identified
  high-volume tables as follow-up, not as the original gap.
- [x] Add Supplier creation locally; focused `SuppliersPage` tests prove the New
  supplier form, normalized insert payload, list refresh, detail navigation, and
  cancel path. Live signed-in supplier creation proof remains tracked under P2
  data/product proof.
- [x] Replace passive plain "Loading..." text with skeletons locally. Core
  detail pages, settings/profile/connectors, onboarding triage, activity/team,
  approvals, Legal Horizon, Tax Return draft, Quality duplicate checks,
  document preview, bank coding queue, allocation split, Audit Log lists,
  Payroll super batch, BAS worksheet, Settings policies, org selector, and Bill
  Detail preview/history are locally proved. Intentional text remains for
  action/button states such as "Loading more" and spinner-labelled Receipt Hub
  states unless a separate visual redesign replaces them.
- [x] Finish audited error specificity on secondary pages locally: Customers,
  Jobs, Suppliers, Allocations, Dashboard, Coding Review, Fixed Assets, SMSF,
  Trusts, Quality, Payment Runs, Cash Flow, registrations, CGT events, and the
  allocation queue now use categorized resource-specific load errors or are
  covered by the source guard. Live signed-in/browser screenshots for real
  Supabase failures remain under Stage 8 product proof.
- [x] Add archive/restore UI for supported `deleted_at` records locally;
  Customer/Supplier plus Bill/Invoice/Job/Subscription/Employee/Debt detail
  surfaces are wired and covered. Debt support includes the local
  `20260702131500_debts_soft_delete.sql` migration and active-list filtering.
  Live migration application plus signed-in archive/restore proof remains open.
- [x] Add Job P&L trend chart locally; focused `JobDetail` test proves dated
  bills/invoices render the weekly cumulative margin sparkline. Live signed-in
  screenshot proof remains tracked under P2 data/product proof.
- [x] Add invoice line-item `zero` GST treatment locally; migration and
  `InvoiceDetail` test proof exist. Live migration apply/sign-in save proof
  remains open.
- [x] Add allocations queue bill preview / side pane locally; focused
  `AllocationsPage` test proves the slide-out preview, signed storage URL, and
  PDF iframe render. Live signed-in screenshot proof remains tracked under P2
  data/product proof.
- [x] Make subscriptions table/card layout usable below 768px; focused
  `SubscriptionsPage` test proves mobile cards plus the table-to-card CSS
  breakpoint. Live mobile screenshot/manual proof remains tracked under P2
  data/product proof.
- [x] Make Onboarding Triage review usable below 768px; focused `TriagePage`
  tests prove mobile sender cards, review controls, and the table-to-card CSS
  breakpoint. Live signed-in triage review proof remains tracked under P2
  data/product proof.
- [x] Make Settings Xero connected-state/error/loading UI locally provable;
  focused `XeroConnect` tests cover empty connect, skeleton loading, enabled
  tenant actions, categorized load-error alert, OAuth start, and mobile action
  stacking. Live Xero provider proof remains tracked under P3.
- [x] Make Bank CSV/PDF import forms usable below 768px; focused bank import
  tests cover responsive CSV/PDF form grids, full-width mobile openers/actions,
  and CSV auth validation displayed as an alert. Live queued PDF import remains
  tracked under P2 data proof.
- [x] Make Basiq connection detail/disable locally provable; focused Settings
  connector tests cover linked `bank_accounts` detail rendering in desktop and
  mobile layouts plus the app-side `Disable feed` path that marks the connection
  `revoked` and linked accounts inactive. Live real-feed and provider-side
  revoke/re-consent proof remains tracked under P3.
- [x] Add the Debts bank-account pipeline locally; active imported
  `bank_accounts` with `account_type` `credit_card` or `loan` now upsert
  reviewed `debts` rows by `bank_account_id`, and the debt enum is aligned with
  current UI options. Live migration apply plus real/seeded bank-account import
  proof remains tracked under P1/P2.
- [x] Add payroll-safe Employee multi-org move locally; Employee Detail now uses
  `move_employee_to_org`, which moves current timesheet/wage/leave/schedule rows,
  clears org-scoped job links, and blocks moves after payroll history exists.
  Live migration apply plus signed-in two-org move proof remains tracked under
  P1/P2.
- [x] Replace static Settings "Coming next" copy with linkable roadmap/issues;
  Settings now links to `/roadmap`, and focused test proof covers the link and
  route. Live signed-in click-through proof remains tracked under P2 data/product
  proof.

## P3 - External Or Deferred Decisions

- [ ] Decide whether Basiq real-feed/provider-side revoke proof is required
  before release or marked external-blocked. The app-side Settings
  detail/disable flow is locally proved.
- [ ] Decide whether Xero bidirectional sync is required before release or marked
  deferred/stub-mode.
- [ ] Decide whether ATO/SBR lodgement enablement is in scope for this release.
- [ ] Obtain ATO DSP/EVTE credentials and SBR certification before any real
  lodgement/transmission work.
- [ ] Define how SBR taxonomy assets will be hosted/loaded for Edge Functions.
- [ ] Get accountant sign-off for speculative compliance engines before users
  rely on them.

## Definition Of Done For "Autonomous"

The system is not autonomous until these are all true:

- [ ] No red nodes remain unless explicitly deferred.
- [ ] Every yellow node is either activated, externally blocked, or intentionally
  reclassified.
- [ ] Connected strings are the majority of the spine, with runtime evidence for
  each critical handoff.
- [ ] Live Supabase tests are run with real env and no deploy-gated smoke skipped.
- [ ] Real or accepted-stub external integrations have proof: Gmail, Basiq, Xero.
- [ ] Legal/money/lodgement walls are explicit and cannot be bypassed by cron or
  worker code.
- [ ] Status docs, spine, and todo list all agree.
