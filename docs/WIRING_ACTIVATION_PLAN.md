# Wiring Activation Plan

**Purpose:** the app is ~94% code-complete but feels ~50% finished. This doc
is the single source of truth for _why_, verified live against prod
(`dxoikltymmknxqpkpyhi`) on 2026-07-02. Fix everything here **before**
starting UI polish — polishing screens fed by stub/empty data just makes
the app look finished without being finished.

## Verified live state (2026-07-02)

| Component                       | Status                                          | Evidence                                                                                                                                                                                                                                                             |
| ------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gmail bill ingestion            | **Working**                                     | 176 bills created in last 30 days                                                                                                                                                                                                                                    |
| Bill coding (AI classification) | **Working**                                     | 202 `coding_suggestions` in last 30 days                                                                                                                                                                                                                             |
| Coding → GL posting             | **Partly live; durable queue gap now targeted** | Bill coding writes `coding_suggestions`, not `automation_decisions`. Live proof on 2026-07-02 posted 5 journals and routed 193 bills to review; repo now adds a durable `bill_code` worker job + 5-minute enqueue cron for extracted bills missing live suggestions. |
| Xero integration                | **Never connected**                             | 0 rows in `xero_integrations`; every push silently runs the `STUB-<id>` fallback                                                                                                                                                                                     |
| Bank feed (Basiq)               | **Auth FIXED (sandbox); production not yet enabled** | 2026-07-03: `BASIQ_API_KEY` corrected + `_shared/basiq/client.ts` fixed to pass key verbatim (was conditionally base64-encoding). `bank-link-token` now returns real Connect URLs (`{"ok":true}`). BUT the key's JWT decodes to `sandbox_account: true` — connects only to Basiq TEST institutions, not real banks. Production requires the go-live step: contact Basiq customer success to enable Open Banking/live data on the "Looplet accounting" application, then generate a production key. The pre-existing `provider='manual'` row is the old CSV import (unrelated).            |
| Cron infrastructure             | **Working**                                     | 13 active jobs confirmed in `cron.job` (automation-worker every 2min, watchdog every 15min, bank-txn-classifier, auto-reconcile, receipt-sync-dispatch, gmail-watch-renew, xero-sync, etc.)                                                                          |
| Migration ceiling               | **In sync**                                     | live `20260702170000` matches repo                                                                                                                                                                                                                                   |
| ATO/SBR lodgement               | **Deliberately unimplemented**                  | permanent legal wall, not a bug — do not build without DSP/EVTE credentials                                                                                                                                                                                          |

## Root cause

The bill-coding pipeline in code is: **Gmail → durable `bill_extract` job →
`bills-extract` → `intake-routing-apply` → `coding-classifier` →
`coding_suggestions` → `journal_entries`** when the 0.9 auto-post gate is met.

`automation_decisions` is a separate generic proof/acceptance table used by OCR
and other owner-facing decision surfaces; it is **not** the bill GL posting gate.
The posting signal is a live `coding_suggestions` row, `status='auto_posted'`
when posting succeeds, and a matching posted `journal_entries` row. Low-confidence
or unsafe bills correctly stay in `coding_review_queue` for human accept/override.

The remaining wiring gap is durability: there was no worker-owned job kind for
"code this already-extracted bill now." Newly extracted bills can chain through
the classifier, but repair/backlog/extracted-without-suggestion cases needed a
manual `intake-routing-apply` drive. The repo fix is `bill_code`: a durable
automation job that calls `intake-routing-apply`, plus a DB cron that enqueues
extracted probable bills missing a live `coding_suggestions` row.

## Phase 1 — Close the posting spine (highest priority, fixes the core "feels unfinished" gap)

1. Deploy the current `intake-routing-apply` and `coding-classifier` functions;
   both must be current because routing chains into classification and posting.
2. Deploy `automation-worker` with `job_kind='bill_code'`; it dispatches to
   `intake-routing-apply` with `{ organization_id, target:'bill', target_id }`.
3. Apply `20260702173000_bill_code_jobs.sql`; confirm cron job
   `bill-code-enqueue-every-5min` exists and calls
   `enqueue_bill_code_jobs(100)`. This cron writes queue rows only; the
   Vault-gated `automation-worker` cron still owns HTTP dispatch.
4. Verify queue behavior: extracted probable bills without a live
   `coding_suggestions` row receive pending `bill_code` jobs; bills already in
   the coding queue do not get spammed.
5. Verify end-to-end on a canary: worker claims `bill_code`, calls
   `intake-routing-apply`, `coding_suggestions` appears/updates, high-confidence
   safe bills post to `journal_entries`, unsafe/low-confidence bills stay in
   `coding_review_queue`, and trial balance remains 0.
6. Watch the queue for 24–48h: no `bill_code` pending starvation, no dead letters,
   `coding_suggestions` coverage rises for extracted bills, posted journals rise
   only where the money wall allows it.

## Phase 2 — Reconnect providers

6. **Xero:** run the real OAuth flow (`xero-oauth-start` → user consent →
   `xero-oauth-callback`) for at least one org to create a live
   `xero_integrations` row. Until this exists, treat all `xero_sync_log`
   rows as fake. Also fix the known low-severity gap: the OAuth `state`
   param isn't HMAC-signed (`xero-oauth-start/index.ts:35`) — sign it before
   relying on this in production.
7. **Bank feed (Basiq):** the existing connection is dead, not absent —
   investigate why `bank-sync-all` (running every 6h) isn't updating
   `last_synced_at`. Check for an expired token/consent, a silent error
   being swallowed, or a scope mismatch. Fix or re-authorize; then confirm
   `bank_transactions` starts accumulating again.
8. **Gmail:** ingestion is live and working — no action needed here beyond
   monitoring `gmail-watch-renew` continues to succeed.

## Phase 3 — Verify end-to-end on real data

9. Push one real bill through the full chain (Gmail → OCR → routing →
   `coding_suggestions` → GL post/review) and confirm a non-stub journal entry
   with TB=0.
10. Re-run BAS label generation against live GL data now that journals are
    actually posting.
11. Reconnect the Supabase MCP server (both the main session and workflow
    subagents got "MCP server not connected" errors this session — CLI
    fallback via `supabase db query --linked` worked, but re-check MCP
    config so `get_advisors`/`list_edge_functions` work again without the
    fallback).
12. Re-run `get_advisors` (security + performance) once MCP is back —
    last counts (122→72) are stale until reverified against current schema.

## Phase 4 — Small code gaps (not blocking, do opportunistically)

13. HMAC-sign the Xero OAuth `state` param (see step 6).
14. Leave ATO/SBR lodgement and correspondence transport unimplemented —
    confirmed deliberate legal wall (`ato-lodge/index.ts`,
    `ato-correspondence/index.ts` both explicitly fail-closed/501 by
    design). Nothing to fix here.

## Phase 5 — UI polish (only after Phases 1–3 are green)

Do not start UI polish until: journal entries are posting continuously
from the real backlog (not just the 5 historical ones), Xero shows real
(non-stub) syncs, and the bank feed is current. Polishing a UI in front of
stub/empty data is exactly what produces the "95% done but feels 50%"
gap — fix the data first, then make it look good.
