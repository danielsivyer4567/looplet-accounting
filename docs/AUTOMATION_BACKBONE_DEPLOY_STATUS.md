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

### Net-new edge functions (absent on prod)
- `automation-worker` (SC-02) — claims due jobs + dispatches by job_kind
- `automation-watchdog` (SC-03) — background signal scanner

These are safe to deploy (additive); they stay **inert** until a cron schedule
and `AUTOMATION_WORKER_SECRET` are set. Activation runbook is in the inert
migrations `0212_automation_worker_cron.sql` / `0213_automation_watchdog_cron.sql`.

### Live-path functions needing redeploy (currently at pre-epic versions)
These exist on prod but at versions that predate the epic's source changes, so
their new write paths (raw-event idempotency, extraction versioning, reconciliation
evidence, connector endpoints) are not active until redeployed:
- `bank-webhook`, `bank-sync` (SC-06 idempotency guard + raw event write)
- `auto-reconcile` (SC-07 evidence write)
- `bills-extract` (SC-05 version-row write)
- `api-gateway`, `ingest` (SC-09 endpoint surface)

⚠️ These are in the **live money/ingestion path** — redeploy each with the
`verify`/`check` discipline, ideally one focused session per function, not a batch.

### Activation (only after the above)
1. `AUTOMATION_WORKER_SECRET` set in project secrets
2. `cron.schedule('automation-worker-every-2min', '*/2 * * * *', …)`
3. `cron.schedule('automation-watchdog-…', …)`

## Notes
- ATO/DSP/SBR lodgement remains external-gated throughout — unchanged.
- The unrelated working-tree changes from this session (favicon files, deletion of
  the duplicate `0214_fix_allocation_rpc_grants.sql`) are **not** part of this repair
  and were left out of the repair commit.
