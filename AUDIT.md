# Looplet Accounting — Autopilot Readiness Audit & Backlog

**Audited:** 2026-06-20 · **Project:** `dxoikltymmknxqpkpyhi` (live, 1 org) · multi-agent audit (49 agents), every blocker independently verified.

**Goal being tracked:** the system should (a) run continuously in the background with little/no human action, (b) expose a REST/connector API so any source can push/pull data, and (c) be complete enough to do all the accounting itself.

> 4 audit findings were checked and **dropped as false-positives**: bills-attach "224 stuck" (auto-attach lane exists), AI "never auto-accepts" (router auto-attach lane exists), `crm_sync_log` "drift" (created in 0001, service-role-only by design), OCR "'35'→$35" (conversion is correct).

---

## ✅ Done in this PR

- **P0 security applied to the live DB (2026-06-20) and captured idempotently in `migrations/0055_security_hardening_p0.sql`:**
  - **B1 — cross-tenant leak closed.** All 21 reporting views set to `security_invoker=on` and anon grants revoked. Verified: `v_job_pnl` as `authenticated` with no org returned **70 rows before → 0 after**.
  - **B2 — `system_defaults` locked.** RLS enabled, writes revoked from anon/authenticated (reads still open), read policy added.
  - **notify() / orphan fns** — anon/PUBLIC `EXECUTE` revoked.
  - Supabase security advisor: **0 critical** remaining (only `WARN` search_path + `INFO` crm_sync_log no-policy left → P2).
- **Connector scaffold (review + finish on main machine):** `migrations/0056_api_keys.sql`, `functions/_shared/apiKeys.ts`, `functions/api-gateway/index.ts`, `functions/ingest/index.ts`.
- **Gmail Pub/Sub push hardened live (2026-06-29):** `gmail-pubsub-push`
  version 32 is deployed with `verify_jwt=false`, mandatory
  `GMAIL_PUSH_VERIFY_TOKEN`, shared Gmail message-id dedupe, and delayed
  `last_history_id` advancement until each history delta is durably handled.
  Redacted live audit proves CORS OPTIONS 200, all Gmail runtime secret names
  present in the linked project, and unsigned POST fail-closed status 401.
- **Bank/cron service-role auth hardened live (2026-06-29):** `bank-sync`
  version 27, `bank-sync-all` version 25, and `notifications-cron` version 22
  are deployed. The forgeable "decode JWT payload and trust `role`" path is
  removed in favour of exact constant-time service-role/cron-secret checks.
  Redacted live audit proves forged `bank-sync` service-role JWT returns 401,
  unsigned `bank-sync-all` and `notifications-cron` return 403, both cron
  secrets exist in the linked project, and `bank-sync-all` is rescheduled as
  active cron job 14 using a Vault-held cron secret. A DB-side `pg_net` probe of
  that Vault path returned HTTP 200 with `ok=true`, `orgs=0`.

---

## Verdict (at audit time)

| Goal                                      | Status        | Summary                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) Runs now on autopilot                 | **NOT READY** | Crons/intake live. Gmail Pub/Sub replay and `bank-sync-all` cron auth/scheduling are now fixed live, but `accountant-session-digest` still lacks its Vault auth secret, Gmail still needs a real reconnect/event trace, and no auto-reconciler/heartbeat release proof exists. |
| (b) REST/connector API                    | **NOT READY** | No API-key mechanism, no ingestion endpoint, no docs; every endpoint needs a human JWT. (Scaffold added in this PR.)                                                                                                                                                           |
| (c) Complete enough to need no accountant | **NOT READY** | No double-entry GL/journals/trial-balance/COA; P&L mixes GST-inc revenue with ex-GST costs; no GST/BAS or STP/super lodgement; no credit notes, fixed assets, accruals.                                                                                                        |

2026-06-29 update: the Gmail Pub/Sub replay path and `bank-sync-all` cron auth
issue above are now fixed/deployed. The overall autopilot verdict remains **NOT
READY** because `accountant-session-digest` still needs the Vault
`service_role_key`, Gmail still needs real reconnect/event proof, and no
auto-reconciler/heartbeat release proof has been captured yet.

---

## Confirmed blockers

- [x] **B1** Cross-tenant IDOR via 21 SECURITY DEFINER views (anon+authenticated SELECT, no org filter). **FIXED** (0055).
- [x] **B2** `system_defaults` RLS off + full DML to anon. **FIXED** (0055).
- [ ] **B3** Gmail integration dead 36+ days, no disable/alert/recovery. `gmail-watch-renew/index.ts:65-72` only logs `last_error`; mirror Xero's `flagConnectionError(disable=true)` on `invalid_grant`/400/401 + reconnect banner. **(M)**
- [ ] **B4** Bank reconciliation entirely manual — `reconcile_match_bill/invoice` (0043) only called from `Reconciliation.tsx`. Add an auto-reconcile edge fn consuming `v_bank_match_candidates`/`v_bank_invoice_match_candidates`, `manually_matched=false` for unambiguous matches above threshold. **(M)**
- [ ] **B5** No API-key/service-token + no generic ingestion endpoint. **Scaffolded in this PR**; finish gateway JWT-↔-RLS wiring + ingest handlers. **(L)**
- [ ] **B6** No double-entry GL / journals / trial balance / chart of accounts (`0041:3-5` admits it). P&L/BS are approximation views. **(XL, capability target)**
- [ ] **B7** Zero GST captured; only 7/247 non-void bills have an amount — OCR (`groq`) avg 0.41 confidence, `gst_amount` null on all 216 rows. BAS reads `bills.gst_cents` → structurally zero. Diagnose/replace OCR, add re-OCR/repair queue, backfill, gate BAS on GST coverage. **(L)**
- [ ] **B8** Reconciliation never populated: 5 synthetic bank txns, 0 matched; single `bank_connections` row is `provider='manual'` while `bank-sync/index.ts:89` filters `basiq`. Stand up a real Basiq feed end-to-end. **(M)**

---

## Missing requirements by goal

### (a) Autopilot / background

- [x] `bank-sync-all` cron auth fixed live (2026-06-29): endpoint requires exact
      service-role bearer or `BANK_SYNC_ALL_CRON_SECRET`, live unsigned POST returns
      403, active cron job 14 reads a Vault-held scoped secret, and DB-side `pg_net`
      returned HTTP 200 with `ok=true`, `orgs=0`.
- [ ] `accountant-session-digest` **401 every 10 min** — builds bearer from `vault.decrypted_secrets WHERE name='service_role_key'` which doesn't exist. Create the vault secret or switch to `?secret=`. **(high)**
- [ ] No end-to-end cron alerting — nothing reads `net._http_response`. Add monitor / per-function heartbeat + "no success in window" notification. **(high)**
- [ ] No Xero push retry/backfill — `bills-attach` awaits `pushBillToXero` inline; `callXeroWithRetry` only retries 401. Add backoff + re-drive cron for `xero_status in ('error','pending')`. **(medium)**
- [ ] Cron registration lives in untracked `SCHEDULE.sql` with `<PROJECT_REF>`/`<SECRET>` placeholders; move all `cron.schedule(...)` into tracked migrations. **(medium)**
- [ ] Webhook reliability: `bank-webhook` returns 200 on internal error with no event log. Persist events before acking and expose replay/heartbeat evidence. **(medium)**
- [x] Gmail Pub/Sub cursor safety: `gmail-pubsub-push` advanced `last_history_id` before ingest completed. **FIXED 2026-06-29** in live version 32; successful messages are deduped by Gmail message ID and retryable ingest failures leave the cursor unchanged for replay.
- [ ] Extend confidence-tiered auto-accept beyond exact job-ref match (`_shared/bills/router.ts:62-71`) to LLM-classified entities. **(low/med)**

### (b) REST API / connectivity

- [ ] `api_keys` table + issue/revoke UI. **(Scaffold: 0056 + Settings UI TODO)**
- [ ] Generic `POST /ingest` + per-entity push (bills/transactions/invoices). **(Scaffold: functions/ingest)**
- [ ] Webhook auth weak — some provider/webhook paths still rely on shared URL
      secrets rather than provider HMAC/per-org scoping (`bank-webhook:36-43`).
      Verify provider HMAC, move webhook secrets to headers, scope per org. Gmail
      Pub/Sub now fails closed on missing/mismatched `GMAIL_PUSH_VERIFY_TOKEN`, and
      bank/notification cron endpoints now use exact constant-time service-role or
      cron-secret checks; Pub/Sub OIDC verification remains a defence-in-depth
      follow-up. **(high)**
- [x] **Cron functions trusted an UNVERIFIED JWT as service-role** in
      `notifications-cron` and `bank-sync-all`. **FIXED 2026-06-29** with shared
      exact-match auth helper, Deno tests, live deployment, forged-JWT fail-closed
      proof, and `bank-sync-all` cron rescheduled through a Vault-held secret.
- [ ] PostgREST is the de-facto API but undocumented — publish OpenAPI + integration guide. **(high)**

### (c) Accounting completeness (internal capability target)

- [ ] Double-entry GL / journals / trial balance / chart of accounts; derive P&L/BS from postings (fix GST-inc revenue mixing). **(XL)**
- [ ] GST/BAS: W1/W2 + G-code label mapping into `v_bas_quarterly`; SBR e-lodgement (today `Bas.tsx` is read-only CSV). **(high)**
- [ ] STP Phase 2 + super: SBR gateway + SuperStream; real TFNs (placeholder `000000000` at `payroll-export-stp/index.ts:146`); `super_payments` table. **(high)**
- [ ] Credit/adjustment notes (AR + AP) — none exist; only `void`. **(high)**
- [ ] Fixed-asset register + depreciation; accruals/prepayments/adjusting journals; EOFY close. **(high)**
- [ ] Period locks: extend `check_period_lock` to `invoices`/`invoice_payments`/`bank_transactions`/`pay_runs` (currently bills + wage_entries only); fix it to read `issue_date` (derives from non-existent `invoice_date` → no-op). **(medium)**
- [ ] Income/company tax-return prep or structured EOFY pack. **(medium)**

### (d) Integrity / security / data

- [x] `public.notify()` anon-executable revoked (0055). Deeper fix (org guard `p_org IN (SELECT get_accessible_org_ids())`) still TODO. **(high)**
- [ ] 26 SECURITY DEFINER functions executable by PUBLIC + 27 with mutable `search_path` — add `SET search_path=''`, `REVOKE EXECUTE FROM PUBLIC`. **(medium)**
- [ ] Drop orphaned cross-product functions `deduct_credits` / `check_rate_limit` / `is_agency_user` (anon execute already revoked in 0055). **(medium)**
- [ ] Add audit triggers to `bank_transactions` / `invoice_payments` / `payment_runs`. **(medium)**
- [ ] 61 unindexed FKs incl. `bank_transactions.matched_*`, `invoices.job_id/customer_id`, 5 line-item `organization_id`. **(medium, non-functional)**
- [ ] **CI gate is inert**: `tests/tenant-isolation.test.ts:24` is `describe.skip` with `expect(true).toBe(true)` yet labeled "Deploy Blocker"; 8 `any` tokens fail `no-explicit-any:'error'`. Make the isolation suite real (two seeded orgs, cross-tenant assertions) + fix lint. Core accounting (GST split, reconciliation, payroll, ABA, Xero push) has **zero tests**. **(blocker for the gate)**
- [ ] `organizations_insert` RLS `WITH CHECK true`; enable leaked-password protection; constant-time secret compares. **(low)**

---

## Roadmap

**P0 — safely usable now** (✅ security done): close leak ✅, lock system_defaults ✅, revoke anon notify/orphans ✅ · Gmail Pub/Sub replay hardening ✅ · bank-sync-all cron auth/schedule ✅ · then [ ] accountant-session-digest cron secret + heartbeat proof · [ ] Gmail real reconnect/event proof · [ ] make the CI tenant-isolation gate real.

**P1 — make autopilot actually do accounting:** auto-reconcile (B4) · OCR fix + GST backfill (B7) · live Basiq feed (B8) · Xero retry cron · tracked cron migrations + durable webhook/ingest · extend period locks + audit triggers · finish API/ingestion layer (B5) · HMAC webhooks + OpenAPI docs.

**P2 — completeness + hardening:** double-entry GL + correct P&L/BS (B6) · BAS/STP/super lodgement, credit notes, fixed assets, EOFY · accounting test suite · search_path hardening + 61 FK indexes.

---

## §5 — Recommended connection method (external REST / direct-connect)

- **API key → scoped JWT.** `api_keys(org_id, key_prefix, hashed_key, scopes[], expires_at, revoked_at)` (migration 0056). Store only a SHA-256 hash; org-bound so a leaked key never crosses tenants.
- **`api-gateway` edge fn** (`verify_jwt:false`) validates the key, mints a short-lived JWT (`role=authenticated` + `organization_id` + scopes) → existing RLS enforces. _(Finish: wire the token to a per-org integration user or an `organization_id` RLS claim — see code NOTE.)_
- **Reads ride PostgREST** `/rest/v1/...` (now RLS-safe after 0055); publish the auto OpenAPI as the documented read API.
- **`POST /functions/v1/ingest`** `{type,payload}` — service-role write after pinning `organization_id` to the key's org; reuse the bill router + bank dedupe so pushed records get identical auto-routing.
- **Webhooks:** HMAC signatures (not URL secrets), persist events before acking, per-connection secret.
- **Pull deltas:** `GET /ingest/changes?since=<cursor>` + optional outbound webhooks on `bill.attached` / `invoice.paid` / `reconciliation.matched`.
- **Scopes:** `read:financials`, `write:bills`, `write:bank`, `write:invoices`, `admin:keys` — enforced at the gateway and again by RLS.
- **Key-management UI** in Settings (create/scope/revoke, last_used, one-time secret reveal); per-key rate limit; log every external call to the audit trail. Never accept the raw service-role key at the HTTP edge.

---

## §6 — Security note

Foundations are sound (Xero/Gmail/Basiq tokens AES-256-GCM encrypted, service-role key not committed/shipped, RLS on 49/50 base tables, broad append-only audit log). The audit's criticals were the **view/grant bypass and anon-reachable definer surface** on top of correct base-table RLS — **now fixed (0055)**. The forgeable cron service-role branches are also fixed live. Remaining: deeper `notify()` org-guard, search_path hardening on definer functions, HMAC webhook auth, accountant digest cron secret proof, and cron heartbeat monitoring.
