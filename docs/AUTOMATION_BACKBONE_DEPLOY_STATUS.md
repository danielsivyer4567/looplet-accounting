# Automation Backbone — True Live Deploy Status

_Last updated: 2026-07-01_

The Automation Backbone epic (ledger `.claude/scratch/ledger.md`, slices SC-01..SC-10)
was marked `[done]` with commits, but its **"DONE (machine)" claims were local-only**
(tsc / build / live-gated-but-skipped tests). A live verification on **2026-07-01**
against prod project `dxoikltymmknxqpkpyhi` found **none of the epic's DB objects
existed** — the local migration numbers `0211`–`0219` had collided with a different,
out-of-band GL-posting chain already applied on prod.

This document records what is now actually live and what remains.

## ✅ Live on prod (verified 2026-07-01)

Applied via Supabase MCP as forward-only repair migrations above the remote head
(`20260630124815`), idempotent, dry-run-verified in a rolled-back transaction first:

| Migration (recorded)                                   | Covers                                                                                                                                                                                                                                                              | Verification                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260630170735_automation_backbone_repair`            | SC-01 (automation_jobs + 4 tables + 5 RPCs), SC-04 (confidence_policies + 3 RPCs), SC-05 (document_extraction_versions), SC-06 (bank_events_raw + raw_event_id FK + replay_bank_event), SC-07 (reconciliation_evidence), SC-08 (browser_sessions, browser_job_runs) | All `to_regclass`/`to_regprocedure` resolve; SC-06 dedup + null-org partial-unique + replay behavioral checks passed against live prod (rolled back) |
| `20260630171500_automation_backbone_definer_hardening` | Security fix (see below)                                                                                                                                                                                                                                            | Anon access to `replay_bank_event` confirmed denied on persisted prod state; ACL = `service_role` only                                               |

### Security fix included

A Supabase advisor + a rolled-back `SET ROLE anon` probe confirmed that
`replay_bank_event` (orig SC-06 / 0217) was **executable by the anon role and
returned raw bank payloads** to unauthenticated callers via
`/rest/v1/rpc/replay_bank_event`. Two causes: EXECUTE held via the PUBLIC default
grant (which `REVOKE FROM anon` does not remove), and an `auth.uid() IS NULL`
allow-path that anon also matches. The hardening migration revokes EXECUTE from
PUBLIC/anon/authenticated on `replay_bank_event` + the four worker-internal job
RPCs (`claim/complete/fail/dead_letter_automation_job`), and rewrites
`replay_bank_event` to fail closed unless `auth.role() = 'service_role'`.

The four functions intentionally callable by `authenticated` (org-authz enforced
internally) were left as-is: `enqueue_automation_job`, `get_confidence_policy`,
`upsert_confidence_policy`, `delete_confidence_policy`.

## ✅ Edge deploys completed after source fixes (verified 2026-07-01)

| Function               | Live version | Verification                                                                                                                                                                                                                                   |
| ---------------------- | -----------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automation-worker`    |            5 | `supabase functions deploy automation-worker` succeeded after browser-job claim hardening; `functions list` updated to `2026-06-30 19:31:33 UTC`; unauthenticated POST reaches function code and returns `{"ok":false,"error":"Unauthorized"}` |
| `ingest`               |           32 | `supabase functions deploy ingest` succeeded; `functions list` updated to `2026-06-30 19:15:48 UTC`; unauthenticated POST reaches function code and returns `{"error":"invalid_api_key"}`                                                      |
| `bank-sync`            |           50 | Deployed after smoke showed platform-level `UNAUTHORIZED_NO_AUTH_HEADER`; repeat unauthenticated POST reaches function code and returns `{"ok":false,"error":"Unauthorized"}`                                                                  |
| `bank-webhook`         |           48 | Deployed after making duplicate raw events continue through the action path and making `bank-sync` dispatch observable; missing/wrong token POST reaches function code and returns `{"ok":false,"error":"Invalid webhook verification token"}` |
| `bank-discover`        |           34 | Deployed after removing unsigned JWT `service_role` claim fallback; unauthenticated POST is blocked by the Supabase gateway with `UNAUTHORIZED_NO_AUTH_HEADER`                                                                                 |
| `bills-extract`        |           69 | Deployed after removing unsigned JWT `service_role` claim fallback; unauthenticated POST is blocked by the Supabase gateway with `UNAUTHORIZED_NO_AUTH_HEADER`                                                                                 |
| `subscriptions-detect` |           45 | Deployed after removing unsigned JWT `service_role` claim fallback; unauthenticated POST is blocked by the Supabase gateway with `UNAUTHORIZED_NO_AUTH_HEADER`                                                                                 |

These smokes are deliberately non-mutating. They prove routing and `verify_jwt=false`
config, not a real bank/document/payment workflow.

## ⛔ Remaining work — live-proof and activation

The DB schema is live and the core worker/ingest pieces are deployed, but the epic is
not yet fully activated end-to-end. Remaining:

A 17-agent deploy-readiness workflow (8 deep-readers + 8 adversarial verifiers +
synthesis, each verifier cross-checked source AND live prod) classified the 8
candidate edge functions. Key outcome: **3 of 8 are traps** — do not deploy.

### ✅ Remaining live-proof order

Live-path checks should still run one at a time with secret-confirm + smoke-check
between each:

1. `bank-webhook` (SC-06 raw-event guard) — `verify_jwt=false` already reaches function code on missing/invalid token; still needs a signed Basiq-style positive event smoke.
2. `auto-reconcile` (SC-07 evidence write) — `verify_jwt=false` already reaches function code on missing auth; still needs a controlled org smoke with candidate data.
3. `bills-extract` (SC-05 version-row write) — **keep its user-JWT setting**; still needs a controlled bill/document smoke that proves `document_extraction_versions` writes.
4. Positive e2e proof for `ingest` + `automation-worker`: create a real org-prefixed document object, ingest it with a connector key, run/observe the worker, and verify the bill row/extraction state.
5. Positive e2e proof for `payment_record`: use a dedicated test invoice and connector key, then verify a single idempotent `invoice_payments` row.

⚠️ These are in the **live money/ingestion path** — `verify`/`check` discipline each,
not a batch.

### ⛔ Do NOT deploy — traps the analysis caught

- **`api-gateway` ("SC-09")** — HEAD source is **byte-identical to the live v30**; zero SC-09 commits. Deploying is a pointless no-op that risks a live fn for nothing. The real SC-09 artifact is `ingest`. **Drop from the queue.**
- **`automation-watchdog` ("SC-03")** — contains **zero** SC-03 Automation Backbone integration (no `bank_events_raw`/`reconciliation_evidence`/etc.). It's a standalone anomaly scanner mislabeled SC-03. Deploy only if you want the scanner as its own feature — it advances the epic by nothing.

### ✅ `ingest` (SC-09) — blockers fixed in source and core deploy complete

The analysis found `ingest` would have failed on every document/payment call. The
first two blockers were fixed and live-verified at the DB/RPC level; the later
source/worker contract fixes are now deployed to `ingest` v32 and
`automation-worker` v5, but still need positive e2e data proof:

1. **Org-gate** — `enqueue_automation_job` rejected the bare service-role caller
   (`get_accessible_org_ids()` → `[]`). Fixed by migration
   `20260630180000_enqueue_job_service_role_bypass` (service_role bypasses the gate;
   `authenticated` still org-checked). Dry-run proof on prod: service_role enqueue
   ok=true, authenticated non-member blocked=true.
2. **`source_id` type mismatch** — `ingest` passed the raw Idempotency-Key string
   into the `uuid` `source_id`/`p_source_id`. Fixed in `ingest/index.ts`: a new
   `idemKeyToUuid()` derives a stable uuid (SHA-256 prefix) from the key for both
   the dedup filter and `p_source_id`. No schema change, no API-contract break.
3. **Document jobs had no source row** — `document` ingest enqueued `bill_extract`
   with `source_kind='document'`, but did not create a `bills` row; the worker's
   extractor could only drain existing bills. Current source now creates/reuses the
   org-prefixed `bills` row, returns `bill_id`, and puts `bill_id` in the job payload.
4. **Payment jobs were unsupported** — `payment` ingest enqueued `payment_record`,
   but the worker had no handler. Current source now supports invoice receipt jobs
   by inserting `invoice_payments` idempotently and rejects AP bill payment shortcuts
   so bill settlement still goes through bank reconciliation or payment runs.
5. **Platform JWT config drift** — `automation-worker`, `bank-webhook`,
   `bank-sync`, and `auto-reconcile` were missing explicit `verify_jwt=false`
   entries in `supabase/config.toml`. Current source now pins those settings.
6. **Worker dispatch contract drift** — `receipt_sync` jobs were incorrectly
   forwarded to `ingest` even though `ingest` requires connector API keys, and
   `xero_push` jobs sent a generic `source_id` body even though the Xero push
   functions require `bill_id` or `invoice_id`. Current source now dispatches
   `receipt_sync` to `receipt-sync-dispatch` and sends Xero-specific request
   bodies.
7. **Browser job false-complete risk** — the default worker claimed every job
   kind and could complete `browser_collect` with `not_supported`, leaving no
   screenshot/console/artifact proof. Current source now claims only executable
   server-side job kinds; dedicated browser runners must claim `browser_collect`
   explicitly.
8. **Legacy service-role detection shortcuts** — `bank-discover`,
   `bills-extract`, and `subscriptions-detect` still decoded JWT payloads and
   trusted a self-asserted `role: service_role` claim. Current source uses exact
   `SUPABASE_SERVICE_ROLE_KEY` bearer comparison only, with a contract test
   preventing the old pattern from returning.
9. **Webhook sync dispatch could be lost** — `bank-webhook` persisted raw
   evidence, then fire-and-forgot `bank-sync`; if dispatch failed, a later
   duplicate delivery returned `duplicate_skipped` before retrying the sync.
   Current source continues duplicates through the action path and awaits
   `bank-sync`, returning a retryable error if dispatch is not accepted.

`ingest` and `automation-worker` have been deployed as a pair. `verify_jwt=false`
stays explicit in `supabase/config.toml`.

### Activation (only after the relevant deploys)

1. `AUTOMATION_WORKER_SECRET` set in project secrets (optional — service-role bearer cron works without it)
2. `cron.schedule('automation-worker-every-2min', '*/2 * * * *', …)`
3. (Only if deploying the scanner) `AUTOMATION_WATCHDOG_SECRET` + a manual `cron.schedule` — no watchdog cron exists live

## Notes

- ATO/DSP/SBR lodgement remains external-gated throughout — unchanged.
- The unrelated working-tree changes from this session (favicon files, deletion of
  the duplicate `0214_fix_allocation_rpc_grants.sql`) are **not** part of this repair
  and were left out of the repair commit.
