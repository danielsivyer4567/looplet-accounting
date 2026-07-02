# Guard Rails for the Live-Proof Push — 2026-07

This document is the safety constitution for finishing the open issues in
`docs/proof-run-2026-07-02.md` against the **live production** Supabase project
(`dxoikltymmknxqpkpyhi`). It exists so a junior developer can execute the
remaining work without being able to cause damage.

Read this document once, fully, before opening the runbook. Then work only
from the runbook: `docs/runbook-live-proof-2026-07.md`. The runbook is a
sequence of task cards (LP-00 … LP-14). You execute them in order. You never
improvise.

Companion files:

- `docs/runbook-live-proof-2026-07.md` — the ordered task cards.
- `docs/live-apply-checklist-2026-07-02.md` — the underlying apply sequence
  every card wraps. The runbook references its stages; do not follow the
  checklist directly without the runbook's guard rails.
- `scripts/guard-preflight.mjs` (`npm run guard:preflight`) — the go/no-go
  gate you must run before any Tier 2 task.
- `.claude/scratch/ledger.md` — the live task ledger tracking which card is
  next and which cards are blocked awaiting the owner's action or sign-off.

## The Seven Principles (memorize these)

1. **Secrets go only into `.env.local`.** Never type a secret into a chat,
   a commit, a log, a doc, or an `echo` command. `.env.local` is gitignored;
   everything else is not safe.
2. **One change at a time, verify before AND after.** Never batch two prod
   changes into one step. Every card tells you what to check before you act
   and what to check after.
3. **If the output differs from "Expected output", STOP.** Do not retry with
   variations. Do not "fix" the command. Capture the exact output into
   `tmp/`, mark the card `[blocked]` in the ledger, and escalate.
4. **Tier 3 needs recorded sign-off BEFORE the first command.** Sign-off is a
   line in the ledger (`Sign-off: <name> @ <date>`), written by the owner —
   not by you.
5. **`BEGIN … ROLLBACK` is your sandbox — for simple statements only.** Any
   question about live data (a plain SELECT/INSERT/UPDATE probe) gets
   answered inside a single `BEGIN; … ROLLBACK;` execution; it can never
   leave a mark. **Exception, confirmed empirically 2026-07-02:** this does
   NOT reliably protect a full migration file containing dollar-quoted
   (`$$...$$`) function/DO bodies via the Supabase MCP `execute_sql` tool —
   a real test rolled back correctly for plain DDL/DML but did not for a
   `CREATE FUNCTION ... AS $$...$$` + `DO $$...$$` migration (see
   `docs/runbook-live-proof-2026-07.md`'s per-migration protocol). For that
   shape of content, use code-safety review (idempotency check) instead of a
   live dry-run.
6. **New migrations use full timestamp filenames** (e.g.
   `20260702130000_name.sql`). Three worktrees have historically pushed
   colliding sequence numbers to the same prod DB — timestamps are the fix.
   You should not need to write a new migration in this runbook at all; if
   you think you do, that is an escalation.
7. **After any `SECURITY DEFINER` migration, verify the grants.** Postgres
   default privileges grant EXECUTE to `authenticated`/`anon` directly;
   `REVOKE FROM PUBLIC` alone is NOT enough. Each migration card includes the
   exact grant check.

## The Tier Model

Every action you could take belongs to exactly one tier. Every runbook card
declares its tier. When in doubt, treat the action as one tier higher.

### Tier 0 — Always allowed (local machine only)

No preconditions. Cannot touch prod.

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`
- `npm run wrap:visual-smoke` (Playwright against a mocked Supabase)
- `npm run check:local-env`
- `git status`, `git diff`, `git log`, reading any file in the repo

### Tier 1 — Read-only against prod

Allowed once `.env.local` parses cleanly. These observe production; they never
change it.

- `npm run supabase:readiness`, `npm run wrap:live-audit`,
  `npm run guard:preflight`
- `supabase migration list --linked`, `supabase functions list`,
  `supabase secrets list` (**names only** — the CLI never prints values;
  do not try to make it)
- `SELECT`-only SQL against prod
- The `BEGIN … ROLLBACK` verification recipe (Principle 5)
- Supabase logs and advisors (read endpoints)

**Tier 1 rules:** never select from `vault.decrypted_secrets` (secret *names*
via `vault.secrets` are fine); any statement that is not a plain SELECT must
live inside one `BEGIN; … ROLLBACK;` execution.

### Tier 2 — Reversible prod writes with verified preconditions

Requires a **fresh green `npm run guard:preflight`** — the marker file
`.claude/scratch/guard-preflight-passed` must exist and be **less than 30
minutes old** when you start the card.

- Applying the 9 pending migrations, **one at a time**, in timestamp order,
  with a verification query after **each** one (cards LP-03 … LP-05)
- Deploy-gated *read-proof* tests scoped to `TEST_ORG_ID`: tenant isolation,
  BAS lodgement pack, BAS PDF (card LP-09)
- Signed-in browser proof where every write stays inside the test org
  (card LP-11) — under the rules of `docs/BROWSER_AUTOMATION_RUNBOOK.md`
- Uploading the queued PDF statements and completing Triage through the
  product UI (card LP-12) — the app's own human-review flow is the guard rail

### Tier 3 — Recorded sign-off BEFORE executing

The owner (Daniel) writes a sign-off line into the ledger first. No sign-off
line, no command.

- Providing or rotating any secret (`SUPABASE_DB_PASSWORD`,
  `SUPABASE_SERVICE_ROLE_KEY`, `TEST_USER_JWT`) — cards LP-01, LP-07
- Deploying edge functions (via the Supabase MCP deploy path, this project's
  convention — not the CLI) — card LP-08
- Creating, changing, or activating any cron job
- The payroll-termination and super-batch-send deploy-gated tests (they write
  payroll tables) — card LP-10
- Connecting external providers: Xero OAuth, Basiq bank feed, Gmail Pub/Sub —
  card LP-13

### Tier X — Never

These are walls, not gates. No sign-off unlocks them. Some are mechanically
blocked by a `.claude/settings.local.json` hook; all are forbidden regardless.

- ATO / SBR / DSP lodgement, STP transmit, "true and correct" declarations
- ABA file release, super payment send, any movement of real money
- `supabase db reset --linked` (wipes the linked prod database)
- `DROP TABLE` / `DROP SCHEMA` against prod
- Disabling or bypassing RLS on any table
- `git push --force`
- Pausing, restoring, or deleting the Supabase project
- Printing, echoing, or pasting a secret value anywhere outside `.env.local`

## Issue → Tier Map

Every open item from `docs/proof-run-2026-07-02.md` ("Blocked Or Still
Unproven" + "Next Proof Stage"), mapped to its card and tier:

| Open issue (proof-run) | Card | Tier | Owner |
|---|---|---|---|
| `SUPABASE_DB_PASSWORD` present but invalid | LP-01 | 3 | User |
| `supabase migration list --linked` fails / migration state unknown | LP-02 | 1 | Junior |
| 9 pending migrations (`20260701070000` … `20260702130000`) not live | LP-03/04/05 | 2 | Junior |
| Post-apply DB/cron/vault verification (checklist Stage 5) | LP-06 | 1 | Junior |
| `SUPABASE_SERVICE_ROLE_KEY`, `TEST_USER_JWT`, `TEST_ORG_ID`, fixture IDs absent | LP-07 | 3 | User |
| Edge-function deploys (checklist Stage 4 list) | LP-08 | 3 | Sign-off |
| Deploy-gated tests: tenant isolation, BAS pack, BAS PDF (currently skipped) | LP-09 | 2 | Junior |
| Deploy-gated tests: payroll termination, super batch send | LP-10 | 3 | Sign-off |
| Signed-in browser/product proof (create/edit/archive, mobile screenshots) | LP-11 | 2 | Junior |
| 7 queued PDF statements not uploaded; 399 staged entities pending Triage | LP-12 | 2 | User-driven |
| External provider proof: Xero OAuth, Basiq feed, Gmail Pub/Sub trace | LP-13 | 3 | Joint |
| Docs/estimate closeout (checklist Stage 7) | LP-14 | 0 | Junior |
| `supabase status` local container absent | — | n/a | Not needed; all proof runs against the linked remote |

## Escalation

Escalate (stop work, record in ledger, tell the owner) when:

- Any "STOP and escalate if" branch on a card fires.
- A command's output does not match the card's "Expected output" (Principle 3).
- A migration fails **mid-file** — never hand-patch prod to "finish" a half-
  applied migration. Capture the error; the fix is a decision, not a reflex.
- You believe you need an action from a higher tier than the card declares.
- Anything asks you for a secret value outside `.env.local`.

Escalation is the system working, not a failure. A blocked card with a clean
error capture is a **successfully executed** card.

## Secrets hygiene checklist

- [ ] Secrets are typed only into `.env.local`, directly in an editor.
- [ ] Never `echo`/`Write-Output` a secret; never pass one as a CLI argument
      (arguments land in shell history).
- [ ] Never commit `.env.local` (it is gitignored — leave it that way).
- [ ] `npm run guard:preflight` runs a leak tripwire over git-tracked files;
      if it reports a leak, stop everything and escalate immediately.
- [ ] Logs saved to `tmp/` are fine — `tmp/` is gitignored and the tooling
      redacts known secret shapes — but skim before sharing any log.

## Enforcement that exists (and what deliberately does not)

Built:

- `npm run guard:preflight` — go/no-go gate; writes
  `.claude/scratch/guard-preflight-passed` only when green. Tier 2 cards
  require the marker fresh (< 30 min).
- A `PreToolUse` deny hook in `.claude/settings.local.json` blocking
  catastrophic shell commands (`db reset --linked`, `git push --force`,
  `drop table/schema`, project delete).
- `permissions.deny` on destructive Supabase MCP tools (pause/restore
  project, create project, delete branch).

Deliberately skipped (so you don't go looking for them):

- Full command allowlisting — brittle, and it fights the ledger `work` skill.
- A custom SQL proxy — the `BEGIN … ROLLBACK` recipe covers safe prod SQL.
- Commit-gate hook changes — the existing `check-passed` marker convention
  already covers commits.
- Secret-vault tooling — `.env.local` + the never-echo rule is sufficient at
  this team size.
- CI changes — this is an operator runbook, not a pipeline.

## Card template (how to read a runbook card)

```
### LP-NN — Title
Tier: N | Depends on: LP-xx | Owner: junior / user / joint
Goal: one sentence
Sign-off: (Tier 3 only) name + date, recorded in the ledger BEFORE any command
Pre-flight: checkboxes you tick before the first command
Commands: exact copy-paste PowerShell block
Expected output: literal strings / exit codes to compare against
STOP and escalate if: the explicit failure branches
Rollback: how to undo, or "none — read-only"
Done-evidence: what to save and which ledger line to flip
```

## Out of scope (appendix — do not card these)

Deferred business decisions, listed only so you know they are *intentionally*
not in the runbook: STP Phase 2 + SuperStream, Balance Sheet (needs GL
foundation), Annual Tax Summary, Audit-log RBAC hardening, red-node cron
activation beyond what LP-08 deploys, and everything behind the permanent
legal walls (ATO lodgement, money movement — Tier X forever).

`AUTOPILOT_PLAN.md` also lists adjacent developer tasks not sourced from
`docs/proof-run-2026-07-02.md` and therefore not carded here: OCR reliability
live-sample proof, historical OCR backfill, and the live GST-coverage target
check ahead of BAS readiness. These are real, executable work — just outside
this runbook's scope (the 2026-07-02 proof-run blockers). If the owner wants
them carded, they get their own LP-15+ following this same tier model.
