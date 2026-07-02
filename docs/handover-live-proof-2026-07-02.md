# Handover — Live-Proof Push (Guard-Rail Edition), 2026-07-02

Read this first when resuming. It's a pointer, not a duplicate — the ledger
has the full slice-by-slice record.

## Start here

1. Read `docs/guardrails-live-proof-2026-07.md` (tier model) and
   `docs/runbook-live-proof-2026-07.md` (task cards LP-00..LP-14) if this is
   a fresh context.
2. Read `.claude/scratch/ledger.md` for the exact current status of every
   slice, with evidence file references. **This is the source of truth for
   "what's done."**
3. Run `node scripts/with-env-local.mjs -- node scripts/guard-preflight.mjs`
   to get a live read of current state before doing anything else — env
   vars may have gone stale since this note was written (see below).

## Where things stand

**Done (LP-00 through LP-07):** all 9 checklist migrations are live on prod
(`dxoikltymmknxqpkpyhi`); DB password, service-role key, test user JWT, and
`TEST_ORG_ID` are all loaded; `guard:preflight` reported `ok: true` as of
LP-07 completion.

**LP-09 partially done (2/3):** `tenant-isolation` (THE deploy-blocker gate)
passes 6/6 for real. `bas-worksheet-pdf` passes 2/2. `bas-lodgement-pack` is
deferred — its edge function is on the LP-08 redeploy list, not yet run.

**Not started:** LP-08 (edge-function deploys, Tier 3, needs your sign-off
on scope — see "Open decision" below), LP-10 (payroll/super tests, Tier 3),
LP-11 (signed-in browser proof), LP-12 (PDF uploads + Triage), LP-13
(external provider proof), LP-14 (docs closeout).

## ⚠️ Likely stale by the time you resume

- **`TEST_USER_JWT`** — Supabase access tokens expire in ~1 hour. If it's
  been longer than that since it was set, re-run the browser-console
  extraction (documented in `docs/runbook-live-proof-2026-07.md` LP-01's
  gotcha block has the pattern; the actual script was given inline in chat,
  not saved to a file — ask for it again if needed, or: sign into the app,
  devtools console, read `localStorage['sb-dxoikltymmknxqpkpyhi-auth-token'].access_token`).
- **`.claude/scratch/guard-preflight-passed` marker** — 30-minute freshness
  window; just re-run `guard:preflight` regardless, it's cheap.

## Open decision — LP-08 scope

Was mid-discussion when this session ended. LP-08 deploys 12 edge functions
(`accountant-orchestrator`, `advisor`, `ato-lodge`, `automation-watchdog`,
`automation-worker`, `bank-sync`, `bank-transaction-classifier`,
`bas-lodgement-pack`, `gmail-classify-ai`, `ingest`, `intake-routing-apply`,
`payroll-export-stp`, `payroll-finalise-pay-run`). Several are already live
and cron-triggered right now, so a bad redeploy could silently break a
running background job rather than fail loudly. Options that were on the
table: deploy all 12, or scope down to just `bas-lodgement-pack` (the one
actually blocking LP-09's third test). Needs your call before it starts —
Tier 3, sign-off required, record it in the ledger under LP-08 before
executing (same pattern as LP-01 and LP-05's exception).

## Real bugs found and fixed this session (all documented in place, not just here)

- **`.env.local` gotchas** (all in the runbook's LP-01 block): a stale
  Windows User-level env var silently shadowed `.env.local` until
  `guard-preflight.mjs`'s `loadEnv()` was fixed to always prefer the file; a
  wrong key name (`DB_PW` vs `SUPABASE_DB_PASSWORD`); a duplicate key
  definition where the last line silently wins.
- **`apply_migration` mints its own timestamp**, not the local file's —
  `schema_migrations` must be checked by `name`, never by the local
  filename's version string (documented in the runbook's per-migration
  protocol).
- **`BEGIN…ROLLBACK` dry-runs don't reliably roll back** migration content
  containing dollar-quoted (`$$...$$`) function/DO bodies via the Supabase
  MCP `execute_sql` tool — confirmed empirically, replaced with manual
  code-safety (idempotency) review for all Tier 2 migration work.
  `period_lock_money_tables` landed live via this exact failure mode before
  being caught; it was idempotent so no harm, but it's why the process
  changed.
- **`tests/tenant-isolation.test.ts`** had two silent pre-existing fixture
  bugs (invalid `bills.source` enum value; missing `accepted_at` on the
  membership insert, so `get_accessible_org_ids()` correctly treated it as a
  pending invite). Both fixed and committed — see commit `064007d`.
- **`scripts/with-env-local.mjs`** couldn't invoke `npm`/`npx` on Windows
  (`.cmd` wrapper resolution) — fixed with a native-binary-first,
  `cmd.exe`-fallback-with-manual-quoting approach rather than `shell: true`
  (which would've reintroduced a real arg-injection pattern, flagged by
  Node's own `DEP0190` warning).

## Git state

3 commits made this session, cleanly isolated from ~201 other pre-existing
uncommitted files on this branch (the foundation-hardening epic — untouched,
not part of this work):
```
627d2e4 fix(guardrails): un-bundle an unrelated pending script line from the prior commit
064007d fix(tests): correct tenant-isolation seed fixture drift
21a6d76 feat(guardrails): add tier-model docs + preflight gate for live-proof push
```
Nothing pushed. `.claude/scratch/` and `.claude/settings.local.json` are
gitignored — the ledger and the PreToolUse deny-hook/permissions.deny
additions exist only locally, not in git history. If this machine/worktree
changes, those need to be recreated or copied manually — they are NOT
recoverable from git.

**Note on committing more of this branch's other ~201 files later:** if you
ever need to commit a file that has BOTH your intended change AND some
other unrelated pending edit mixed into the same diff, do not use
`git commit -m "..." -- <pathspec>` to isolate it — that re-snapshots the
index from the working tree for those paths, discarding any careful partial
`git apply --cached` staging you did first (this bit me once this session,
fixed in `627d2e4`). Stage precisely what you want with `git apply --cached`
against a hand-built patch, verify with `git diff --cached`, then commit
with **no pathspec** (`git commit -m "..."` alone) so it commits exactly the
index state you built, nothing more.

## Env vars currently in `.env.local` (names only)

```
SUPABASE_DB_PASSWORD, SUPABASE_SERVICE_ROLE_KEY, TEST_ORG_ID, TEST_USER_JWT
VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_SUPABASE_PROJECT_REF
(+ unrelated pre-existing keys: XERO_*, OCR provider keys, ENCRYPTION_KEY, etc.)
```
Still missing: `TEST_BAS_LODGEMENT_ID` (create by calling
`prepare_bas_lodgement_draft` once signed in — no lodgement exists yet),
`TEST_SUPER_BATCH_ID` (no super-batch exists yet either; the creation path
hasn't been traced).

## Key facts worth remembering

- Live project ref: `dxoikltymmknxqpkpyhi`. Exactly one real organization
  exists: "Affordable Fencing Gold Coast",
  `9d5c9b9a-a576-458d-913a-fa822d33320d`. You (`danielsivyer4567@gmail.com`)
  are its sole member, role `owner`.
- 22 remote-only migration versions (`0220`–`0236` + several June/July
  timestamps) still have no matching local file — general out-of-band
  drift, documented but not individually investigated. Full detail in
  `tmp/lp-02-db-state.md` (gitignored, local only — re-derive from the
  ledger's LP-02 entry if that file is gone).
- 11 out-of-checklist pending migrations exist (bucket 4 in LP-02) needing
  an owner scope decision — not urgent, not blocking anything currently
  planned.
