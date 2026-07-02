# Ledger: Finish-Line — complete the app (50 slices, wave-orchestrated)

**Branch:** feat/finish-line (off feat/accountant-portal @ 2d854d7)
**Created:** 2026-06-29  **Approved:** yes (plan atomic-popping-mitten.md)
**Tracker:** docs/FINISH_LINE_TRACKER.md  **Orchestrator:** main session (Workflow waves)

## Rules
- One migration-number owner (the orchestrator pre-assigns each `[migration]` slice an
  exact filename per wave; ceiling at start = 0201, next = 0202).
- No two concurrent slices edit the same file. A would-be conflict bumps to next wave.
- Per slice: implement + tests + `git diff --check`, lint, typecheck, build on touched files.
- Per wave: full `npm run test --no-file-parallelism` green, commit, update tracker, then next wave.
- Deploy-gated → code + proof script + `[blocked-on-deploy]`, skip ahead. No live deploy from here.
- External-gated (ATO lodgement) → build scaffolding behind fail-closed gate, mark `[!]`.

## Status key
[ ] pending · [wip] in progress · [done] verified · [blocked-on-deploy] · [external]

---

## WAVE A — frontend/config/additive (no feature deps)

### P0-08 Frontend error boundary + login a11y — [ ]
- Files: src/main.tsx, src/App.tsx, src/pages/Login.tsx, src/index.css, new src/components/ErrorBoundary.tsx, src/test/components/ErrorBoundary.test.tsx, src/test/pages/Login.a11y.test.tsx
- Tests: boundary fallback renders + reset; login labels associated; skip-link targets main; .btn :focus-visible; aria-live announces errors.
- Proof: jsdom render. Rollback: revert wrapper only; keep a11y fixes.

### P0-09 Branch hygiene / gate baseline — [ ]
- Files: docs only (this ledger + tracker). Tests: git diff --check, lint, test, typecheck, build. No production code.

### P0-10 Email-inbound webhook auth fail-closed — [ ]
- Files: supabase/functions/accountant-email-query/index.ts, supabase/config.toml, function test.
- Spec: require EMAIL_INBOUND_SECRET (fail closed 403 if absent or header mismatch); pin verify_jwt=false in config.toml.
- Tests: absent-secret → 403; wrong header → 403; correct header → 200. Rollback: revert auth block (do NOT restore fail-open).

### P0-11 Edge-function JWT-mode pinning — [ ]
- Files: supabase/config.toml only. Pin verify_jwt for the 6 active functions per agent-04. (Owner of config.toml for the wave; coordinate with P0-10.)

### P1-07 High-impact FK indexes — [migration 0202] — [ ]
- Files: supabase/migrations/0202_fk_indexes.sql. Additive idempotent FK indexes incl. tag_drafts. No RLS change. Proof: advisor count drops.

### P1-13 Cron secrets + SITE_URL provisioning — [ ]
- Files: docs/RUNBOOK_DEPLOY.md (or new docs/CRON_SECRETS.md), .env.example. Document AUTO_RECONCILE/ACCOUNTANT_ORCHESTRATOR/ACCRUALS/DEPRECIATION cron secrets + SITE_URL. No code. (deploy-gated for actual secret-set.)

---

## WAVE B — P0 security core

### P0-01 Pending membership access gate — [migration 0203] — [ ]
- Files: supabase/migrations/0203_accepted_membership_access.sql, src/contexts/OrgContext.tsx, src/test (RLS + provider).
- Spec: get_accessible_org_ids() filters accepted_at IS NOT NULL; pending orgs not selectable.
- Tests: pending member reads zero rows; pending org not selectable; access only post-accept; tenant-isolation green.
- Proof: BEGIN…ROLLBACK impersonated. Rollback: disable existing-user pending invite creation.

### P0-02 Tag-draft unique constraint + indexes — [migration 0204] — [ ]
- Files: supabase/migrations/0204_tag_draft_contract.sql, src/test/components/TagDrop.test.tsx.
- Spec: unique (user_id, organization_id, page_url); supporting indexes. Tests: upsert updates same row.

### P0-04 Media attachment scope — [ ]
- Files: src/components/tag-drop/TagDropManager.tsx, TagDropPopup.tsx, tag tests.
- Spec: persist durably OR hide/label image/audio/video controls as deferred. Tests: controls hidden/labelled if deferred.

### P0-06 Connector gateway PostgREST hardening — [migration 0205] — [ ]
- Files: supabase/functions/api-gateway/index.ts, supabase/functions/_shared/apiKeys.ts, supabase/migrations/0205_connector_hardening.sql, docs/connector-guide.md, connector tests.
- Spec: write-only key cannot exchange for read JWT; connector JWT cannot POST/PATCH/DELETE org tables; ingest only scoped write.
- Proof: 403 for write-only exchange; read JWT cannot mutate bills/invoices.

### P1-06 SECURITY DEFINER + notify() org-guard — [migration 0206] — [ ]
- Files: supabase/migrations/0206_definer_notify_hardening.sql, security tests.
- Spec: REVOKE EXECUTE FROM PUBLIC on definer fns; notify() rejects cross-org; drop orphan fns.

### P1-12 Audit triggers on money tables — [migration 0207] — [ ]
- Files: supabase/migrations/0207_money_audit_triggers.sql, tests.
- Spec: append-only audit_log triggers on bills, invoices, pay_runs, pay_slips, bank_transactions, journal_entries, payment_runs.

---

## WAVE C — P0 deps + deploy gate

### P0-03 Invite fallback token redemption — [ ] (dep P0-01)
- Files: supabase/functions/team-invite/index.ts, src/pages/AcceptInvite.tsx, invite tests.
- Spec: /accept-invite?token=<uuid> redeems via intended path or remove fallback claim. Tests: existing/new/expired/reuse.

### P0-07 API-key storage + rate-limit hardening — [migration 0208] — [ ] (dep P0-06 apiKeys.ts)
- Files: supabase/migrations/0208_api_key_hardening.sql, supabase/functions/_shared/apiKeys.ts, connector tests.
- Spec: api_key_rate_limit runs as service_role; hashed_key not client-readable; no direct DML; issue_api_key admin-only + pgcrypto search_path.

### P1-11 Period-lock coverage expansion — [migration 0209] — [ ]
- Files: supabase/migrations/0209_period_lock_coverage.sql, tests.
- Spec: enforce period locks on invoices, pay_runs, pay_slips, bank_transactions, journal_entries.

### P0-05 Accountant/tag deploy + live overlay proof — [blocked-on-deploy] — [ ]
- After B+C verified: deploy 0199/0200/0201 + team-invite, prove overlay. Produces proof script; marked blocked-on-deploy (no live deploy from here).

---

## WAVE D — reliability

### P1-01 Cron heartbeat + no-success-window — [migration 0210] — [ ]
- Files: supabase/migrations/0210_cron_heartbeat.sql, core cron functions, operator health UI/runbook.
- Spec: cron_heartbeat_jobs/runs, cron_no_success_windows(), body-level soft-failure parsing; stale-job alert proof.

### P1-02 Basiq durability + basiq_user_id migration — [migration 0211] — [ ]
- Files: supabase/migrations/0211_basiq_durability.sql (adds organizations.basiq_user_id + link/sync ledgers + webhook events), bank-* functions, settings bank UI, tests.
- Spec: source-controlled basiq_user_id; webhook persists before ack; HMAC or documented; idempotent sync; replay.

### P1-03 OCR provider selection + extraction quality — [migration 0212] — [ ]
- Files: supabase/functions/_shared/ocr/*, bills-extract, bills-extract-batch, supabase/migrations/0212_extraction_attempts.sql, Bills/BillDetail exception UI.
- Spec: provider contract; durable attempts; failed extraction not verified; line items persisted; manual GST sets gst_estimated; fixture accuracy gate.

### P1-08 Xero retry/backfill + stable idempotency — [migration 0213] — [ ]
- Files: supabase/functions/_shared/xero/*, xero edge fns, supabase/migrations/0213_xero_retry.sql, tests.
- Spec: durable retry state; STABLE idempotency keys (no per-retry rotation → no duplicate invoices); 401/429 tests; stub-mode CI.

### P1-09 Gmail reconnect + disconnect notification — [ ]
- Files: gmail watch/renew/push functions, src notification surfaces, tests/runbook.
- Spec: reconnect UI for disabled rows; fatal invalid_grant disables + notifies; watch-renew proven.

---

## WAVE E — GL spine

### P1-04 GL canonical posting RPC + date-scoped trial balance — [migration 0214] — [ ]
- Files: supabase/migrations/0214_gl_posting_rpc.sql (create_and_post_journal, gl_trial_balance(from,to), locked-period rejection), posting RPC docs.
- Spec: COA roles, posting keys, idempotency key, date-scoped TB (zero-net proof). No report cutover until parity.

### P1-10 AP reconciliation parity — [ ] (dep P1-04)
- Files: reconcile RPC/migration if needed, auto-reconcile function, tests.
- Spec: AP gets already-matched/paid/void/personal guards matching AR; amount tolerance rejects matched txns.

### P1-05 Accounting-engine CI tests — [ ]
- Files: tests/, package.json (test:accounting), CI workflow, Deno test wiring.
- Spec: deploy-blocking tests for GST split, BAS, reconciliation, PAYG, ABA, Xero stub structure; --no-file-parallelism in CI.

---

## WAVE F — source posting on GL (dep P1-04)

### P2-01a invoices + invoice payments — [ ]
### P2-01b bank transactions + reconciliation — [ ]
### P2-01c payment runs + payroll — [ ]
### P2-01d GST/BAS control + adjustments — [ ]
### P2-01e depreciation/opening-bal/manual-journals/credit-notes/reversals — [ ]
- Files (each): its source caller + posting wiring via create_and_post_journal + tests. Distinct source modules → no cross-edit.
- Migration (shared posting_rules seed, if needed): pre-assigned at wave launch.
- Proof: each source event produces balanced GL journals; trial balance ties out.

---

## WAVE G — compliance output engines (distinct engines/migrations)

### P2-02a BAS labels completion + immutable snapshot — [migration] — [ ]
- Files: BAS migration (G2/G3/G10/G11, W1/W2, PAYG-I/PAYGW; immutable snapshot; source drilldown), BAS UI/report hooks.

### P2-FBT FBT return builder + Fbt.tsx — [migration] — [ ]
- Files: build_fbt_return RPC migration, src/pages/reports/Fbt.tsx, src/hooks/useFbtReturn.ts, approval gate, tests. (model logic exists in _shared/models/fbt.ts)

### P2-TPAR TPAR builder + Tpar.tsx — [migration] — [ ]
- Files: build_tpar_statement RPC migration, src/pages/reports/Tpar.tsx, export, tests.

### P2-FRANK Franking register + statements + reconciliation — [migration] — [ ]
- Files: franking_account migration (balance ledger, franking credits in/out), dividend/distribution statement RPC + UI, reconciliation view.

### P2-SGC SGC statement + SG-on-OTE/12% fix — [migration] — [ ]
- Files: SGC migration (shortfall, OTE base, nominal interest, admin component), payroll SG fix (calc on OTE, default rate 12%), tests.

### P2-STP STP Phase 2 correctness + TFN secure handling — [migration] — [ ]
- Files: STP migration (secure TFN store/masking, finalisation/update lifecycle), payroll-export-stp SBR-schema validation, tests. Promote from P2 → treat as gate.

### P2-CN Credit notes AR/AP — [migration] — [ ]
- Files: credit_notes migration (schema + RPC), src/pages credit-note UI, GL posting via create_and_post_journal, tests.

---

## WAVE H — lodgement transport (sequential within; external-gated)

### P2-LODGE-1 SBR/AS4 message + envelope builder — [ ]
- Files: supabase/functions/_shared/lodge/* (message/envelope builders), unit tests. Behind existing fail-closed gate.

### P2-LODGE-2 Digital-signing integration points — [external] — [ ]
- Files: _shared/lodge signing scaffold + secret wiring. Live = blocked on EVTE/DSP credentials.

### P2-LODGE-3 Lodgement status polling + correspondence ingest — [external] — [ ]
- Files: ato-lodge, ato-correspondence status polling scaffold. Live = blocked.

### P2-LODGE-4 Lodgement orchestration + audit + retry — [migration] [external] — [ ]
- Files: lodgement orchestration function + audit migration. Live = external-gated.

### P2-SUPER SuperStream/clearing-house real dispatch — [ ]
- Files: super-batch-send dispatch scaffold + documented transport; secret-gated send.

---

## WAVE I — product completion

### P2-04 Connector product surface — [migration?] — [ ]
- Files: API-key management UI, scope UX + ENFORCEMENT in api-gateway, docs/openapi.yaml, examples, audit/last-used.

### P2-05a Cross-browser smoke — [ ]
- Files: tests/e2e harness (Chromium/Firefox) on core routes.

### P2-05b Mobile/tablet + empty/loading/error states — [ ]
### P2-05c Keyboard/focus a11y across main workflows — [ ]
### P2-06a Route-level code splitting + large-asset optimisation — [ ]
- Files: vite config, lazy() route boundaries (the 1.6MB bundle).
### P2-06b Production security polish — [ ]
- Files: vite config (sourcemaps off), CSP/headers, CORS narrowing.
### P2-07a Migration baseline repair + rollback runbook — [migration?] — [ ]
### P2-07b Staging/deploy workflow + function inventory — [ ]
### P2-07c Docs index + remaining-compliance backlog stub — [ ]
- Includes critic backlog: IAS/PAYG-instalment lodgement, ASIC, registration flows, Div7A lodgement, SMSF annual return/audit, e-signature/engagement letters, document retention, data export/backup, audit-log UI.

---

## Wave log
- (orchestrator appends: wave, slices, commit SHA, gate result, tracker %)
