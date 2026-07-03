# Looplet Accounting Implementation Queue

Created: 2026-06-29

Source evidence: `.claude/scratch/parallel-roadmap/agent-01.md` through
`.claude/scratch/parallel-roadmap/agent-50.md`, `.claude/scratch/ledger.md`,
`AUDIT.md`, and the current repo state.

## Current State

- All 50 read-only audit reports exist under `.claude/scratch/parallel-roadmap/`.
- SC-1A through SC-2G are locally complete per the ledger, with local gates recorded as green.
- Live tag-overlay proof remains blocked until the accountant/tag migrations and `team-invite` are deployed.
- Implementation must now proceed through write-scoped slices, not broad "fix everything" passes.

## Promotion Rules

Every implementation item below must declare:

1. Objective.
2. File ownership.
3. Dependencies.
4. Tests required.
5. Live proof required.
6. Rollback or disablement path.

No worker should edit outside its declared scope without stopping and recording the conflict. Migration numbering must be coordinated by a single owner before any slice creates a new migration.

## Recommended Next Slice

Start with `P0-01 Pending Membership Access Gate`.

Reason: it is a hard tenant-isolation/security gate. Deploying the accountant/tag work before this is fixed can allow an existing invited user to see an organization before explicitly accepting the invite.

## P0 Queue - Release And Security Blockers

### P0-01 Pending Membership Access Gate

Objective: pending `organization_memberships` must not grant org access until `accepted_at` is set.

Source agents: 02, 29, 48, 50.

File ownership:

- `supabase/migrations/<next>_accepted_membership_access.sql`
- `src/contexts/OrgContext.tsx`
- `supabase/functions/team-invite/index.ts`
- `src/pages/AcceptInvite.tsx`
- focused tests under `tests/` and `src/test/`

Dependencies: none, but coordinate migration numbering with all other P0 database work.

Tests required:

- RLS test proving pending members cannot read org data.
- Org provider test proving pending orgs are not selectable.
- Invite acceptance test proving access appears only after acceptance.
- Existing tenant-isolation gate remains green.

Live proof required:

- Invite an existing test user to a client org.
- Before acceptance, prove the org is absent from the UI and RLS reads return zero rows.
- After acceptance, prove the org appears and reads are limited to the accepted org.

Rollback path: disable existing-user pending invite creation or require Supabase invite email success only. Do not roll back by restoring pending-membership access.

### P0-02 Tag Draft Constraint And Indexes

Objective: make the frontend `tag_drafts` upsert contract true in the database.

Source agents: 02, 28, 50.

File ownership:

- `supabase/migrations/<next>_tag_draft_contract.sql`
- `src/components/tag-drop/*` only if the product scope changes
- `src/test/components/TagDrop.test.tsx`

Dependencies: migration numbering. Can share a migration with P0-01 only if one migration owner coordinates both.

Tests required:

- Migration/static test proving unique `(user_id, organization_id, page_url)`.
- Tag draft save/update test against mocked Supabase call shape.
- `git diff --check`, lint, test, typecheck.

Live proof required:

- Draft save and second save update the same live row, not duplicate rows.
- Tag creation path still works without relying on draft state.

Rollback path: hide/disable draft autosave while keeping tag creation and mentions active.

### P0-03 Invite Fallback Token Redemption

Objective: `/accept-invite?token=<uuid>` must redeem unauthenticated fallback invites or the fallback path must be removed from production claims.

Source agents: 02, 03, 50.

File ownership:

- `supabase/functions/team-invite/index.ts`
- `src/pages/AcceptInvite.tsx`
- optional migration/RPC if token redemption moves into Postgres
- invite-focused tests

Dependencies: P0-01, because redemption must grant access only at acceptance time.

Tests required:

- Existing-user invite.
- New-user invite.
- Invalid/expired token.
- Reuse attempt after successful acceptance.

Live proof required:

- Supabase invite email path works, or fallback link signs in/redeems through the intended path.
- Before acceptance, RLS remains closed.

Rollback path: remove fallback-token links and fail closed when Supabase invite email cannot be sent.

### P0-04 Media Attachment Scope

Objective: tag comments/drawings can be claimed now; image/audio/video attachments must either persist durably or be explicitly deferred in UI and docs.

Source agents: 02, 36, 50.

File ownership:

- `src/components/tag-drop/TagDropManager.tsx`
- `src/components/tag-drop/TagDropPopup.tsx`
- tag attachment service/storage helpers if added
- tag tests

Dependencies: deployed tag tables/storage policies if durable upload is implemented.

Tests required:

- If implemented: upload success, upload failure, and metadata persistence tests.
- If deferred: UI test proving unavailable controls are hidden or labelled deferred.

Live proof required:

- If implemented: attach media, reload, and prove it still renders.
- If deferred: live proof explicitly excludes image/audio/video from acceptance scope.

Rollback path: hide attachment controls while preserving comments, drawings, mentions, and deep links.

### P0-05 Accountant/Tag Deployment And Live Proof

Objective: deploy the local accountant/tag schema and functions, then prove the full overlay live.

Source agents: 01, 02, 03, 04, 50.

File ownership:

- `supabase/migrations/0199_accountant_portal.sql`
- `supabase/migrations/0200_tag_drop.sql`
- `supabase/migrations/0201_tag_functions.sql`
- `supabase/functions/team-invite/index.ts`
- `.claude/scratch/ledger.md`

Dependencies: P0-01 through P0-04, unless deferrals are explicitly recorded.

Tests required:

- Full local gate on the exact deploy SHA.
- Post-deploy SQL proving tag tables/RLS/RPCs exist.
- Function list proving `team-invite` is redeployed.

Live proof required:

- Signed-in accountant opens tag overlay against real `public.tags`.
- Mention notification appears in bell and inbox.
- `/bills?tag=<uuid>` deep link works.
- Screenshot proof, refreshed browser console status, and manual interaction notes.

Rollback path: follow the manual deploy runbook. Do not use broad `supabase db push` until migration baseline repair is complete.

### P0-06 Connector Gateway PostgREST Hardening

Objective: connector gateway tokens must not bypass scoped write enforcement through PostgREST.

Source agents: 21, 24, 48, 50.

File ownership:

- `supabase/functions/api-gateway/index.ts`
- `supabase/functions/_shared/apiKeys.ts`
- connector hardening migration
- `docs/connector-guide.md`
- `docs/openapi.yaml`
- `RUNBOOK_DEPLOY.md`
- connector tests

Dependencies: custom PostgREST role feasibility or a claim-based RLS fallback decision.

Tests required:

- Write-only key cannot exchange for a read JWT.
- Read-scoped key can read only its org.
- Connector JWT cannot POST/PATCH/DELETE representative org tables.
- Ingest remains the only scoped write surface.

Live proof required:

- Throwaway connector key in a test org proves 403 for write-only gateway exchange.
- Read JWT cannot mutate `bills`, `invoices`, or another representative org table.
- Human signed-in RLS smoke still works.

Rollback path: disable gateway exchange or return 403-only while leaving `ingest`/receipt writes available.

### P0-07 API Key Storage And Rate Limit Hardening

Objective: `api_keys` lifecycle must be RPC-controlled, rate limiting must execute under service role, and `hashed_key` must not be client-readable.

Source agents: 21, 27, 48, 50.

File ownership:

- API key hardening migration
- `supabase/functions/_shared/apiKeys.ts`
- API-key UI contract files only if required
- connector tests

Dependencies: P0-06 can be implemented in parallel only if migration ownership is coordinated.

Tests required:

- `api_key_rate_limit` executable by `service_role`.
- Authenticated users cannot select `hashed_key`.
- Direct authenticated INSERT/UPDATE on `api_keys` fails.
- `issue_api_key` requires admin/owner and has pgcrypto search path fixed.

Live proof required:

- Issue, use, rate-limit, revoke, and expired-key paths are all recorded in `api_request_log`.
- Direct table escalation attempts fail.

Rollback path: keep restrictive table privileges. If issuance breaks, disable key creation temporarily rather than exposing `hashed_key` or direct DML.

### P0-08 Frontend Error Boundary And Login Accessibility

Objective: prevent white screens and unblock keyboard/screen-reader login.

Source agents: 41, 44, 50.

File ownership:

- `src/main.tsx`
- `src/App.tsx`
- `src/pages/Login.tsx`
- `src/components/Layout.tsx`
- `src/index.css`
- new error fallback component if needed
- focused React tests

Dependencies: none.

Tests required:

- Error boundary fallback renders and reset/retry works.
- Login labels are programmatically associated.
- Skip link targets main content.
- `.btn` has visible `:focus-visible` style.
- `aria-live` announces login errors/status.

Live proof required:

- Browser screenshot of login.
- Keyboard-only tab path through login and skip link.
- Refreshed console with no page errors.

Rollback path: error boundary can be disabled by reverting wrapper only; do not revert the accessibility fixes.

### P0-09 Branch Hygiene And Gate Baseline

Objective: keep the current dirty branch reviewable before broader implementation waves start.

Source agents: 01, 47, 50.

File ownership:

- docs/ledger updates
- no production code unless a gate failure demands it

Dependencies: all P0 code slices that land before deployment.

Tests required:

- `git diff --check`
- `npm run lint`
- `npm run test`
- `npm run typecheck`
- `npm run build`
- no ignored scratch harness files staged

Live proof required: none for this docs/gate slice; live proof belongs to feature slices.

Rollback path: split unrelated work into smaller commits or PRs rather than reverting user changes.

## P1 Queue - Reliability And Accounting Foundations

### P1-01 Cron Heartbeat No-Success-Window Monitor

Source agents: 05, 47, 50.

File ownership: cron heartbeat migration, core cron functions, operator health UI or runbook.

Acceptance gates: durable `cron_heartbeat_jobs`, `cron_heartbeat_runs`, `cron_no_success_windows()`, body-level soft-failure parsing, and live proof that stale jobs alert.

### P1-02 Basiq Bank Feed Durability

Source agents: 08, 09, 25, 50.

File ownership: Basiq migrations, `bank-link-token`, `bank-job-poll`, `bank-exchange`, `bank-sync`, `bank-sync-all`, `bank-webhook`, settings bank UI, tests.

Acceptance gates: source-controlled `organizations.basiq_user_id`, link job ledger, sync run ledger, webhook event persistence before ack, HMAC verification or documented provider constraint, replay, idempotent sync, and live Basiq sandbox proof.

### P1-03 OCR Repair And Bill Extraction Quality

Source agents: 10, 11, 50.

File ownership: OCR provider config/docs, `_shared/ocr/*`, `bills-extract`, `bills-extract-batch`, extraction-attempt migration, Bills/BillDetail exception UI.

Acceptance gates: chosen provider contract, durable attempts, failed extraction not marked verified, line items persisted, manual GST edit sets `gst_estimated`, fixture accuracy gate, and live repair proof with target coverage.

### P1-04 GL Foundation And Canonical Posting RPC

Source agents: 12, 13, 14, 50.

File ownership: GL migrations, posting RPCs, `coding-classifier`, depreciation/accrual posting callers, report hooks only after parity.

Acceptance gates: COA roles, posting keys, locked-period rejection, `create_and_post_journal`, date-scoped trial balance, zero-net trial balance proof, and no report cutover until parity is proven.

### P1-05 Accounting-Engine CI Tests

Source agents: 29, 30, 49, 50.

File ownership: `tests/`, `package.json`, CI workflow, Deno test wiring.

Acceptance gates: deploy-blocking tests for GST split, BAS, reconciliation, PAYG, ABA formatting, Xero push stub/structure, and a `npm run test:accounting` script.

### P1-06 SECURITY DEFINER And Notify Guard Hardening

Source agents: 27, 48, 50.

File ownership: hardening migrations and security tests.

Acceptance gates: `PUBLIC` execute revoked from security-definer functions, `notify()` rejects cross-org calls, orphan functions dropped if present, and advisor warnings triaged.

### P1-07 High-Impact FK Indexes

Source agents: 28, 50.

File ownership: additive FK-index migration and performance proof notes.

Acceptance gates: high-impact FK indexes added idempotently, `tag_drafts` indexes included, advisor count reduced, and no RLS behavior changes.

### P1-08 Xero Retry And Backfill Reliability

Source agents: 07, 30, 50.

File ownership: `_shared/xero/*`, Xero edge functions, retry/backfill schema, tests.

Acceptance gates: durable retry state, idempotency keys, 401/429 behavior tests, stub-mode CI coverage, and Xero demo-company proof before production use.

### P1-09 Gmail Reconnect And Disconnect Notification

Source agents: 06, 37, 50.

File ownership: Gmail watch/renew/push functions, notification surfaces, tests/runbook.

Acceptance gates: live Pub/Sub trace, fatal `invalid_grant` disables and notifies, watch-renew gateway mode proven, and replay/backfill path documented.

## P2 Queue - Completion Epics

### P2-01 Source Posting Coverage

Own postings for invoices, invoice payments, bank transactions, payment runs, payroll, GST, adjustments, depreciation, opening balances, manual journals, credit notes, and reversals through the canonical posting RPC.

### P2-02 BAS And Compliance Completion

Complete BAS labels, GST coverage gates, PAYG-I/PAYGW correctness, ATO lodgement/manual export, period locks across money tables, and immutable source drilldown.

### P2-03 Payroll, STP, Super, Assets, And Credit Notes

Finish payroll profile data, STP Phase 2 readiness, SuperStream or clearing-house path, fixed asset acquisition/disposal/depreciation, and AR/AP credit-note workflows.

### P2-04 Connector Product Surface

Build API-key management UI, scope UX, OpenAPI publication, connector examples, and operator-visible audit/last-used state after the security contract is hardened.

### P2-05 Product UX, Mobile, And Cross-Browser Smoke

Run Chromium/Firefox smoke on core routes, fix mobile/tablet issues, improve empty/loading/error states, and complete keyboard/focus testing across main workflows.

### P2-06 Performance And Production Security Polish

Add route-level splitting, optimize large assets, disable production sourcemaps or strip maps, add CSP headers, narrow CORS where practical, and add audit automation.

### P2-07 Deployment, Rollback, And Docs

Repair migration baseline, add rollback runbook, add staging/deploy workflow, reconcile function inventory, and create a docs index with stale/proposal/internal labels.

## First Implementation Wave

Run at most four write-scoped slices in parallel:

1. P0-01 pending membership access gate.
2. P0-06/P0-07 connector/API-key hardening, with one migration owner.
3. P0-08 frontend error boundary and login accessibility.
4. P0-02 tag draft contract, only if it does not contend for the same migration file.

Hold P0-05 deployment until the security and tag-contract blockers are resolved or explicitly deferred with acceptance scope reduced.
