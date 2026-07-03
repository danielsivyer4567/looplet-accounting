# Runbook: Unblock GL posting — fix the JWT blocker + spine drift

_Created 2026-07-02 · prod `dxoikltymmknxqpkpyhi` · org AFGC
`9d5c9b9a-a576-458d-913a-fa822d33320d` · follows
`docs/runbook-spine-activation-afgc-2026-07.md` (Phases 0–2 done, posting blocked)_

## Context — what the live canary proved (2026-07-02)

Driving `coding-classifier` directly on a real Oxworks invoice
(`eb950f1e-2e57-483e-824e-b3bdd47d91ed`, $850.22) produced:

- ✅ classification perfect: confidence **0.98**, account `5000`, `GST on Expenses`
  (armed `sender_address` rule matched)
- ❌ posting failed closed: `auto_post_skipped: "post_journal_entry: No suitable
  key or wrong key type"` — the classifier's minted HS256 org-token
  (`CONNECTOR_JWT_SECRET`) is **rejected at JWT verification**, characteristic of
  a project on **asymmetric JWT signing keys** where shared-secret HS256 tokens
  are categorically refused.

**Blast radius:** `postBillJournal` is the single posting path used by BOTH
auto-post AND the human review-queue accept/override (`handleDecision`). So no
coded bill can reach the GL by any route. This — not the empty queue — is the
root cause of `journal_entries = 0`.

Two more drift layers found the same day (memory:
`intake-routing-deploy-drift`, `super-batch-send-authz-bug`):

- Deployed `intake-routing-apply` v53 is stale: old `email_sender` matcher
  types, **no coding chain** → coding-classifier is deployed-but-orphaned.
- Deployed `super-batch-send` v15 calls SECURITY INVOKER
  `build_superstream_payload` via service-role → always fails (separate pass).

## The one-line goal

Make `post_journal_entry` reachable by the backend again, re-run the approved
5-bill posting (owner signed off 2026-07-02, "All 5 predicted auto-posts"),
verify the chain end-to-end, then deploy the current router so the spine runs
without hand-cranking.

---

## GUARDRAILS

- Migration apply + edge-fn deploy are **Tier 3** — explicit owner sign-off
  line recorded in this doc before acting. Code-writing and read-only checks
  are Tier 0/1 and run freely.
- **No BEGIN…ROLLBACK dry-runs of function bodies** — the LP-03 incident proved
  dollar-quoted (`$$…$$`) bodies COMMIT through the MCP execute_sql path despite
  a trailing ROLLBACK. Safety = idempotent-by-construction migration + manual
  code-safety review (guardrails Principle 5).
- **DEFINER grant gotcha applies** (memory `definer-fn-grant-gotcha`): the new
  service_role-only fn must `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`
  explicitly — default privileges grant EXECUTE directly; `REVOKE FROM PUBLIC`
  alone leaves it open.
- Posting run stays scoped to the **5 owner-approved bills** (3 are Sales-Order
  docs — owner accepted the double-count risk on record). Anything beyond 5 is
  a new sign-off.
- Legal/money walls unchanged: no lodgement, no ABA/super send, no ATO transmit.

---

## Phase A — Try the cheap route first (Tier 1→3-lite, ~10 min)

Before building anything: check whether the project still has a **legacy HS256
JWT secret** that `post_journal_entry`'s gateway would accept.

1. Owner checks Dashboard → Project Settings → API → JWT settings: is there a
   legacy JWT secret listed alongside the new signing keys?
2. If YES → owner sets edge secret `CONNECTOR_JWT_SECRET` to that value (never
   pasted in chat; dashboard/CLI only). Zero code change. Also un-breaks
   `api-gateway`'s identical minting pattern in one shot.
3. Re-run the canary (Phase D). If it posts → skip Phases B–C entirely.
4. If NO legacy secret (fully on asymmetric keys) → Phase B is the fix.

DONE: either canary posts (jump to D), or a recorded "no legacy secret" line
here and we proceed to B.
Sign-off: **owner (2026-07-02) — cheap route WORKED.** Dashboard showed the
project still on the legacy JWT secret (not migrated); probe reproduced the
exact PGRST301 with a wrong-secret token; owner set `CONNECTOR_JWT_SECRET` to
the legacy secret. Phases B/C skipped. Evidence: `tmp/glfix-d-postrun.md`.
⚠️ Standing hazard recorded: pressing "Migrate JWT secret" in the dashboard
will re-break ALL HS256-minting functions (coding-classifier, api-gateway) —
Phase B becomes mandatory before any such migration.

## Phase B — Build the service-role posting path (Tier 0, code only)

**B1 — Migration** `supabase/migrations/<ts>_post_journal_entry_system.sql`:

- `post_journal_entry_system(p_org uuid, p_entry_id uuid) RETURNS journal_entries`
  `SECURITY DEFINER, SET search_path = public`.
- Fail-closed guard first: `IF auth.role() IS DISTINCT FROM 'service_role' THEN
  RAISE EXCEPTION 'service_role only'; END IF;` (same pattern as the hardened
  `replay_bank_event`).
- Assert the entry exists, `status='draft'`, and `organization_id = p_org`
  (org is passed explicitly and re-checked against the row — never inferred).
- Re-assert the same invariants as `post_journal_entry` (0073): ≥1 line,
  `SUM(debit)=SUM(credit)`, all accounts belong to org + active, then stamp
  `posted_at`/`status='posted'`. Prefer refactoring 0073's body into a shared
  private `_post_journal_entry_core(p_entry_id)` called by both public fns so
  the balance logic can never fork; if refactoring the live fn is too invasive,
  duplicate the checks verbatim with a header comment pinning them to 0073.
- Grants: `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO
  service_role;`
- Idempotent: `CREATE OR REPLACE`, guarded `DO $$` for grants.
- The `check_period_lock()` trigger still fires on the row update — period
  safety is unchanged.

**B2 — `coding-classifier` edit** (repo copy is already current with live v15):
in `postBillJournal`, replace the `mintOrgToken` + anon-client RPC with
`admin.rpc('post_journal_entry_system', { p_org: bill.organization_id,
p_entry_id: entryId })`. Keep the cleanup-draft-on-failure contract and
fail-closed behaviour identical. Delete/park `mintOrgToken` + `signingKey` if
now unused. This automatically fixes the human review path too (same helper).

**B3 — Local gates**: tsc/lint/test green; add/extend a focused test asserting
the classifier calls the system RPC with the bill's org and never mints tokens.

DONE (machine): migration file + classifier diff exist; gates green.
DONE (human): owner reviews the migration's grant block + org-check before C.

## Phase C — Apply + deploy (Tier 3) `[blocked: awaiting sign-off]`

Sign-off: _(owner records approval + date here before acting)_

1. Apply the migration via MCP `apply_migration` (per LP protocol: verify
   `schema_migrations` by **name**, object-existence check, then the
   grants probe: anon/authenticated have **zero** EXECUTE on
   `post_journal_entry_system`).
2. Deploy `coding-classifier` via MCP deploy (per memory
   `edge-fn-deploy-method`); confirm version bump + ACTIVE.
3. Negative probe: call the RPC via a plain authenticated-shaped request →
   must be refused.

DONE (machine): migration row present; grants clean; fn version bumped;
negative probe refused.

## Phase D — Re-run the approved posting (Tier 3, already signed off for 5)

Owner sign-off of 2026-07-02 ("All 5 predicted auto-posts") carries over —
scope unchanged, 5 bills only, serial with per-bill verification.

1. **Canary first**: `Q9SI0008383` ($850.22) through `coding-classifier`.
   Verify: suggestion flips `auto_posted`; `journal_entries` row `posted` with
   3 balanced lines (Dr 5000 net / Dr 1200 GST / Cr 2000 AP — or Cr 1000 if the
   bill is `paid`); trial balance nets to zero. Anything off → STOP, void via
   reversing entry, write up.
2. Remaining 4, one at a time, same checks. Re-invoke one already-posted bill
   → must return `already_posted`, no double journal.
3. Baseline diff vs `tmp/spine-00-02-results.md`: journal_entries 0→5-ish,
   review queue unchanged except expected rows.

DONE (machine): ✅ **complete 2026-07-02** — 5/5 posted+balanced (0.98 conf),
TB=0, 0 dangling drafts, 0 duplicates, canary re-invoke returned same
journal_entry_id, all bill↔journal cross-checks exact. Evidence:
`tmp/glfix-d-postrun.md`.
DONE (human): owner eyeballs the 5 journals (entries e019c144/4a8dc529/
4eed4d82/920f543e/5b390599 — visible in the app's GL).

## Phase E — BAS tie-out on the posted set (Tier 1, read-only)

✅ **Run 2026-07-02, with one material finding** (evidence in
`tmp/glfix-d-postrun.md`): the live BAS GST labels compute from **source
documents** (bills/allocations, incl. estimated-GST ones), NOT from the GL
control account — Q4 1B = 725,735¢ vs GL `1200` movement 28,551¢ (the 5
entries). So BAS↔GL convergence is a **backlog-completion property**, not a
per-batch check: it closes when the quarter's bills are all coded+posted via
review (Phase G), or when the worksheet is re-sourced to the GL/E2 control
accounts (locally-proved wiring, not live).

## Phase F — Un-orphan the spine (Tier 3) ✅ done

Sign-off: owner (2026-07-02) — "both" (F+G approved together).

Executed 2026-07-02:

1. ✅ `intake-routing-apply` **v55** deployed via MCP (repo version: canonical
   matchers + coding chain). Deploy gotcha hit + solved: the old-CLI v53 record
   carried a stale `import_map_path` — fixed by bundling a minimal `deno.json`
   and pointing `import_map_path` at it.
2. ⚠️ First smoke exposed a real incompatibility: the edge runtime injects
   `SUPABASE_SERVICE_ROLE_KEY` in NEW `sb_secret_…` format (not a JWT); the
   classifier's caller-scoped load died with "Expected 3 parts in JWT; got 1".
   Fixed with the codebase's hardened pattern (exact bearer==env comparison →
   admin load for service callers; RLS-scoped IDOR gate unchanged for users) —
   **`coding-classifier` v17 deployed** (repo edited too, uncommitted).
3. ✅ Re-smoke green: `already_routed` + `ledger_handoff` present + classifier
   returned the SAME journal id (no duplicate). Chain is self-driving for newly
   extracted bills. (Reconcile stays starved until a real bank feed — separate.)

**Residual drift found during this phase:** deployed classifier v17 lacks the
repo version's capital-purchase guard + DEFAULT_CATEGORY_ACCOUNT_CODES. Until
the repo classifier (with the v17 fix ported in) is deployed, capital-looking
high-confidence bills CAN auto-post as expenses — Phase G excluded the 4 known
Oxworks capital candidates for exactly this reason. Follow-up: sync repo
classifier → deploy v18, then the exclusions can be dropped.

DONE (machine): v55 + v17 ACTIVE; smoke shows `ledger_handoff`; no dup posts.

## Phase G — Backlog coded ✅ done (owner "both", 2026-07-02)

Evidence: `tmp/glfix-fg-evidence.md`. Batch-drove `coding-classifier` over 193
bills (202 processable − 5 posted − 4 capital candidates held back).

- Result: **193 needs_review, 0 auto-posts, 0 errors.** journal_entries
  unchanged at 5; TB=0; 0 dangling drafts; 193 in coding_review_queue.
- The 1 remaining ≥0.9 review row = Oxworks `Statement.pdf`, held on
  `gst_estimated` — money-wall correct.
- Owner now works the 193-row queue in-app (accept/override posts via the fixed
  path). Follow-up: deploy repo classifier v18 (capital guard + v17
  service-caller fix) → then drive the 4 held capital candidates.

Closeout items still open:
- Update `docs/automation-spine.html` + `docs/remaining-work-todo.md`: C1→E1 is
  live-proved; record the JWT-blocker fix.
- Separate pass (do NOT bundle): `super-batch-send` fix — pull live v15 source
  into repo, swap `admin.rpc('build_superstream_payload')` →
  `userClient.rpc(...)`, redeploy. Tracked in memory.

---

## Sequencing at a glance

```
A (cheap route? 10 min) ──yes──▶ D (post 5) ─▶ E (BAS) ─▶ F (router) ─▶ G
        │ no
        ▼
B (build: migration + classifier edit)   [Tier 0 — can start immediately]
        ▼
C (apply + deploy)  [Tier 3 sign-off]
        ▼
D ─▶ E ─▶ F ─▶ G
```

## Open questions for the owner

1. **Phase A**: does the dashboard show a legacy JWT secret? (10-minute check
   that could make Phases B–C unnecessary.)
2. **Phase F timing**: deploy the router right after D/E, or hold it until the
   finish-line branch integration (it overlaps that epic's file set)?
3. `api-gateway` mints the same HS256 tokens — if Phase A fails, its
   connector-auth path likely has the same blocker. Audit it in the same pass
   or defer?
</content>
