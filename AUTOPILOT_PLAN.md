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
- [x] **A1 follow-up** Gmail disconnect notification code-complete: fatal watch-renew
      auth errors now disable the integration and emit a `gmail_disconnected`
      alert linking back to Settings.
- _Done when:_ `cron_health_summary().http_failures_24h` → 0 and Gmail ingests again.

### EPIC B — Fill the books automatically _(parallel with C)_

- [x] **B1a** Born-digital PDF amount parser hardening: text extraction now
      handles ungrouped 4+ digit totals and avoids misreading `Subtotal` /
      `Total ex GST` as payable total/GST.
- [x] **B1b** OCR provider replacement code-complete: the provider router now
      prefers MiniMax over legacy Groq, keeps Anthropic as the native PDF/image
      path, and falls through to other configured providers instead of failing
      the extraction on the first provider error.
- [ ] **B1c** Live OCR reliability proof: run a representative bill sample /
      repair batch and verify amount+GST coverage reaches the ≥95% target.
- [x] **B2a** Re-OCR/repair queue code-complete: `bills-extract-batch`
      supports repair mode, forces real re-extraction instead of copying cached
      failed null-amount rows, and queued `bill_extract` batch jobs can now pass
      `mode=repair`, `max`, and `delay_ms` through `automation-worker`. The
      Data Quality page can enqueue the repair batch for the selected org.
- [ ] **B2b** Live backfill the historical failed/missing-amount bills with the
      paid repair loop and verify the before/after GST coverage counts.
- [x] **B3a** GST-coverage pre-lodge gate in the BAS prep UI. Lodge approval
      now stays blocked unless GST treatment, GL reconciliation, and
      `v_bas_gst_coverage` all positively verify.
- [ ] **B3b** Live GST coverage target before BAS is operationally ready.
- _Done when:_ ≥95% of bills carry amount+GST; BAS view is real.

### EPIC C — Connect the money in _(parallel with B)_

- [ ] **C1** Real Basiq (AU CDR) feed end-to-end (`bank-link → exchange → sync → webhook`).
- [x] **C2a** Auto-reconcile proof safety code-complete: auto-applied bank
      matches use transactional RPC wrappers so the reconciliation evidence row
      is committed with the match or the match rolls back once deployed.
- [ ] **C2b** Live auto-reconciler proof over candidate views; auto-match
      unambiguous above threshold and leave rival candidates untouched.
- [x] **C3a** Auto-confirm source wiring code-complete: post-bank-sync now runs
      `subscriptions-autoconfirm` after detection and surfaces failures as
      retryable post-sync errors instead of leaving high-confidence candidates
      waiting for manual confirmation.
- [ ] **C3b** Live auto-confirm proof with seeded/real recurring bank debits.
- _Done when:_ live txns flow; bills reach `paid` with no manual clicks.

### EPIC D — Reduce human touch _(after B+C)_

- [x] **D1a** Confidence-tiered auto-accept code-complete: `gmail-classify-ai`
      now auto-approves only safe high-confidence business classifications,
      creates/reuses supplier/customer records, creates/reuses the matching
      `intake_rules` row, links `staged_entities.resolved_rule_id`, and leaves
      risky/uncategorized/personal classifications in review.
- [ ] **D1b** Deploy + live-prove the classifier auto-approval path against
      real `staged_entities` so pending triage rows turn into reusable
      `intake_rules` without a manual Triage click.
- [x] **D2a** Xero push retry idempotency: queued worker retries now pass the
      automation job id through to the Xero push functions, and direct calls
      fall back to deterministic UUID-shaped keys instead of random keys.
- [ ] **D2b** Xero push backfill + live Xero proof.

### EPIC E — Make it trustworthy _(start early; gates merges)_

- [x] **E1** Real CI tenant-isolation gate is code-complete: two seeded orgs,
      cross-tenant RLS assertions, CI hard-fail on missing Supabase env, and no
      stale `describe.skip`/`expect(true)` gate. Live PR-run proof still depends on
      GitHub test secrets being present.
- [x] **E2a** Accounting-engine source contracts are covered locally: GST
      control-account debit/credit splits, BAS GST/PAYG worksheet labels,
      invoice reconciliation amount safety, approval-bound ABA export, and
      Xero push idempotency headers are pinned by
      `tests/accounting-engine-contract.test.ts`.
- [ ] **E2b** Live accounting-engine proof: run the Supabase-backed gates for
      BAS worksheet PDF, ABA export, reconciliation/period close, PAYG/payroll,
      and Xero push against a seeded org with live env secrets.
- [x] **E3a** Period-lock money-table enforcement code-complete:
      `check_period_lock()` now reads the real accounting date for invoices,
      invoice payments, bank transactions, payroll runs, and ABA payment runs,
      plus journal entry headers, and attaches triggers to the later-created
      money tables. Contract covered by
      `tests/period-lock-money-tables-contract.test.ts`.
- [ ] **E3b** Remaining hardening live apply: `notify()` org-guard is code-complete in
      `20260701062500_harden_notify_org_guard.sql` and covered by
      `tests/notify-org-guard-contract.test.ts`; `search_path` hardening
      (`0060`), FK indexes (`0061`), and money-table audit triggers (`0062`)
      exist in the migration chain. Live apply of the new notify guard and the
      period-lock money-table migration is still pending because the current
      Supabase CLI connection rejects `SUPABASE_DB_PASSWORD`.

### EPIC F — Connector API _(parallel; scaffold in PR #9)_

- [x] **F2a** Connector ingest tenant-pin hardening code-complete: bill,
      invoice, and payment payload foreign IDs are verified against the
      connector key's organization before write/enqueue (`supplier_id`, `job_id`,
      `customer_id`, `invoice_id`). Deno tests cover rejection before DB writes
      or automation queueing, and the public connector docs now state the rule.
- [x] **F3a** Connector key management UI code-complete: Settings now has a
      general Connector API keys panel that lists non-secret key metadata,
      issues one-time `llp_` keys through `issue_api_key`, revokes via
      `revoke_api_key`, and surfaces recent `api_request_log` calls without
      selecting `hashed_key`.
- [x] **F4a** Connector contract docs are synced locally: `docs/openapi.yaml`
      and `docs/connector-guide.md` now list every live ingest type/scope
      (`bill`, `bank_transaction`, `invoice`, `document`, `payment`), warn that
      gateway JWTs grant full-org read, and no longer advertise forbidden raw
      invoice status writes. Contract covered by
      `tests/connector-api-docs-contract.test.ts`.
- [ ] **F1/F2b/F3b/F4b** Live connector proof and polish: prove the
      api-gateway JWT/RLS path with a real key, finish/shared-importer dedupe
      consolidation, verify per-key rate-limit/audit-log behavior live, and
      keep deployed docs/examples in sync with the live contract.

### EPIC G — Real accounting _(largest; needs clean data from B)_

- [x] **G1a** Double-entry GL foundation code-complete: `chart_of_accounts`,
      `journal_entries`/`journal_lines`, `post_journal_entry`, immutable posted
      entries, same-org line/account guards, and the shared `postJournalEntry`
      helper are in source and locally covered.
- [x] **G2a** GL-derived statutory statements code-complete:
      `generate_statutory_statements` now reports P&L by requested AU FY period
      and Balance Sheet as-at FY end, carrying prior-period income/expense as
      opening retained earnings so the statement balances before formal closing
      journals. Contract covered by `tests/accounting-engine-contract.test.ts`.
- [x] **G3a** BAS G10/G11 purchase split code-complete:
      `generate_bas_worksheet_gst` now keeps sales/GST collected on the existing
      BAS quarterly source, but splits purchases into G10 capital and G11
      non-capital using allocation-aware bills plus account/supplier
      `GST_ON_CAPITAL` treatment. `generate_bas_worksheet` also derives
      quarter dates from the requested FY/quarter, so nil and bills-only BAS
      worksheets no longer lose due-date metadata. `prepare_bas_lodgement_draft`
      creates/reuses an append-only BAS lodgement row and opens Tier-2 approval
      against that row's exact worksheet payload, so the Lodgements page has a
      durable draft before transport exists. `bas-lodgement-pack` now turns
      that draft row into a downloadable review bundle/PDF from the immutable
      payload without ATO transmission. Contracts covered by
      `tests/accounting-engine-contract.test.ts`,
      `tests/bas-lodgement-draft-contract.test.ts`, and
      `tests/bas-lodgement-pack-contract.test.ts`; deploy-gated live proof is
      encoded in `tests/bas-lodgement-pack.test.ts`.
- [ ] **G1b/G2b** Live GL proof: seed a real org chart of accounts, post a
      balanced fixture through `post_journal_entry`, verify `v_trial_balance`,
      statutory statements, equity, and cash-flow outputs against expected
      cents.
- [ ] **G3b** Live BAS worksheet proof: apply the G10/G11 split migration to a
      real org with at least one `GST_ON_CAPITAL` bill line, then verify
      `generate_bas_worksheet` output against expected G1/G10/G11/1A/1B/W labels.
- [ ] **G3c+** Remaining BAS/ATO work: SBR e-lodgement and edge-case labels
      beyond current G/W coverage. BAS draft PDF/workpaper packaging is now
      code-complete locally via `bas-lodgement-pack`, but live deploy/proof is
      still pending.
- [ ] **G4** STP Phase 2 + SuperStream + real TFNs · **G5** credit notes, fixed assets/depreciation, accruals, period-locks everywhere, EOFY pack.

---

## Execution

Use the built-in `ledger` → `work` → `check` → `ship-epic` skills (one epic per worktree/PR),
plus the installed `supabase-postgres-best-practices` skill for RLS/migration/edge-fn guidance.
Run from the project root: `C:\repos\looplet-accounting`.
