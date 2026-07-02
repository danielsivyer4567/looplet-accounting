# Runbook: Automation Spine Activation — AFGC 503-bill backlog

_Created 2026-07-02 · prod project `dxoikltymmknxqpkpyhi` · org `Affordable Fencing
Gold Coast` (`9d5c9b9a-a576-458d-913a-fa822d33320d`)_

## The one-line goal

Take AFGC from **0 GL entries → a real, posted, reconciled set of books + a BAS
that ties out**, by driving the *existing* backbone over the 503-bill backlog
and verifying the chain link-by-link — canary first, then a small batch, then
full scale. Nothing new is built to post money; we exercise what's already live.

## Why this is needed (confirmed)

The schedulers are alive (14 crons, 376 worker runs/24h, 0 failures) but
`automation_jobs` has **never held a job**, `automation_decisions` = 0,
`journal_entries` = 0, `bank_txns` matched = 0. The worker fires into a void
because **nothing enqueues coding work**. This is the "inert middle."

## The chain, as it actually is in the code (not the diagram)

Verified by reading source on 2026-07-02:

| # | Link | Mechanism (real) | File |
|---|------|------------------|------|
| 0 | received bill → extracted | worker `bill_extract` job → `bills-extract-batch` (drains `status='received'`, ~1/2s) → `bills-extract` OCR per bill | `supabase/functions/automation-worker/index.ts:100-123` |
| 1 | extracted bill → routed + coded | `bills-extract` chains → `intake-routing-apply` (service_role); single `target:'bill'` **chains into** `coding-classifier` | `intake-routing-apply/index.ts:18-22`, `bills-extract/index.ts:615-632` |
| 2 | coded → GL | `coding-classifier` writes a **`coding_suggestions`** row; posts via `post_journal_entry` **iff** `confidence ≥ 0.9` AND account resolves AND GST not estimated AND not a capital candidate; else `needs_review` | `coding-classifier/index.ts:35,475-549,730-760` |
| 3 | GL write | immutable journal engine, `post_journal_entry()` RPC (granted to `authenticated`; classifier mints an org-scoped JWT via `CONNECTOR_JWT_SECRET` to authorize the backend call); draft auto-deleted on failure; posted→void only | `0073_posting_rules.sql`, `docs/gl-posting-interface.md` |
| 4 | GL lines | Dr expense (net), Dr GST input `1200`, Cr AP `2000` (or Bank `1000` if paid) — **hardcoded codes, coupled to seeded COA** | `coding-classifier/index.ts:403-441` |
| 5 | reconcile | worker job kind `bank_reconcile` → `auto-reconcile`; `reconcile_match_bill/invoice_with_evidence` RPCs | `automation-worker/index.ts:198-206`, `20260701070000_reconcile_evidence_atomic.sql` |
| 6 | BAS tie-out | `generate_bas_worksheet_gst` + `generate_bas_worksheet` (SECURITY INVOKER, both live LP-04) read the posted GL | `0122_bas_worksheet.sql` |

**Critical finding — there is no durable job kind that codes a bill.** The
worker's `coding_classify` kind dispatches to `gmail-classify-ai` (Gmail thread
triage), *not* the bill coder (`automation-worker/index.ts:250-263`). Coding is
reachable *only* via extract → routing → classifier. So the activation lever is
one of two, depending on bill `status`:

- **`status='received'` (never extracted):** enqueue a batch `bill_extract` job
  (no `bill_id`) or call `bills-extract-batch` directly `{organization_id, max,
  delay_ms}` — it OCRs then chains routing+coding, returns a `remaining` count.
- **Already extracted (has totals, past `received`) but never coded:**
  `bills-extract-batch` mode `received` won't re-pick them. Re-drive per bill via
  `intake-routing-apply {organization_id, target:'bill', target_id}` (routes +
  codes, one deterministic outcome each — the ideal throttle), or
  `bills-extract force:true` / batch mode `repair`.

**`coding_suggestions` ≠ `automation_decisions`.** The bill coder writes
`coding_suggestions` (numeric `confidence` 0–1, status `needs_review |
auto_posted | accepted | overridden | rejected`, one live row per bill).
`automation_decisions` is a *separate* generic acceptance-ledger (enum confidence;
bank/receipt/supplier matches) that the bill-coding gate never consults — so
"`automation_decisions = 0`" is expected and is **not** the signal for whether
bills are coded. The signal is: a `coding_suggestions` row exists, and
`auto_posted` iff a matching `journal_entries` row is `posted`.

## Confidence model (the money-wall, encoded)

`AUTO_POST_THRESHOLD = 0.9`. Base confidence by matcher type:

| matcher_type | base | can it clear 0.9? |
|---|---|---|
| `sender_address` | 0.95 | ✅ yes |
| `sender_domain` | 0.85 | only with +0.03 override AND +0.03 (hit_count≥3) = 0.91 |
| `attachment_name` | 0.80 | ❌ |
| `subject_pattern` | 0.70 | ❌ |
| `body_keyword` | 0.65 | ❌ |
| `sender_name` | 0.60 | ❌ |

Plus hard downgrades: no resolvable `accountCode` → capped at 0.4; `gst_estimated`
→ blocked from auto-post; capital-purchase candidates → forced to review even at
high confidence. **Net: only bills matched by a `sender_address` intake rule (or a
well-worn `sender_domain` rule) with a real account and firm GST auto-post. The
other ~majority of 503 route to `coding_review_queue` — safe by design.**

---

## GUARDRAILS (money-wall)

Per autoloop policy and the live-proof tier model:

- **No GL post happens without a recorded owner sign-off line** in this runbook.
  Every posting slice below is `Tier 3 [blocked: awaiting sign-off]`.
- The `work` skill auto-continue **skips** `[blocked]` slices — do not flip one
  to in-progress without a sign-off line first.
- All prediction/inspection is Tier 1 (read-only) and runs freely.
- Corrections are **reversing entries, never mutations** (posted rows are frozen).
- No lodgement, no ABA/super send, no ATO transmit — those walls stay up regardless.

---

## Phase 0 — Baseline snapshot (Tier 1, read-only)

Capture the "before" so every later count is provable. Single read-only SQL batch:

- `bills` count by `status` (`received|verified|attached|paid|void`) for the org —
  this decides the entry point: `received` count = the extract-batch path;
  extracted-but-uncoded = the per-bill re-drive path.
- `bills` with `total_inc_gst_cents IS NOT NULL` (only these can post) and with
  `gst_estimated = true` (these can't auto-post).
- `coding_suggestions` count by status (the real "coded" signal; expect ~0).
- `journal_entries` count (expect 0), `journal_lines` count.
- `coding_review_queue` count. (`automation_decisions` is *not* the bill signal —
  skip or note it's expected 0/irrelevant here.)
- `automation_jobs` count by status (expect empty).
- `bank_transactions` count + matched count (expect matched 0).
- `automation_dead_letters` count (expect 0).

**DONE:** `tmp/spine-00-baseline.md` with all counts + timestamp + which entry
point the `status` mix implies.

## Phase 1 — Preconditions gate (Tier 1, read-only)

Auto-post silently falls back to review if any of these are missing — verify
first so we don't misread "everything went to review" as a bug:

1. `CONNECTOR_JWT_SECRET` set in `coding-classifier` env (else posting
   fails closed with `"CONNECTOR_JWT_SECRET unset; cannot post"` → everything to
   review). Probe via secrets list (digest only). **If unset, the demo is dead on
   arrival — fix first.**
2. `chart_of_accounts` seeded for the org so the classifier's **hardcoded codes
   `1000`/`1200`/`2000` + expense codes resolve** (it couples to
   `seed_default_chart_of_accounts`, 0073). An unseeded/renamed COA → review.
3. (If the classifier uses the E2 control-account path) `system_accounts` has a
   **live `gst_paid` designation** for the org — else GST-bearing bills fall to
   review. Read-only query.
4. No active `period_locks` covering the bills' `invoice_date` (the
   `check_period_lock()` trigger on `journal_entries` rejects posts dated inside
   a lock). Read-only query on `period_locks WHERE unlocked_at IS NULL`.
5. `intake_rules` for the org — how many, of which `matcher_type`. **No
   `sender_address`/`sender_domain` rule → predicted auto-post yield ≈ 0** and the
   whole 503 correctly routes to review (still a valid, safe outcome).
6. Worker cron live: `SELECT * FROM cron.job WHERE
   jobname='automation-worker-every-2min'` (Vault-gated on
   `automation_worker_cron_secret`; expected present given 376 runs/24h). Only
   matters if we drive via enqueued jobs rather than direct fn calls.
7. `intake-routing-apply`, `coding-classifier`, `bills-extract-batch`,
   `automation-worker` deployed & current (diff live source vs repo if in doubt,
   as LP-09 did for bas-pack).

**DONE:** `tmp/spine-01-preconditions.md` — each item PASS/FAIL. Any FAIL that
would send everything to review is noted so Phase 3 results are interpreted right.

## Phase 2 — Predict the auto-post set WITHOUT posting (Tier 1, read-only)

There is no pure "dry" mode in `coding-classifier` (it writes a suggestion and may
post). So we predict in SQL by replicating the match logic read-only:

- For each pending bill, does its `intake_metadata` sender match an **active
  `sender_address` intake_rule** (or a `sender_domain` rule with hit_count≥3 +
  override) with a **resolvable account_code**, `gst_estimated = false`, and
  `total_inc_gst_cents` present?
- Output: the predicted **auto-post list** (N bills) + the predicted **review
  list**, and for the auto-post list, the expected journal shape per bill
  (Dr expense net, Dr gst_paid gst, Cr AP total).

**Present this list to the owner. This is the last read-only checkpoint before
any real money hits the books.**

**DONE:** `tmp/spine-02-prediction.md` — predicted auto-post bill_ids + expected
lines + predicted review count. No writes.

## Phase 3 — Single-bill live canary (Tier 3, `[blocked: awaiting sign-off]`)

> Sign-off: _(owner records "approved canary bill <id>" + date here before acting)_

Pick **one** bill from the Phase-2 auto-post list. Call `intake-routing-apply`
(service_role) with `{organization_id, target:'bill', target_id:<id>}`.

Verify link-by-link:
1. `coding_suggestions` row appeared for the bill (numeric `confidence`, proposed
   `account_code`/`tax_code`, `rationale`).
2. `coding_suggestions.status = 'auto_posted'` (or `needs_review` — record which
   and why, e.g. `auto_post_skipped` reason).
3. `journal_entries` row: `status='posted'`, `source_type='bill'`,
   `source_id=<bill>`, lines **balance** (Σdebit = Σcredit), account_ids belong to
   org & active, GST input line present (code `1200`).
4. Org **trial balance still nets to zero**.

If anything is wrong: **void via reversing entry** (never mutate), write up what
broke, STOP. Do not proceed to batch.

**DONE (machine):** one posted, balanced, correct journal traced end-to-end;
trial balance = 0. Evidence `tmp/spine-03-canary.md`.
**DONE (human):** owner confirms the single journal is correct before batch.

## Phase 4 — Small batch of 5–10 (Tier 3, `[blocked: awaiting sign-off]`)

> Sign-off: _(owner records approved batch size + date here)_

Feed 5–10 Phase-2 bills through `intake-routing-apply`, one at a time (serial, so
a bad row can't cascade). Verify:
- Each predicted auto-post posted correctly (balanced, right accounts).
- Each predicted review bill is in `coding_review_queue` with **no journal**.
- Re-invoking a already-`auto_posted` bill does **not** double-post (idempotency —
  confirm the classifier skips/keeps single live suggestion).
- If bank_txns exist for these suppliers: enqueue one `bank_reconcile` job and
  confirm `auto-reconcile` writes `reconciliation_evidence` (matched > 0). If no
  bank feed is synced, record that reconcile proof is **blocked on a bank feed**
  (separate prereq, not a failure of this phase).

**DONE (machine):** batch posted with 0 incorrect journals, review-routing correct,
no double-posts. Evidence `tmp/spine-04-batch.md`.
**DONE (human):** owner reviews batch outcome, approves scaling.

## Phase 5 — BAS tie-out on the batch (Tier 1, read-only)

Run `generate_bas_worksheet_gst` + `generate_bas_worksheet` for the batch's
period. Confirm the input-GST (G11/1B) from the freshly posted journals shows up
and **reconciles to `v_gst_reconciliation` / the `gst_paid` control account**.
This is the "BAS ties to GL" proof at small scale.

**DONE:** `tmp/spine-05-bas.md` — worksheet totals vs GL control account, delta = 0.

## Phase 6 — Scale to full backlog (Tier 3, `[blocked: awaiting sign-off]`)

> Sign-off: _(owner records "approved full 503 run" + date here)_

Only after Phases 3–5 are clean. Drive all remaining pending bills through
`intake-routing-apply` with throttling. Monitor as it runs:
- `journal_entries` growth, `coding_review_queue` growth, `dead_letters` (should
  stay 0), worker/HTTP error rate.
- Stop-loss: if any journal fails to balance or an unexpected account posts, halt.

Post-run books state:
- Trial balance nets to 0; `journal_entries` count; review-queue count (the human
  backlog that remains by design); full-period BAS worksheet tied to GL.

**DONE (machine):** all pending bills processed; every posted journal balances;
BAS worksheet ties to GL; dead_letters = 0.
**DONE (human):** owner accepts the resulting books + remaining review backlog.

---

## Cross-cutting notes

- **Enqueue vs direct:** we drive `intake-routing-apply` directly (service_role)
  because no `bill_code` job kind exists. This is a one-shot backlog drain, not
  the steady-state loop.
- **Follow-up epic (separate) — "books that keep themselves":** add a durable
  `bill_code` job kind to `automation-worker` (dispatch → intake-routing-apply
  per bill) + an orchestrator that enqueues coding for newly-extracted bills, then
  cron it. That converts this manual drain into the autonomous loop. Out of scope
  for *this* runbook, which is about proving the chain turns over at all.
- **Reconcile reality:** `bank_txns` matched = 0 partly because no bank feed may be
  synced for this org. Full reconcile proof likely needs a Basiq feed first (LP/P3
  external gate). Don't block the GL proof on it.
- **Rollback posture:** failed posts self-clean (draft deleted); bad posts are
  reversed via void; closed periods protected by `period_lock`; idempotency via the
  single-live-suggestion rule. Confirm the last one empirically in Phase 4.
- **Walls that never move:** ATO/SBR lodgement, ABA release, super send, STP
  transmit, SMSF audit — untouched by this runbook.

## Open questions to resolve during Phase 1 (don't guess)

1. Are the 503 bills actually extract-complete, or are ~299 still raw (503 total,
   204 with totals)? Only extract-complete bills with totals can post. This resizes
   the realistic auto-post yield.
2. Does the org have any `sender_address` intake rules at all? If not, the
   auto-post yield is ~0 and the whole 503 correctly routes to review — which is
   still a valid, safe outcome (proves the review path), just not a GL demo.
3. Is `CONNECTOR_JWT_SECRET` set for `coding-classifier`? If not, **nothing posts**
   regardless of confidence — fix that first or the demo is dead on arrival.
</content>
</invoke>
