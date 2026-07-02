# Finish-Line Tracker

> The live cross-off list for finishing the app. Updated by the orchestrator
> after every slice verifies. Branch: `feat/finish-line` (off
> `feat/accountant-portal`).

**Progress: 48 / 51 code-complete (94%)** · blocked-external: 3 (ATO TODO)

> **Read this before trusting the 94%:** this number tracks code merged,
> not features running on real data. Verified live 2026-07-02: Xero has
> 0 connected orgs (all pushes run the stub path), the bank feed's one
> connection is stale since 2026-05-02 despite an active cron, and the
> coding→posting spine is stuck (202 coding_suggestions in 30 days → 0
> automation_decisions, no `intake-routing-apply` cron exists). Gmail
> ingestion is genuinely live (176 bills in 30 days). See
> `docs/WIRING_ACTIVATION_PLAN.md` for the live-wiring gap and the fix
> order — that doc, not this %, is the real measure of "is it finished."
**Current wave:** F — compliance output
**Last updated:** 2026-06-30 owner-first migrations `0230`-`0236` applied live
through `supabase db query --linked` and recorded in
`supabase_migrations.schema_migrations` with
`created_by='codex-live-owner-first-20260630'`. Production P0-05 proof previously
passed on Cloudflare Pages deployment
`933983a7-9d03-47e7-8be4-e33ef0f9b21a` from source `0e9dd07`; only the ATO
lodgement TODOs remain unchecked in the original finish-line tracker.
**Note:** +1 slice discovered in Wave B — P1-14 require_role() accepted_at gate
(total now 51).

Legend: `[ ]` pending · `[x]` done+verified · `[~]` code-complete but
`[blocked-on-deploy]` · `[!]` external-blocked (cannot finish here)

---

## P0 — Release & security blockers (11/11)

- [x] P0-01 Pending membership access gate
- [x] P0-02 Tag-draft unique constraint + indexes
- [x] P0-03 Invite fallback token redemption
- [x] P0-04 Media attachment scope (persist-or-defer)
- [x] P0-05 Accountant/tag deploy + live overlay proof
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
- [x] P1-14 require*role() accepted_at gate *(discovered in Wave B)\*

## P2 — Source posting + compliance output + product completion (23/26)

- [x] P2-01a Source posting: invoices + invoice payments
- [x] P2-01b Source posting: bank transactions + reconciliation
- [x] P2-01c Source posting: payment runs + payroll
- [x] P2-01d Source posting: GST/BAS control + adjustments
- [x] P2-01e Source posting:
      depreciation/opening-bal/manual-journals/credit-notes/reversals
- [x] P2-02a BAS labels completion + immutable snapshot + source drilldown
- [x] P2-LODGE-1 SBR/AS4 message + envelope builder (behind fail-closed gate)
- [ ] P2-LODGE-2 Digital-signing integration points + secret wiring
      _(external-gated)_
- [ ] P2-LODGE-3 Lodgement status polling + correspondence ingest
      _(external-gated)_
- [ ] P2-LODGE-4 Lodgement orchestration + audit + retry
      _(live external-gated)_
- [x] P2-FBT FBT return builder RPC + Fbt.tsx + approval gate
- [x] P2-TPAR TPAR builder RPC + Tpar.tsx + export
- [x] P2-FRANK Franking register + dividend/distribution statements +
      reconciliation
- [x] P2-SGC SGC statement + SG-on-OTE/12% fix
- [x] P2-STP STP Phase 2 correctness + TFN secure store/masking + lifecycle
- [x] P2-SUPER SuperStream/clearing-house real dispatch (or documented transport)
- [x] P2-CN Credit notes AR/AP (schema + RPC + UI + GL posting)
- [x] P2-04 Connector product surface (key UI + scope enforcement + OpenAPI +
      audit)
- [x] P2-05a Cross-browser smoke (Chromium/Firefox) on core routes
- [x] P2-05b Mobile/tablet + empty/loading/error states
- [x] P2-05c Keyboard/focus a11y across main workflows
- [x] P2-06a Route-level code splitting + large-asset optimisation
- [x] P2-06b Production security polish (sourcemaps off, CSP, CORS narrowing)
- [x] P2-07a Migration baseline repair + rollback runbook
- [x] P2-07b Staging/deploy workflow + function-inventory reconciliation
- [x] P2-07c Docs index + remaining-compliance backlog stub

---

## Owner-First AI Workstream Overlay

These slices extend the finish-line product beyond the original 51-item tracker.
They are ported into `feat/finish-line`, locally gated, and live database objects
are applied through migration `0236`.

| #     | Slice                                | Status                       | Files                                                                 |
| ----- | ------------------------------------ | ---------------------------- | --------------------------------------------------------------------- |
| SC-01 | Workstream feed                      | [x] local + live DB verified | `0231_workstream_tasks.sql`, `useWorkstreamTasks.ts`, `Dashboard.tsx` |
| SC-02 | Automation decisions                 | [x] local + live DB verified | `0232_automation_decisions.sql`, `automationDecision.ts`              |
| SC-03 | Owner intent launchers               | [x] local verified           | `IntentLauncher.tsx`, `Dashboard.tsx`, `Layout.tsx`                   |
| SC-04 | Anomaly tasks                        | [x] local + live DB verified | `0233_anomaly_signals.sql`, `useWorkstreamTasks.ts`                   |
| SC-05 | AP automation to exception review    | [x] local + live DB verified | `0234_ap_exception_review.sql`, `ConfidenceBadge.tsx`, bills UI       |
| SC-06 | Bank matching to exception review    | [x] local verified           | `Reconciliation.tsx`                                                  |
| SC-07 | Plain-language Tax task layer        | [x] local verified           | `Dashboard.tsx` task routes                                           |
| SC-08 | Advisor/Advanced nav separation      | [x] local verified           | `Layout.tsx` advanced collapse                                        |
| SC-09 | Deploy/live-prove advisor work proof | [~] DB + function live       | signed-in proof still required                                        |
| SC-10 | Distinct bookkeeper role             | [!] not added                | requires product/RBAC decision                                        |
| SC-11 | POS receipt proof                    | [~] functions listed live    | live bridge/terminal proof still required                             |
| SC-12 | Month-end close assistant tasks      | [x] local + live DB verified | `0235_close_tasks.sql`, `Dashboard.tsx`                               |
| SC-13 | Ask AI explanations                  | [x] local verified           | `Ask.tsx`                                                             |
| SC-14 | Automation learning loop             | [x] local + live DB verified | `0236_automation_feedback.sql`, `automationDecision.ts`               |
| SC-15 | Final reconciliation gates           | [x] local gates green        | this tracker + automated gates                                        |

**Owner-first migration ceiling:** `0236_automation_feedback.sql`.

---

### External blockers (cannot be finished in-repo)

Electronic ATO lodgement (P2-LODGE-2/3/4 live) needs ATO **DSP accreditation**,
**EVTE** certification, and **SBR taxonomy hosting** — a
certification/provisioning task outside this build. Scaffolding is built behind
the existing fail-closed gate; live lodgement stays disabled until those are
provisioned.

Direct `supabase migration list --linked` and `supabase db push --linked` remain
unavailable from this runtime because the pooler path rejects authentication and
the direct host does not resolve here. Live apply/proof therefore used the
Management API SQL path: `supabase db query --linked`.
