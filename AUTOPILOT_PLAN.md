# Autopilot Accounting — Implementation Plan

Turns the `AUDIT.md` backlog into a sequenced build toward three goals:
**(a)** runs continuously in the background with minimal human touch, **(b)** exposes a
REST/connector API so any source can push/pull, **(c)** complete enough to do all the
accounting itself.

**North-star loop:** `Ingest → Extract (OCR amounts/GST) → Classify/Route → Reconcile
(bank↔bills) → Post (double-entry) → Comply (BAS/STP) → Push (Xero) → Monitor`.
Humans touch only low-confidence exceptions.

**Critical path:** A → (B ∥ C) → D → G, with E gating merges and F in parallel.

---

### ✅ EPIC 0 — Security base _(done — PR #9, live)_

Cross-tenant view leak closed, `system_defaults` locked, anon definer-fn execute revoked.

### ◐ EPIC A — Keep the lights on _(this PR + RUNBOOK_EPIC_A.md)_

- [x] **A3** Cron health monitor (`cron_health_summary()`, migration 0057) — live; surfaced 37 hidden HTTP failures/24h.
- [x] **A4** Remove forgeable-JWT branch in `bank-sync-all` + `notifications-cron` (constant-time auth).
- [x] **A2a** Fix `bank-sync-all` cron auth — live cron job 14 reads a scoped
      Vault-held secret and a DB-side `pg_net` probe returned HTTP 200.
- [x] **A2b** Fix `accountant-digest-cron` auth — live cron job 15 reads a
      scoped Vault-held secret and a DB-side `pg_net` probe returned HTTP 200.
- [x] **A2c** Track core cron schedules — migration 0197 now owns
      `bank-sync-all`, `notifications-cron-nightly`, and
      `accountant-digest-cron` with Vault-backed command strings.
- [x] **A1** Gmail dead-integration handling — disable + flag on fatal `invalid_grant` (mirrors Xero).
- [ ] **A1 follow-up** Reconnect Gmail and capture a real watched-mailbox event
      trace.
- [ ] **A1 follow-up** emit a notification on disconnect (after notifications schema confirmed).
- _Done when:_ `cron_health_summary().http_failures_24h` → 0 and Gmail ingests again.

### EPIC B — Fill the books automatically _(parallel with C)_

- [ ] **B1** Diagnose/replace OCR provider (groq @ 0.41 conf, GST null) → reliable amount+GST.
- [ ] **B2** Re-OCR/repair queue + backfill the 247 existing bills.
- [ ] **B3** GST-coverage gate before BAS surfaces/lodges.
- _Done when:_ ≥95% of bills carry amount+GST; BAS view is real.

### EPIC C — Connect the money in _(parallel with B)_

- [ ] **C1** Real Basiq (AU CDR) feed end-to-end (`bank-link → exchange → sync → webhook`).
- [ ] **C2** Auto-reconciler edge fn over candidate views; auto-match unambiguous above threshold.
- [ ] **C3** Auto-confirm high-confidence subscription candidates.
- _Done when:_ live txns flow; bills reach `paid` with no manual clicks.

### EPIC D — Reduce human touch _(after B+C)_

- [ ] **D1** Confidence-tiered auto-accept for `gmail-classify-ai` + intake routing.
- [ ] **D2** Xero push retry/backfill + idempotency.

### EPIC E — Make it trustworthy _(start early; gates merges)_

- [x] **E1** Real CI tenant-isolation gate is code-complete: two seeded orgs,
      cross-tenant RLS assertions, CI hard-fail on missing Supabase env, and no
      stale `describe.skip`/`expect(true)` gate. Live PR-run proof still depends on
      GitHub test secrets being present.
- [ ] **E2** Accounting-engine tests (GST split, BAS, reconciliation, PAYG, ABA, Xero push).
- [ ] **E3** Remaining hardening: `notify()` org-guard is code-complete in
      `20260701062500_harden_notify_org_guard.sql` and covered by
      `tests/notify-org-guard-contract.test.ts`; `search_path` hardening
      (`0060`), FK indexes (`0061`), and money-table audit triggers (`0062`)
      exist in the migration chain. Live apply of the new notify guard is still
      pending because the current Supabase CLI connection rejects
      `SUPABASE_DB_PASSWORD`.

### EPIC F — Connector API _(parallel; scaffold in PR #9)_

- [ ] **F1** Finish gateway JWT↔RLS wiring · **F2** ingest handlers via shared importer+dedupe · **F3** key-management UI + rate-limit + API audit log · **F4** OpenAPI + integration guide.

### EPIC G — Real accounting _(largest; needs clean data from B)_

- [ ] **G1** Double-entry GL: `chart_of_accounts`, `journal_entries`/`journal_lines`, posting rules.
- [ ] **G2** Derive P&L / Balance Sheet / Trial Balance from postings (fix GST-inclusive revenue mixing).
- [ ] **G3** BAS W1/W2 + G-codes + SBR e-lodgement · **G4** STP Phase 2 + SuperStream + real TFNs · **G5** credit notes, fixed assets/depreciation, accruals, period-locks everywhere, EOFY pack.

---

## Execution

Use the built-in `ledger` → `work` → `check` → `ship-epic` skills (one epic per worktree/PR),
plus the installed `supabase-postgres-best-practices` skill for RLS/migration/edge-fn guidance.
Run from the project root: `C:\repos\looplet-accounting`.
