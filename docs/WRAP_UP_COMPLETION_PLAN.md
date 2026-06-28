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

- Local gates passed on 2026-06-29 after the wrap-up DB/doc work:
  `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm run test`,
  and `npm run build`.
- Full Vitest result from that pass: 32 passed / 14 skipped files, 161 passed /
  31 skipped tests.
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
- Supabase secret-name check found the scanner provider key present, but no
  `OPENAI_API_KEY`, `LEGAL_INGEST_SECRET`, `LEGAL_SYNC_SECRET`, or
  `LEGAL_SCAN_SECRET` configured by those names. Do not expose secret values in
  follow-up reports.

## Workstream 1: Legal RAG And Horizon

**Current status:** code-complete surfaces exist; production proof is blocked.

Completed:

- `legal_corpus`, `legal_sources`, `legal_change_events`, and `legal_horizon`
  schema are live with hardened grants.
- `legal-corpus-ingest`, `legal-corpus-sync`, `legal-horizon-scan`, and
  `legal-horizon-run` code paths exist.
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
- Replace the `legal-corpus-sync` raw-HTML fetch stub with real FRL/ATO text and
  compilation-date extraction before any corpus sync cron is enabled.

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
