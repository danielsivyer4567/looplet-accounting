# Handover — commit split before IDE reset (2026-07-02)

The IDE/Claw desktop is being reset; anything uncommitted will be wiped. Two
efforts shared this worktree (`fix/foundation-hardening`). This commit contains
ONLY the **completion-audit / product-polish effort**. The **foundation-hardening
chat's changes are deliberately left uncommitted** for that chat to commit
itself.

## What THIS commit contains (audit/product effort)

- `docs/COMPLETION_AUDIT.md`, `docs/proof-run-2026-07-02.md`,
  `docs/remaining-work-todo.md`, `docs/live-supabase-production-audit-2026-07-02.md`,
  `docs/live-apply-checklist-2026-07-02.md`, `docs/live-pending-migrations-2026-07-02.sql`
- All `src/pages/**`, `src/components/**`, `src/hooks/**`, `src/index.css`,
  `src/App.tsx` UI changes: skeleton loading states, categorized
  `formatLoadError`/`formatActionError` error copy, table-to-card mobile layouts
  (bills/suppliers/customers/jobs/invoices/BAS/cash-flow/quality/debts/
  employees + settings/onboarding/auth), archive/restore wiring, create flows,
  pagination, Basiq callback failed-vs-timeout fix, false-empty-on-error fixes
  (onboarding, bank connect, debts, employees, jobs P&L)
- `src/lib/errorMessages.ts` (new shared error classifier) — NOTE: this is the
  ONLY `src/lib` file in this commit
- All `src/test/**` suites + root `tests/*.test.ts` contract suites created by
  the audit stages
- Audit-stage migrations `supabase/migrations/20260702*.sql` (repo-only, NOT yet
  applied live — see `docs/live-apply-checklist-2026-07-02.md`)
- `scripts/live-supabase-readiness.mjs`

Final state: historical scorecard has ZERO remaining warning cells; full suite
439 passed / 0 failed / 121 live-gated skips; typecheck+lint clean. Estimate
held at ~85% (remaining = live/signed-in/provider proof).

## What is LEFT UNCOMMITTED for the foundation-hardening chat

⚠️ These will be WIPED by the reset unless that chat commits first:

- `src/lib/automationJobs.ts` (modified)
- ALL `supabase/functions/**` (modified + untracked: _shared/*, ocr, orchestrator
  dispatch, xero adapter/idempotency, bank-sync, automation-worker/watchdog,
  ingest handlers, ato-lodge, bas-lodgement-pack/, _shared/onboarding/, etc.)
- `supabase/config.toml`, `deno.lock`, `package.json`, `.gitignore`
- `AUTOPILOT_PLAN.md`, `docs/automation-spine.html`, `docs/connector-guide.md`,
  `docs/general-ledger.md`, `docs/openapi.yaml`,
  `examples/wrap-up-local-visual-smoke.mjs`

NOTE: `package.json` is uncommitted, so the `supabase:readiness` script entry
that points at the committed `scripts/live-supabase-readiness.mjs` rides with
the other chat's commit (the script runs standalone via
`node scripts/live-supabase-readiness.mjs` regardless).

## Known caveats

- This commit may not build/test 100% standalone because some root `tests/`
  contract suites exercise `supabase/functions/**` files that ride with the
  other chat's commit. The working tree (both commits together) is fully green.
- `tmp/` evidence logs/screenshots are gitignored and WILL be wiped. Every log
  is regenerable by re-running the vitest suite named next to it in
  `docs/proof-run-2026-07-02.md`; the Auth-mobile Playwright screenshots
  (`tmp/auth-*.png`) need a re-capture at 390x844 if wanted again.

## Picking the audit effort back up

1. Read `docs/proof-run-2026-07-02.md` (bottom stage notes) +
   `docs/remaining-work-todo.md`.
2. The scorecard queue is DONE. Next work is the live tracks: Stage 7 live
   Supabase activation (needs valid `SUPABASE_DB_PASSWORD`,
   `SUPABASE_SERVICE_ROLE_KEY`, `TEST_USER_JWT`, `TEST_ORG_ID`), signed-in
   browser proof, and the P3 provider decisions (Basiq real feed, Xero
   stub-vs-live).
3. Keep the estimate at ~85% until live proof actually lands.
