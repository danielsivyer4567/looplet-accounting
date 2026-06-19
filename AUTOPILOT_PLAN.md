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

### ✅ EPIC 0 — Security base *(done — PR #9, live)*
Cross-tenant view leak closed, `system_defaults` locked, anon definer-fn execute revoked.

### ◐ EPIC A — Keep the lights on *(this PR + RUNBOOK_EPIC_A.md)*
- [x] **A3** Cron health monitor (`cron_health_summary()`, migration 0057) — live; surfaced 37 hidden HTTP failures/24h.
- [x] **A4** Remove forgeable-JWT branch in `bank-sync-all` + `notifications-cron` (constant-time auth).
- [x] **A1** Gmail dead-integration handling — disable + flag on fatal `invalid_grant` (mirrors Xero).
- [ ] **A2** Fix the two failing crons — **needs you** (CLI secrets): see `RUNBOOK_EPIC_A.md` (bank-sync-all `?secret=`, accountant-digest Vault secret, Gmail reconnect).
- [ ] **A1 follow-up** emit a notification on disconnect (after notifications schema confirmed).
- *Done when:* `cron_health_summary().http_failures_24h` → 0 and Gmail ingests again.

### EPIC B — Fill the books automatically *(parallel with C)*
- [ ] **B1** Diagnose/replace OCR provider (groq @ 0.41 conf, GST null) → reliable amount+GST.
- [ ] **B2** Re-OCR/repair queue + backfill the 247 existing bills.
- [ ] **B3** GST-coverage gate before BAS surfaces/lodges.
- *Done when:* ≥95% of bills carry amount+GST; BAS view is real.

### EPIC C — Connect the money in *(parallel with B)*
- [ ] **C1** Real Basiq (AU CDR) feed end-to-end (`bank-link → exchange → sync → webhook`).
- [ ] **C2** Auto-reconciler edge fn over candidate views; auto-match unambiguous above threshold.
- [ ] **C3** Auto-confirm high-confidence subscription candidates.
- *Done when:* live txns flow; bills reach `paid` with no manual clicks.

### EPIC D — Reduce human touch *(after B+C)*
- [ ] **D1** Confidence-tiered auto-accept for `gmail-classify-ai` + intake routing.
- [ ] **D2** Xero push retry/backfill + idempotency.

### EPIC E — Make it trustworthy *(start early; gates merges)*
- [ ] **E1** Real CI tenant-isolation gate (two seeded orgs) + fix 8 lint errors.
- [ ] **E2** Accounting-engine tests (GST split, BAS, reconciliation, PAYG, ABA, Xero push).
- [ ] **E3** Remaining hardening: `notify()` org-guard, `search_path` on definer fns, 61 FK indexes, audit triggers on money tables.

### EPIC F — Connector API *(parallel; scaffold in PR #9)*
- [ ] **F1** Finish gateway JWT↔RLS wiring · **F2** ingest handlers via shared importer+dedupe · **F3** key-management UI + rate-limit + API audit log · **F4** OpenAPI + integration guide.

### EPIC G — Real accounting *(largest; needs clean data from B)*
- [ ] **G1** Double-entry GL: `chart_of_accounts`, `journal_entries`/`journal_lines`, posting rules.
- [ ] **G2** Derive P&L / Balance Sheet / Trial Balance from postings (fix GST-inclusive revenue mixing).
- [ ] **G3** BAS W1/W2 + G-codes + SBR e-lodgement · **G4** STP Phase 2 + SuperStream + real TFNs · **G5** credit notes, fixed assets/depreciation, accruals, period-locks everywhere, EOFY pack.

---

## Execution
Use the built-in `ledger` → `work` → `check` → `ship-epic` skills (one epic per worktree/PR),
plus the installed `supabase-postgres-best-practices` skill for RLS/migration/edge-fn guidance.
Run from the project root: `C:\repos\looplet-accounting`.
