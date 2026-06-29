# Finish-Line Tracker

> The live cross-off list for finishing the app. Updated by the orchestrator after
> every slice verifies. Branch: `feat/finish-line` (off `feat/accountant-portal`).

**Progress: 47 / 51 complete (92%)** · deploy-gated: 1 (P0-05) · blocked-external: 3 (ATO TODO)
**Current wave:** F — compliance output
**Last updated:** Wave F P2-07 in-repo reconciliation complete (migration baseline/rollback runbook, manual staging deploy workflow, source-controlled function inventory from live CLI: 66 local/51 live-active/15 holdbacks, docs index, ATO backlog; focused reconciliation test/typecheck/lint/diff-check clean; production migration dry-run remains operator proof because local DB password was rejected)
**Note:** +1 slice discovered in Wave B — P1-14 require_role() accepted_at gate (total now 51).

Legend: `[ ]` pending · `[x]` done+verified · `[~]` code-complete but `[blocked-on-deploy]` · `[!]` external-blocked (cannot finish here)

---

## P0 — Release & security blockers (10/11)

- [x] P0-01 Pending membership access gate
- [x] P0-02 Tag-draft unique constraint + indexes
- [x] P0-03 Invite fallback token redemption
- [x] P0-04 Media attachment scope (persist-or-defer)
- [~] P0-05 Accountant/tag deploy + live overlay proof _(blocked-on-deploy: runbook ready)_
- [x] P0-06 Connector gateway PostgREST hardening
- [x] P0-07 API-key storage + rate-limit hardening
- [x] P0-08 Frontend error boundary + login a11y
- [x] P0-09 Branch hygiene / gate baseline
- [x] P0-10 Email-inbound webhook auth fail-closed + config
- [x] P0-11 Edge-function JWT-mode pinning (config.toml)

## P1 — Reliability & accounting foundations (14/14)

- [x] P1-01 Cron heartbeat + no-success-window + soft-failure parsing
- [x] P1-02 Basiq durability + basiq_user_id migration + webhook persist
- [x] P1-03 OCR provider selection + extraction quality + accuracy gate
- [x] P1-04 GL canonical posting RPC + date-scoped trial balance
- [x] P1-05 Accounting-engine CI tests + test:accounting
- [x] P1-06 SECURITY DEFINER + notify() org-guard hardening
- [x] P1-07 High-impact FK indexes (+ tag_drafts)
- [x] P1-08 Xero retry/backfill + stable idempotency keys
- [x] P1-09 Gmail reconnect + disconnect notification
- [x] P1-10 AP reconciliation parity
- [x] P1-11 Period-lock coverage expansion
- [x] P1-12 Audit triggers on money tables
- [x] P1-13 Cron secrets + SITE_URL provisioning
- [x] P1-14 require_role() accepted_at gate _(discovered in Wave B)_

## P2 — Source posting + compliance output + product completion (23/26)

- [x] P2-01a Source posting: invoices + invoice payments
- [x] P2-01b Source posting: bank transactions + reconciliation
- [x] P2-01c Source posting: payment runs + payroll
- [x] P2-01d Source posting: GST/BAS control + adjustments
- [x] P2-01e Source posting: depreciation/opening-bal/manual-journals/credit-notes/reversals
- [x] P2-02a BAS labels completion + immutable snapshot + source drilldown
- [x] P2-LODGE-1 SBR/AS4 message + envelope builder (behind fail-closed gate)
- [ ] P2-LODGE-2 Digital-signing integration points + secret wiring _(external-gated)_
- [ ] P2-LODGE-3 Lodgement status polling + correspondence ingest _(external-gated)_
- [ ] P2-LODGE-4 Lodgement orchestration + audit + retry _(live external-gated)_
- [x] P2-FBT FBT return builder RPC + Fbt.tsx + approval gate
- [x] P2-TPAR TPAR builder RPC + Tpar.tsx + export
- [x] P2-FRANK Franking register + dividend/distribution statements + reconciliation
- [x] P2-SGC SGC statement + SG-on-OTE/12% fix
- [x] P2-STP STP Phase 2 correctness + TFN secure store/masking + lifecycle
- [x] P2-SUPER SuperStream/clearing-house real dispatch (or documented transport)
- [x] P2-CN Credit notes AR/AP (schema + RPC + UI + GL posting)
- [x] P2-04 Connector product surface (key UI + scope enforcement + OpenAPI + audit)
- [x] P2-05a Cross-browser smoke (Chromium/Firefox) on core routes
- [x] P2-05b Mobile/tablet + empty/loading/error states
- [x] P2-05c Keyboard/focus a11y across main workflows
- [x] P2-06a Route-level code splitting + large-asset optimisation
- [x] P2-06b Production security polish (sourcemaps off, CSP, CORS narrowing)
- [x] P2-07a Migration baseline repair + rollback runbook
- [x] P2-07b Staging/deploy workflow + function-inventory reconciliation
- [x] P2-07c Docs index + remaining-compliance backlog stub

---

### External blockers (cannot be finished in-repo)

Electronic ATO lodgement (P2-LODGE-2/3/4 live) needs ATO **DSP accreditation**, **EVTE**
certification, and **SBR taxonomy hosting** — a certification/provisioning task outside
this build. Scaffolding is built behind the existing fail-closed gate; live lodgement
stays disabled until those are provisioned.
