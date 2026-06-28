# Wrap-up Completion Plan

**Date:** 2026-06-29  
**Goal:** `wrap up completion of app`  
**Live project:** `dxoikltymmknxqpkpyhi`

This is the current finish plan after proofreading the completed Claude ledger
work and re-checking the live project. It intentionally separates:

- **code-complete:** implementation and tests are present;
- **live-proven:** deployed and verified against the linked project;
- **blocked:** cannot be finished without external material, credentials, or a
  signed-in production-style account path;
- **deferred:** intentionally out of scope for this wrap-up.

## Evidence Baseline

- Local gates passed on 2026-06-29 after the Gmail Pub/Sub hardening and
  wrap-up audit work:
  `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm run test`,
  and `npm run build`.
- Full Vitest result from that pass: 36 passed / 16 skipped files, 171 passed /
  33 skipped tests.
- Build warnings remain known and pre-existing: pdfjs dynamic-import warning and
  a main chunk larger than 500 kB.
- Live migration parity is closed for every current local migration through
  `0196`; `supabase db push --linked --dry-run` returned
  `Remote database is up to date.`
- Fresh live blocker counts checked on 2026-06-29:
  `legal_sources=7`, `legal_corpus=0`, `legal_change_events=0`,
  `legal_horizon=0`, `advice_notes=1`, `receipt_events=0`,
  enabled `receipt_sync_endpoints=0`, enabled `xero_integrations=0`, and
  pending-ish `receipt_sync_jobs=0`.
- Receipt Hub live service check on 2026-06-29: `bills-extract`,
  `receipt-webhook`, and `receipt-sync-dispatch` are active Edge Functions, and
  the `receipt-sync-dispatch-drain` cron is active on
  `3,18,33,48 * * * *`.
- Legal RAG source-material check found no local NotebookLM/legal source bundle.
  Only scratch ledgers and generic planning docs matched the legal-source file
  search.
- `legal-corpus-sync` now resolves FRL sources through the official
  `/latest/text` EPUB HTML pages and extracts clean legal text plus compilation
  date metadata instead of passing raw markup to the chunker. Local live-source
  proof against the current ITAA 1997 FRL page extracted 7,758,792 characters,
  produced 5,956 chunks, and found `s 8-1 General deductions`.
- The updated `legal-corpus-sync` bundle is deployed live as version 3. Live
  smoke on 2026-06-29: OPTIONS returned 200 with CORS, unauthenticated POST
  reached the function and returned `{"ok":false,"error":"Unauthorized"}` with
  HTTP 401, no legal corpus/horizon cron is scheduled, and legal row counts
  stayed `legal_sources=7`, `legal_corpus=0`, `legal_change_events=0`,
  `legal_horizon=0`.
- Supabase secret-name check found the scanner provider key present, but no
  `OPENAI_API_KEY`, `LEGAL_INGEST_SECRET`, `LEGAL_SYNC_SECRET`, or
  `LEGAL_SCAN_SECRET` configured by those names. Do not expose secret values in
  follow-up reports.
- `npm run wrap:live-audit` now provides a repeatable redacted blocker audit.
  On 2026-06-29 it passed against project `dxoikltymmknxqpkpyhi`: `advisor`,
  `receipt-webhook`, `legal-corpus-sync`, and `gmail-pubsub-push` all returned
  CORS-capable OPTIONS 200; selected live Edge Functions were active; live
  secret-name presence was true for `PERPLEXITY_API_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
  `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_VERIFY_TOKEN`, and
  `GMAIL_WATCH_RENEW_CRON_SECRET`, `BANK_SYNC_ALL_CRON_SECRET`,
  `NOTIFICATIONS_CRON_SECRET`, and `ACCOUNTANT_SESSION_DIGEST_CRON_SECRET`, and
  false for `OPENAI_API_KEY`, `LEGAL_INGEST_SECRET`, `LEGAL_SYNC_SECRET`, and
  `LEGAL_SCAN_SECRET`.
- `gmail-pubsub-push` is deployed live as version 34. It now shares the Gmail
  message-id duplicate guard with backfill, leaves `last_history_id` unchanged
  on retryable ingest failures so future pushes can replay safely, and the live
  audit proves unsigned POSTs fail closed with HTTP 401.
- `bank-sync`, `bank-sync-all`, and `notifications-cron` have had the
  forgeable service-role branch removed. Live versions after deploy:
  `bank-sync` 28, `bank-sync-all` 26, and `notifications-cron` 23. The live
  audit proves forged `bank-sync` service-role JWTs fail closed with HTTP 401,
  unsigned `bank-sync-all` and `notifications-cron` POSTs fail closed with HTTP
  403, both cron runtime secret names exist in Supabase, and all three
  functions are active.
- `bank-sync-all` cron auth is fixed live. The old active schedule sent no
  auth; it is now active as cron job 14 and reads a scoped
  `bank_sync_all_cron_secret` from Supabase Vault when building the `?secret=`
  URL. A direct authorized function probe returned HTTP 200 with `ok=true`,
  `orgs=0`, and a DB-side `pg_net` probe through the same Vault path returned
  HTTP 200 with `{"ok":true,"orgs":0,"results":[]}`.
- `accountant-session-digest` cron auth is fixed live. The function is deployed
  as version 19 with `verify_jwt=false`, cron mode now requires exact
  `ACCOUNTANT_SESSION_DIGEST_CRON_SECRET` or service-role bearer, and
  browser/on-demand modes still verify the caller JWT internally. The active
  cron is job 15 and reads a scoped `accountant_session_digest_cron_secret` from
  Supabase Vault. The live audit proves unsigned cron-mode POSTs fail closed
  with HTTP 403, and a DB-side `pg_net` probe through the Vault path returned
  HTTP 200 with `{"ok":true,"sent":0,"failed":0}`. The first scheduled post-fix
  run at `2026-06-28T20:00:00Z` also returned HTTP 200 with `sent=0`,
  `failed=0`.
- Core autopilot cron registration is now tracked in
  `0197_track_vault_backed_cron_schedules.sql`: `bank-sync-all`,
  `notifications-cron-nightly`, and `accountant-digest-cron` all use
  Vault-backed command strings in live `cron.job`, contain no `<...>`
  placeholders, and avoid embedding scoped secret values in the cron command.
  Live migration history includes version `0197` with name
  `track_vault_backed_cron_schedules`.

## Execution Control Plan

Rule: do not mark a ledger finished until the matching evidence is captured.
Use these statuses consistently in `docs/COMPLETION_AUDIT.md` and this plan:
`live-proven`, `code-complete`, `external-blocked`, or `deferred`.

Current repo re-checks against the May 6 P1 audit:

- Customer create UI is now present on `/customers`.
- Job create UI is now present on `/jobs`.
- Triage now has bulk approval/dismissal controls, including high-confidence AI
  and Sonar picks.
- Bill detail has inline edit/save for extracted fields.
- `MoveToOrgButton` is wired on bill, invoice, job, customer, and supplier
  detail pages.
- Subscription detail, debt detail/payment recording, and employee detail pages
  now exist.
- Dashboard now surfaces pending onboarding triage via a direct
  `/onboarding/triage` CTA without loading the full staged-entity list.
- Org profile write-through for `abn` and `organizations.settings` is covered by
  a focused component test.
- Debt detail payment recording is covered by a focused page test that verifies
  `debt_payments` insert payloads and principal balance reduction.
- Subscription detail editing is covered by a focused page test that verifies
  status, cadence, notes, and mutually exclusive personal/business
  classification save payloads.
- Employee detail timesheet behavior is covered by focused page tests that
  verify inline timesheet updates recompute total cost from loaded rate and new
  log-time entries include job, entry type, notes, loaded rate, and org/employee
  IDs.
- Multi-org move behavior is covered by focused component tests that verify the
  exact `organization_id` update payload, FK-null clearing where requested, and
  debt-row moves without FK clearing.
- Gmail Pub/Sub replay is no longer a stub: the live function reads Gmail
  history deltas, downloads accepted attachments, applies intake rules, creates
  `bills`, dispatches `bills-extract`, guards duplicate Gmail message IDs across
  backfill/push overlap, and only advances the Gmail history cursor after the
  delta is durably handled.
- A deterministic Chromium visual smoke now mounts the changed local UX surfaces
  with mocks, performs the key interactions, captures screenshots, and verifies
  zero browser console/page errors. This is local browser proof, not signed-in
  production proof.

Remaining execution order:

1. **Close stale audit bookkeeping.** Keep the historical May 6 audit intact,
   but annotate which P1 items are now code-complete and which still require
   live proof.
2. **Verify local app UX ledgers.** Org profile settings write-through,
   Dashboard-to-Triage discoverability, debt payment behavior, subscription
   detail editing, employee timesheet behavior, and multi-org move behavior now
   have focused tests. Signed-in browser proof is still required before marking
   the app release as live-proven.
3. **Finish signed-in live proof.** Run the Advisor and Receipt Hub live smoke
   tests once `TEST_USER_JWT`, `TEST_ORG_ID`, and service-role cleanup
   credentials are available locally. The live audit confirms the project has a
   service-role secret configured, but the local test harness still needs a
   non-secret test org ID plus a signed-in JWT. Capture UI screenshots,
   console/network status, and non-secret row metadata.
4. **Finish Legal RAG/Horizon proof.** Seed approved legal source text, configure
   embedding/operator secrets, verify corpus search/citations, then run Horizon
   with a real scanner path before any cron is enabled.
5. **Finish data-starvation ledgers.** Import the queued bank statement PDFs,
   run subscription detection, process pending triage classifications into
   `intake_rules`, and populate at least one real customer/invoice/payment path.
6. **Resolve remaining integration ledgers.** Complete or explicitly defer
   Basiq callback backfill, Xero settings/sync, heartbeat monitoring, and ATO
   lodgement enablement. Gmail Pub/Sub, bank-sync-all cron auth, and accountant
   digest cron auth are code-complete and live-deployed; Gmail still needs real
   watched-mailbox event evidence, and bank sync still needs a real Basiq
   feed/backfill before being marked end-to-end live-proven. External
   credentials stay `external-blocked` until supplied and proven.
7. **Final release pass.** Re-run all local gates, browser smoke the critical
   UI surfaces, re-check live row counts, update final labels, and commit only
   evidence-backed changes.

Local verification added during this pass:

- `npm run test -- src/test/components/OrgProfile.test.tsx
src/test/pages/Dashboard.test.tsx` passed: 2 files, 4 tests.
- `npm run test -- src/test/pages/DebtDetail.test.tsx
src/test/pages/SubscriptionDetail.test.tsx` passed: 2 files, 2 tests.
- `npm run test -- src/test/pages/EmployeeDetail.test.tsx
src/test/components/MoveToOrgButton.test.tsx` passed: 2 files, 12 tests.
- `npm run wrap:visual-smoke` passed in Chromium with no console/page errors and
  all interaction checks true. Screenshot evidence:
  `.claude/scratch/wrap-up-local-visual-smoke/2026-06-28T19-21-08-902Z/screenshots/dashboard.png`,
  `org-profile.png`, `debt-payment-dialog.png`, `subscription-edit.png`,
  `employee-log-time.png`, and `move.png`.
- `npm run test -- tests/advisor-live-smoke.test.ts
tests/receipt-hub-live-smoke.test.ts` was skipped by design because local
  signed-in proof prerequisites are missing: `SUPABASE_SERVICE_ROLE_KEY`,
  `TEST_USER_JWT`, and `TEST_ORG_ID`.
- `npm run wrap:live-audit` passed. It verified non-secret project metadata,
  selected active function versions, CORS-capable OPTIONS responses for the
  deployed blocker functions, and live secret-name presence without printing
  secret values or digests.
- `deno test supabase/functions/_shared/gmail/dedupe.test.ts
supabase/functions/_shared/gmail/pubsub.test.ts` passed: 5 tests.
- `deno check supabase/functions/_shared/gmail/dedupe.test.ts
supabase/functions/_shared/gmail/pubsub.test.ts
supabase/functions/_shared/gmail/ingest.ts
supabase/functions/gmail-pubsub-push/index.ts` passed.
- `supabase functions deploy gmail-pubsub-push --project-ref
dxoikltymmknxqpkpyhi --no-verify-jwt` deployed the hardened Gmail Pub/Sub
  handler. The follow-up `npm run wrap:live-audit` passed with
  `gmail-pubsub-push` active as version 34, CORS OPTIONS 200, live Gmail
  runtime secret-name presence, and unsigned POST fail-closed status 401.
- `deno test supabase/functions/_shared/serviceRole.test.ts` passed: 3 tests.
  It proves exact service-role bearer matching, exact cron secret matching, and
  rejection of a forged JWT whose unverified payload claims
  `role=service_role`.
- `deno check supabase/functions/_shared/serviceRole.test.ts
supabase/functions/bank-sync/index.ts
supabase/functions/bank-sync-all/index.ts
supabase/functions/notifications-cron/index.ts` passed.
- `supabase functions deploy bank-sync --project-ref dxoikltymmknxqpkpyhi`,
  `supabase functions deploy bank-sync-all --project-ref
dxoikltymmknxqpkpyhi --no-verify-jwt`, and `supabase functions deploy
notifications-cron --project-ref dxoikltymmknxqpkpyhi --no-verify-jwt`
  deployed the hardened bank/cron handlers.
- The follow-up `npm run wrap:live-audit` passed with `bank-sync` active as
  version 29, `bank-sync-all` as version 27, `notifications-cron` as version
  24, CORS OPTIONS 200 for both cron endpoints, live cron secret-name presence,
  forged `bank-sync` service-role JWT fail-closed status 401, and unsigned
  `bank-sync-all`/`notifications-cron` fail-closed status 403.
- Live cron inspection showed `bank-sync-all` was still scheduled without auth.
  A fresh scoped secret was set for `BANK_SYNC_ALL_CRON_SECRET`, mirrored into
  Supabase Vault as `bank_sync_all_cron_secret`, and the cron was rescheduled as
  active job 14. Verification: direct authorized function call returned HTTP
  200 with `ok=true`, `orgs=0`; DB-side `pg_net` through the Vault-held secret
  returned request id 7932 with status 200, `timed_out=false`, and
  `{"ok":true,"orgs":0,"results":[]}`.
- `deno check supabase/functions/_shared/serviceRole.test.ts
supabase/functions/accountant-session-digest/index.ts` passed.
- `supabase functions deploy accountant-session-digest --project-ref
dxoikltymmknxqpkpyhi --no-verify-jwt` deployed the self-authenticating digest
  handler. The follow-up `npm run wrap:live-audit` passed with
  `accountant-session-digest` active as version 19, CORS OPTIONS 200, live
  `ACCOUNTANT_SESSION_DIGEST_CRON_SECRET` name presence, and unsigned cron-mode
  POST fail-closed status 403.
- The live digest cron was rescheduled from the missing `service_role_key`
  bearer form to active job 15 with a Vault-held scoped secret. Verification:
  pending digest count was 0 before the authorized probe; DB-side `pg_net` through
  the Vault-held secret returned request id 7934 with status 200,
  `timed_out=false`, and `{"ok":true,"sent":0,"failed":0}`.
- The actual scheduled `accountant-digest-cron` job then fired at
  `2026-06-28T20:00:00Z`; `net._http_response` request id 7935 returned status
  200, `timed_out=false`, and `{"ok":true,"sent":0,"failed":0}`.
- `public.cron_health_summary()` after the fix shows
  `accountant-digest-cron.last_run_pg_status=succeeded`; the 24-hour HTTP
  failure count is still 42 from historical 401/403 responses and must age out
  before being used as clean-window proof.
- Added and applied `supabase/migrations/0197_track_vault_backed_cron_schedules.sql`.
  Because `supabase db push --linked --dry-run` is unavailable in this
  environment without `SUPABASE_DB_PASSWORD`, the migration SQL was applied via
  `supabase db query --linked -f`, and version `0197` was recorded in
  `supabase_migrations.schema_migrations` as
  `track_vault_backed_cron_schedules`.
- Rotated `NOTIFICATIONS_CRON_SECRET` into a fresh scoped value stored in
  Supabase Edge Function secrets and Supabase Vault as `notifications_cron_secret`.
  Live cron verification showed `bank-sync-all`, `notifications-cron-nightly`,
  and `accountant-digest-cron` are active, use `vault.decrypted_secrets`, use
  a `secret=` parameter, and contain no `<...>` placeholders.
- `supabase migration list --linked` could not be used for verification because
  the local environment lacks a valid `SUPABASE_DB_PASSWORD`; direct
  `supabase_migrations.schema_migrations` query verified the 0197 history row
  instead.
- `npm run typecheck` passed.
- `npm run lint` passed.
- `npx prettier --check ...` passed on the changed source/test/doc files.
- `npm run format:check` passed.
- `npm run test` passed: 36 passed / 16 skipped files, 171 passed / 33 skipped
  tests.
- `npm run build` passed with the known pdfjs dynamic-import and large chunk
  warnings.
- `git diff --check` passed.

## Workstream 1: Legal RAG And Horizon

**Current status:** code-complete surfaces exist; production proof is blocked.

Completed:

- `legal_corpus`, `legal_sources`, `legal_change_events`, and `legal_horizon`
  schema are live with hardened grants.
- `legal-corpus-ingest`, `legal-corpus-sync`, `legal-horizon-scan`, and
  `legal-horizon-run` code paths exist.
- `legal-corpus-sync` now has a tested official FRL source-fetch path:
  `C2004A05138`-style source URLs resolve to `/latest/text`, EPUB document pages
  are fetched in order, tables of sections/scripts/styles/tags are stripped, and
  FRL effective date/version metadata is captured for the sync cursor.
- `legal-corpus-sync` version 3 is deployed live and still fails closed without
  service-role bearer or `LEGAL_SYNC_SECRET`.
- `legal-horizon-run` is deployed and blocks unauthenticated calls at the
  Supabase gateway.
- The Legal Horizon UI scan controls passed mocked desktop/mobile browser smoke.

Blocked prerequisites:

- Provide the 16 NotebookLM/legal `.txt` source exports, or approve an official
  source-fetching implementation that extracts clean text from FRL/ATO pages
  before ingestion.
- Configure `OPENAI_API_KEY` for `text-embedding-3-small` embeddings.
- Configure operator secrets if driving non-service-role seed/sync/scan paths:
  `LEGAL_INGEST_SECRET`, `LEGAL_SYNC_SECRET`, and `LEGAL_SCAN_SECRET`.
- Register specific ATO Legal Database document/feed URLs, or provide exported
  text, before enabling ATO corpus sync. The generic ATO legal database landing
  page is now refused rather than ingested as source text.

Exit criteria:

- Seed at least the seven registered source names, or the approved smaller
  source set, through `legal-corpus-ingest`.
- Verify non-zero `legal_corpus` rows, 1536-dimension embeddings, and
  `match_legal_corpus` returning law chunks for 2-3 known section queries.
- Ask a signed-in tax question and capture UI evidence that corpus
  `citations[]` render and open the quoted law panel.
- Run `legal-horizon-run` as a signed-in accepted accountant/admin/owner and
  verify real `legal_horizon` rows from the scanner.
- Only after clean source extraction and secrets are proven, enable/schedule
  corpus sync and horizon scan crons.

## Workstream 2: Advisor

**Current status:** deployed; live user-path proof remains.

Completed:

- `advisor` deployed live with JWT enabled.
- Local Deno checks and advisory/model tests passed before deploy.
- No `advisor-scheduled-daily` cron is scheduled.
- One `advice_notes` draft exists live, but there is no signed-in browser trace
  tying it to the Ask/on-demand workflow.
- `tests/advisor-live-smoke.test.ts` now captures the missing live proof once a
  signed-in `TEST_USER_JWT`, `TEST_ORG_ID`, and service-role cleanup key are
  supplied.

Blocked prerequisites:

- Provide a signed-in test user JWT and accessible org, or run the smoke from a
  browser session the user explicitly authorizes. Public sign-up was rate-limited
  during the 2026-06-29 wrap-up pass, local `SUPABASE_SERVICE_ROLE_KEY` is empty,
  and direct SQL auth-user minting did not produce a valid GoTrue password
  session.

Exit criteria:

- Use a signed-in test user with an accessible org.
- Trigger an advisor scenario from Ask or the on-demand UI path.
- Verify the UI response, console status, network status, and resulting
  `advice_notes` draft row.
- Capture screenshot evidence and the exact non-secret row metadata used for
  proof.

## Workstream 3: Receipt Hub SC-13

**Current status:** UI/code surfaces are strong; live chain is data/setup-blocked.

Completed:

- Receipt Tag/Web NFC and WhatsApp delivery scope landed.
- NFC read flow was corrected to wait for a `reading` event or timeout.
- Receipt Hub Chromium/Firefox desktop/mobile smoke passed with screenshots, no
  console/page errors, and no horizontal overflow.
- Receipt sync cron is active.
- Live data/setup check on 2026-06-29 found `receipt_identities=3`,
  `receipt_events=0`, `receipt_sync_jobs=0`, enabled
  `receipt_sync_endpoints=0`, and enabled `xero_integrations=0`.
- `tests/receipt-hub-live-smoke.test.ts` now captures the signed-in SC-13 proof
  path once `TEST_USER_JWT`, `TEST_ORG_ID`, and service-role cleanup credentials
  are supplied. It issues an identity, ingests an `epost` receipt through the
  deployed `receipt-webhook`, verifies the event, bill, line item, audit JSON,
  generic API sync job, and user RLS visibility, then deletes smoke-created rows
  and the audit object.

Blocked prerequisites:

- Provide a signed-in test user JWT, accessible test org, and service-role
  cleanup key to run the live smoke.
- Configure at least one enabled `receipt_sync_endpoints` generic API receiver.
- Provide a usable Xero integration, or explicitly accept stub-mode proof for the
  remaining wrap-up.
- Create live receipt events through signed-in manual/POS/photo flows.

Exit criteria:

- Issue a pass, ingest a receipt, and verify `receipt_events`, bill creation,
  audit JSON, sync job rows, and dispatch result.
- Attach a job and verify the UI reflects the chain.
- Capture signed-in browser screenshots and refreshed console/network status.

## Workstream 4: Accountant/Lodgement Gates

**Current status:** code guards are present; production enablement is externally
blocked.

Blocked prerequisites:

- ATO DSP/EVTE credentials.
- OSF/SBR certification.
- Full SBR taxonomy hosting/loading strategy for Edge Functions.

Exit criteria:

- Keep all lodge/send/final actions fail-closed until credentials and taxonomy
  are proven.
- Run post-deploy smoke tests that demonstrate blocked actions return the
  expected secret-free 403 payloads while prerequisites are absent.
- Only mark lodgement ledgers live-proven after ATO pre-prod/prod receipts are
  available.

## Workstream 5: Final Release Pass

Run this after the blocked workstreams are either completed or explicitly marked
external/deferred:

1. Re-run `npm run format:check`, `npm run typecheck`, `npm run lint`,
   `npm run test`, and `npm run build`.
2. Run browser smoke on Ask/Advisor, Legal Horizon, Receipt Hub, BAS, and Tax
   Timeline.
3. Capture screenshots, refreshed browser console status, and manual interaction
   notes for every UI surface.
4. Re-check live row counts for Legal RAG, Horizon, Advisor, Receipt Hub, and
   sync jobs.
5. Update `docs/COMPLETION_AUDIT.md` with final status labels:
   `live-proven`, `code-complete`, `external-blocked`, or `deferred`.
6. Commit only evidence-backed doc/code changes.
