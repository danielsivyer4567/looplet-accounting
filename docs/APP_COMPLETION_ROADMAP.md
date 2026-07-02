# Looplet Accounting App Completion Roadmap

Created: 2026-06-29

## Current Verified State

The accountant portal and tag-drop ledger in `.claude/scratch/ledger.md` is locally complete through SC-2G. Local gates passed after SC-2G:

- `npm run lint`
- `npm run test`
- `npm run typecheck`
- `npm run build`
- `git diff --check`

Live follow-up proved real auth, real RLS-backed mention notifications, cross-org org switching, and `/bills?tag=<uuid>` navigation. The live project does not yet have `public.tags`, `public.tag_staff`, `get_taggable_staff()`, or `create_tag_with_rate_limit()` deployed, so real tag-overlay proof remains blocked on SC-2B/SC-2C deployment.

Parallel roadmap status:

- The requested 50-agent decomposition is complete. Scratch reports `agent-01.md` through `agent-50.md` exist under `.claude/scratch/parallel-roadmap/`.
- The runtime cap was 6 active agents, so the audits ran in capped waves. No audit lane is currently active or queued.
- Audit findings are consolidated into `docs/IMPLEMENTATION_QUEUE.md` as write-scoped implementation tasks with file ownership, dependencies, test gates, live-proof requirements, and rollback notes.
- Implementation should now start from the P0 queue. No implementation worker should edit outside its declared file scope without stopping and recording the conflict.

## Definition Of Done For The App

Looplet Accounting is done when it can:

1. Run the ingest/extract/classify/reconcile/post/comply/push/monitor loop continuously with low human touch.
2. Accept and expose data through a secure connector API.
3. Produce real accounting outputs from double-entry postings, not approximating reports from operational tables.
4. Handle Australian GST, BAS, payroll/STP, super, EOFY, period locks, audit trails, and external pushes.
5. Ship with a polished accountant/client UX, reliable observability, security gates, and documented deploy/runbooks.

## Phase 0 - Stabilize The Current Branch

Goal: convert the current dirty worktree into a clean, reviewable PR.

- Fix the no-go security blocker found by Agent 02: pending `organization_memberships`
  appear to grant access before explicit acceptance because `get_accessible_org_ids()` and
  `OrgProvider` do not filter `accepted_at`, while `team-invite` creates pending
  memberships for existing users.
- Fix or explicitly carve out the tag draft unique-constraint gap: frontend
  `saveTagDraft()` uses `onConflict: 'user_id,organization_id,page_url'`, but the
  migration does not currently create that unique constraint.
- Scope media attachments honestly: comments/drawings can be accepted now; durable
  image/audio/video delivery needs storage upload wiring before it is claimed.
- Fix or remove the fallback invite token path: `team-invite` can return
  `/accept-invite?token=<uuid>`, but the page does not redeem that token unauthenticated.
- Review the current SC-2F/SC-2G diff and ensure no scratch harness files are accidentally staged.
- Re-run local gates.
- Deploy pending accountant/tag migrations/functions in a controlled live migration window:
  - `0199_accountant_portal.sql`
  - `0200_tag_drop.sql`
  - `0201_tag_functions.sql`
  - `team-invite`
- Re-run live SC-2G with a real `tags` row and prove the overlay opens end to end.
- Update ledger with live deployment proof.

Exit gate:

- Branch clean except intentional app changes.
- Local gates green.
- Live tag notification overlay proven against actual deployed schema.

## Phase 1 - Autopilot Reliability

Goal: the background system runs and tells us when it does not.

Work items:

- Add per-job no-success-window monitoring. Current `cron_health_summary()` proves
  recent HTTP failures and pg_cron enqueue status, but not last successful worker outcome.
- Normalize HTTP 200 soft failures from batch bodies into monitor failures.
- Bring `close-idle-accountant-sessions` into the tracked cron health catalog.
- Separate accountant heartbeat keepalives from pageviews so activity counts are meaningful.
- Persist accountant digest failures per session.
- Gmail reconnect and real watched-mailbox trace.
- Gmail disconnect notification on fatal `invalid_grant`.
- Cron health monitor that alerts on no-success windows, not just individual failures.
- Bank webhook event persistence before ack plus replay path.
- Xero push retry/backfill cron for pending/error rows.
- Fix Xero idempotency before retry automation: Agent 07 found random idempotency keys,
  no durable redrive state, stale `v_xero_pending_pushes`, and `bills.metadata` usage
  that needs schema verification before production retry/backfill claims.
- Legacy schedule audit and migration coverage for remaining cron definitions.

Exit gate:

- `cron_health_summary().http_failures_24h = 0`.
- Gmail live event trace captured.
- Xero retry/backfill proof captured.
- Webhook replay proof captured.

## Cross-Cutting Deployment Inventory Findings

Agent 04 inventory found 65 local function directories, 64 deployable `index.ts`
functions, 51 live ACTIVE functions, and 13 deployable functions not live. Before
calling the app complete, reconcile this inventory:

- Decide whether each non-live deployable function is intentionally dormant or missing.
- Fix `accountant-email-query` missing `EMAIL_INBOUND_SECRET` before enabling it.
- Reconcile `verify_jwt` reproducibility drift in `supabase/config.toml` for public
  webhook/cron functions.
- Add live gateway probes for functions where `functions list` cannot prove auth mode.

## Phase 2 - Data Quality And Intake

Goal: reliable source data flows into the system.

Work items:

- Diagnose or replace OCR provider for reliable total, GST, supplier, date extraction.
- Add re-OCR/repair queue and backfill existing bills.
- Fix OCR extraction blockers found by Agent 10: inconsistent provider config,
  missing durable retry/job tracking, premature `verified` status, dropped OCR line
  items, permissive document classification, GST-estimation handling, multi-page
  PDF gaps, and missing fixture/live accuracy proof.
- Add GST coverage gate before BAS surfaces/lodges.
- Fix BAS readiness blockers found by Agent 11: AP GST source reliability,
  readiness gates must be enforced rather than advisory, approval payloads need
  stronger source/version evidence, quarterly/accrual-only assumptions need
  explicit product treatment, worksheet labels need completion, and bills-only
  or nil-quarter period metadata must not be null.
- Extend confidence-tiered auto-accept beyond exact job-ref match.
- Harden intake routing around low-confidence exceptions.

Exit gate:

- At least 95 percent of active bills have total and GST amounts.
- BAS views refuse to present as ready below coverage threshold.
- Low-confidence exception queue is visible and actionable.

## Phase 3 - Bank Feed And Reconciliation

Goal: money movement connects automatically.

Work items:

- Complete real Basiq AU CDR connection flow: link, exchange, sync, webhook.
- Backfill live transactions.
- Fix Basiq release blockers found by Agent 08: source-control
  `organizations.basiq_user_id`, add durable bank webhook event/replay storage,
  replace forged-role authorization in `bank-discover` with exact service-role
  or verified signed claims, and document required Basiq secrets.
- Build auto-reconciler over bill and invoice candidate views.
- Auto-match unambiguous candidates above threshold with idempotency.
- Auto-confirm high-confidence recurring subscription candidates.
- Fix reconciliation safety blockers found by Agent 09: candidate views must exclude
  personal rows correctly, AP matching needs AR-level safety guards, ambiguous matches
  need durable queueing, and the `0065` auto-reconcile cron path is currently inert.

Exit gate:

- Live transactions flow from a real connection.
- Unambiguous matches reconcile without manual clicks.
- Ambiguous matches land in a review queue with clear evidence.

## Phase 4 - Connector API

Goal: external systems can push and pull safely.

Work items:

- Finish API key issue/revoke UI.
- Complete API gateway key validation, scope enforcement, JWT/RLS bridge, and rate limits.
- Fix connector gateway blockers found by Agent 21: prevent gateway JWTs from
  bypassing scoped writes through PostgREST, verify `service_role` execution for
  rate-limit RPCs, remove direct DML/hash access risk on `api_keys`, fix
  `issue_api_key` pgcrypto/search-path drift, enforce read scopes, and reconcile
  stale deploy secret names.
- Complete generic ingest handlers for bills, invoices, customers, suppliers, jobs, and bank transactions.
- Add idempotency keys and dedupe.
- Add API audit log and last-used tracking.
- Publish OpenAPI and integration guide.

Exit gate:

- External API key can ingest a bill and a bank transaction into one org only.
- Cross-org access test fails closed.
- OpenAPI docs match implemented endpoints.

## Phase 5 - Real Accounting Engine

Goal: reports and compliance derive from postings.

Work items:

- Add chart of accounts.
- Add journal entries and journal lines.
- Fix GL foundation blockers found by Agent 12: add a canonical posting RPC,
  durable posting idempotency keys, period-scoped trial balance semantics, full
  locked-period enforcement, postings for invoices/payments/bank/payroll/opening
  balances, configurable COA roles, reversal-safe void behavior, and a cleanup
  path for duplicated AR source tables.
- Add posting rules for bills, invoices, payments, payroll, GST, adjustments, depreciation, and reconciliation.
- Sequence posting work behind the Agent 12 primitives. Agent 13 identified
  required deterministic posting keys, reversal model, period-lock enforcement,
  source-event atomicity, Xero idempotency alignment, and posting coverage for
  invoices, payments, payroll, BAS/GST, assets, and adjustments.
- Derive P&L, Balance Sheet, and Trial Balance from journal lines.
- Migrate existing report surfaces to the posting engine.
- Fix reporting migration blockers found by Agent 14: trial balance is
  cumulative-only, journal posting coverage is incomplete, job-level GL
  dimensions are missing, balance-sheet as-of-date semantics do not yet match a
  posted ledger, cash-flow forecast versus statutory reporting needs separation,
  and report/API page tests need feature-flagged GL comparison coverage.
- Add correction/reversal patterns.

Exit gate:

- Trial balance balances.
- P&L and Balance Sheet derive from journals.
- Existing operational report approximations are removed or clearly marked legacy.

## Phase 6 - Compliance Completeness

Goal: Australian compliance workflows are structurally real.

Work items:

- BAS W1/W2 and G-code mapping.
- Fix BAS compliance blockers found by Agent 15: add absent `G2/G3`, remove
  hard-coded `G10 = 0`, replace PAYG-I placeholders, support required period
  modes beyond the quarterly worksheet path, strengthen approval payloads, add
  immutable BAS snapshots, add a BAS-specific lodge writer, and complete
  period-lock coverage for current BAS source tables.
- SBR/e-lodgement path or documented manual export equivalent.
- STP Phase 2 fields and submission readiness.
- Fix payroll/STP blockers found by Agent 16: replace placeholder TFN/STP
  export paths, add an employee payroll profile model, complete PAYG treatment,
  update and prove super calculations, make pay-run creation atomic, require
  payment/accounting evidence before finalisation, add an STP lodgement
  lifecycle, and enforce TFN vaulting/masking/no-log controls.
- SuperStream/super payments.
- Fix SuperStream blockers found by Agent 17: current super batch flow is
  review/stub only, no clearing-house or payment rail exists, employee
  fund/member data is incomplete, no `super_payments` ledger exists, and the UI
  can mark super as paid after a stub `sent` without settlement evidence.
- Real TFN handling and masking.
- Credit notes, debit adjustments, fixed assets, depreciation, accruals, prepayments, EOFY pack.
- Fix adjustment blockers found by Agent 19: add adjustment document tables,
  reversal journals, AR/AP credit workflows, GST adjustment reporting,
  reconciliation targets, Xero credit-note sync, and audit-backed void/correction
  flows.
- Fix fixed-asset blockers found by Agent 18: add disposal workflows,
  low-value-pool and instant-asset-write-off treatment, acquisition allocation,
  BAS G10 integration, non-duplicated depreciation posting, broader tests,
  trading-stock/inventory treatment, and validated RPCs for key asset state
  changes instead of direct client writes.
- Period locks across all money tables.

Exit gate:

- BAS figures trace to journal lines and source docs.
- Payroll exports do not use placeholder TFNs.
- Period lock tests cover all write paths.

## Phase 7 - Security, Integrity, And CI Gates

Goal: every risky behavior has a deterministic guard.

Work items:

- Add org guard to `notify()`.
- Harden remaining SECURITY DEFINER functions with `SET search_path` and revoked PUBLIC/anon execute.
- Add missing FK indexes.
- Add audit triggers on money tables.
- Add accounting-engine tests for GST split, BAS, reconciliation, PAYG, ABA, Xero push.
- Ensure CI fails on missing required Supabase secrets for deploy-blocking suites.
- Enable leaked-password protection if not already enabled.

Exit gate:

- Security advisor has no critical findings.
- Tenant isolation and accounting-engine suites are deploy blockers.
- Audit trail covers every money mutation.

## Phase 8 - Product Polish

Goal: make the app feel finished.

Work items:

- Navigation density and role-aware information architecture.
- Empty/loading/error states on every operational page.
- Mobile and tablet pass for core workflows.
- Accessibility pass: keyboard navigation, focus rings, labels, contrast.
- Visual consistency pass across old CSS and shadcn/Tailwind surfaces.
- Performance pass: route-level splitting, PDF chunk handling, large table virtualization where needed.
- In-app help/tooltips for complex accounting concepts.
- Onboarding checklist and sample/demo mode.
- Final runbooks for deploy, rollback, live probes, and support triage.

Exit gate:

- Chromium and Firefox smoke passes.
- No console/page errors on core routes.
- Keyboard-only path works for login, org switch, bill upload, reconciliation, notifications, and settings.

## 50-Agent Coordination Matrix

The first 50-agent decomposition is read-only plus scratch-output only. Each agent owns one lane and writes one file under `.claude/scratch/parallel-roadmap/agent-XX.md`. No agent edits production code in this wave. The runtime cap is 6 active agents, so the matrix runs in waves while preserving 50 isolated lanes. This prevents overlapping changes and produces an implementation queue that can be assigned to smaller write-scoped worker waves.

| Agent | Lane | Output |
| --- | --- | --- |
| 01 | Ledger reconciliation and incomplete ledgers | Open/closed ledger map |
| 02 | Live deploy blockers for accountant/tag-drop | Deployment checklist |
| 03 | Supabase migration drift and pending migrations | Migration risk list |
| 04 | Edge function deployment inventory | Function deploy matrix |
| 05 | Cron and heartbeat reliability | Cron gap plan |
| 06 | Gmail reconnect and Pub/Sub proof | Gmail completion plan |
| 07 | Xero retry/backfill | Xero completion plan |
| 08 | Basiq/bank feed | Bank feed completion plan |
| 09 | Auto-reconciliation | Reconciler implementation plan |
| 10 | OCR provider and bill extraction | OCR repair plan |
| 11 | GST coverage and BAS readiness | GST gate plan |
| 12 | Double-entry schema | GL schema plan |
| 13 | Posting rules | Posting rule plan |
| 14 | Reporting migration | P&L/BS/TB migration plan |
| 15 | BAS compliance | BAS implementation plan |
| 16 | Payroll/STP | STP completion plan |
| 17 | SuperStream/super payments | Super completion plan |
| 18 | Fixed assets/depreciation | Fixed asset plan |
| 19 | Credit notes/adjustments | Adjustment plan |
| 20 | Period locks | Lock coverage plan |
| 21 | Connector API gateway | Gateway plan |
| 22 | Ingest endpoint handlers | Ingest plan |
| 23 | API key UI | Key-management UI plan |
| 24 | OpenAPI/docs | API docs plan |
| 25 | Webhook HMAC/replay | Webhook security plan |
| 26 | Audit logging | Audit trigger plan |
| 27 | SECURITY DEFINER hardening | Definer hardening list |
| 28 | FK indexes/performance DB | Index plan |
| 29 | Tenant isolation/CI | CI gate plan |
| 30 | Accounting test suite | Test coverage plan |
| 31 | Bills UX | Bills polish plan |
| 32 | Invoices UX | Invoices polish plan |
| 33 | Reconciliation UX | Reconciliation polish plan |
| 34 | Dashboard/home UX | Dashboard polish plan |
| 35 | Accountant portal UX | Accountant polish plan |
| 36 | Tag-drop UX | Tag-drop polish plan |
| 37 | Notifications UX | Notifications polish plan |
| 38 | Settings/onboarding UX | Settings polish plan |
| 39 | Legal horizon/RAG UX and backend | Legal RAG plan |
| 40 | Receipt Hub/POS | Receipt Hub plan |
| 41 | Accessibility | A11y gap list |
| 42 | Mobile/responsive | Responsive gap list |
| 43 | Performance/bundle splitting | Performance plan |
| 44 | Error handling and observability | Observability plan |
| 45 | Data model documentation | Data docs plan |
| 46 | User-facing docs/runbooks | Runbook plan |
| 47 | Deployment/rollback process | Release plan |
| 48 | Security/product threat model | Threat model |
| 49 | Demo/sample data and QA scripts | QA/demo plan |
| 50 | Final polish and acceptance criteria | Acceptance checklist |

## Implementation Wave Rules

After the 50-agent audit wave returns:

1. Consolidate duplicate findings into a single task board.
2. Sort tasks into P0/P1/P2 and assign evidence requirements.
3. Run implementation in small batches of 4 to 8 write-scoped workers.
4. No two workers edit the same file family.
5. Every worker must include tests or a clear reason tests are not applicable.
6. Main thread integrates, runs full gates, and updates ledgers.
