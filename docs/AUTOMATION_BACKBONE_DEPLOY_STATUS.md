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

| Migration (recorded) | Covers | Verification |
|---|---|---|
| `20260630170735_automation_backbone_repair` | SC-01 (automation_jobs + 4 tables + 5 RPCs), SC-04 (confidence_policies + 3 RPCs), SC-05 (document_extraction_versions), SC-06 (bank_events_raw + raw_event_id FK + replay_bank_event), SC-07 (reconciliation_evidence), SC-08 (browser_sessions, browser_job_runs) | All `to_regclass`/`to_regprocedure` resolve; SC-06 dedup + null-org partial-unique + replay behavioral checks passed against live prod (rolled back) |
| `20260630171500_automation_backbone_definer_hardening` | Security fix (see below) | Anon access to `replay_bank_event` confirmed denied on persisted prod state; ACL = `service_role` only |

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

## ⛔ NOT yet live — remaining work (blocked-on-deploy)

The DB schema is live, but the epic does not yet **run**. Remaining:

A 17-agent deploy-readiness workflow (8 deep-readers + 8 adversarial verifiers +
synthesis, each verifier cross-checked source AND live prod) classified the 8
candidate edge functions. Key outcome: **3 of 8 are traps** — do not deploy.

### ✅ Safe to deploy (verified: source contains the epic change, DB contract live)
Deploy order (worker first as inert canary, then live-path redeploys one at a time
with secret-confirm + smoke-check between each):
1. `automation-worker` (SC-02) — net-new, additive, **inert** until cron+secret set; `verify_jwt=false`. Bundle: `_shared/cors.ts`, `_shared/automationJobs.ts`.
2. `bank-webhook` (SC-06 raw-event guard) — `verify_jwt=false`; confirm `BASIQ_WEBHOOK_VERIFY_TOKEN` (fail-closed). Bundle: cors, apiKeys, env.
3. `bank-sync` (SC-06 raw_event_id write) — `verify_jwt=false`; confirm `BASIQ_API_KEY`. Bundle: cors, apiKeys, basiq/client, serviceRole.
4. `auto-reconcile` (SC-07 evidence write) — `verify_jwt=false`; `AUTO_RECONCILE_CRON_SECRET` optional. Bundle: cors.
5. `bills-extract` (SC-05 version-row write) — **keep its user-JWT setting**; full 16-file `_shared` transitive bundle.

⚠️ #2–5 are in the **live money/ingestion path** — `verify`/`check` discipline each,
not a batch. (Verifiers confirmed the live versions genuinely lack the epic change,
so these redeploys are meaningful, not no-ops.)

### ⛔ Do NOT deploy — traps the analysis caught
- **`api-gateway` ("SC-09")** — HEAD source is **byte-identical to the live v30**; zero SC-09 commits. Deploying is a pointless no-op that risks a live fn for nothing. The real SC-09 artifact is `ingest`. **Drop from the queue.**
- **`automation-watchdog` ("SC-03")** — contains **zero** SC-03 Automation Backbone integration (no `bank_events_raw`/`reconciliation_evidence`/etc.). It's a standalone anomaly scanner mislabeled SC-03. Deploy only if you want the scanner as its own feature — it advances the epic by nothing.

### ✅ `ingest` (SC-09) — blockers FIXED this session (was DOA on prod)
The analysis found `ingest` would have failed on every document/payment call. Both
blockers are now fixed and live-verified:
1. **Org-gate** — `enqueue_automation_job` rejected the bare service-role caller
   (`get_accessible_org_ids()` → `[]`). Fixed by migration
   `20260630180000_enqueue_job_service_role_bypass` (service_role bypasses the gate;
   `authenticated` still org-checked). Dry-run proof on prod: service_role enqueue
   ok=true, authenticated non-member blocked=true.
2. **`source_id` type mismatch** — `ingest` passed the raw Idempotency-Key string
   into the `uuid` `source_id`/`p_source_id`. Fixed in `ingest/index.ts`: a new
   `idemKeyToUuid()` derives a stable uuid (SHA-256 prefix) from the key for both
   the dedup filter and `p_source_id`. No schema change, no API-contract break.

`ingest` is now deploy-ready (it still needs an actual deploy via MCP, with the full
`_shared` bundle, in a dedicated step). `verify_jwt` stays as currently configured.

### Activation (only after the relevant deploys)
1. `AUTOMATION_WORKER_SECRET` set in project secrets (optional — service-role bearer cron works without it)
2. `cron.schedule('automation-worker-every-2min', '*/2 * * * *', …)`
3. (Only if deploying the scanner) `AUTOMATION_WATCHDOG_SECRET` + a manual `cron.schedule` — no watchdog cron exists live

## Notes
- ATO/DSP/SBR lodgement remains external-gated throughout — unchanged.
- The unrelated working-tree changes from this session (favicon files, deletion of
  the duplicate `0214_fix_allocation_rpc_grants.sql`) are **not** part of this repair
  and were left out of the repair commit.
