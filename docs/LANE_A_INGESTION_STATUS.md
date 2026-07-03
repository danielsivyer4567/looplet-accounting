# Lane A — Intake & Ingestion: status & activation handoff

Branch `lane/a-ingestion` (worktree `../looplet-lane-a`), base `d77b428`.
Mandate: wire up the yellow "needs a trigger" nodes (A2, A4, A6) so ingestion is
fully autonomous; harden the green ones (A1, A3, A5). Code + commits only — **no
deploys / db push were performed**; the steps below are yours to apply.

## What shipped

| Commit | Node | Change |
|--------|------|--------|
| `14b53c7` | A5 | Commit the daily `gmail-watch-renew` cron (was only a doc comment). |
| `7d2da36` | A2 | Autonomous 6-hourly catch-up `gmail-backfill` cron (backstops missed Pub/Sub). |
| `1ad7792` | A6 | Daily recent-window `gmail-mine` re-mine cron (keeps triage/deep-profile fresh). |
| `981dc7e` | A4 | Extract `ingest` handlers → `handlers.ts`; tests prove document push → `bill_extract` → B1; document external-trigger contract. |
| `a6f0eb4` | A3 | Block plaintext/SSRF delivery targets in `receipt-sync/genericApi.ts`. |

Gates: `deno check` clean on all touched fns; `deno test` 16/16 green across
`_shared/gmail`, `_shared/receipt-sync`, `ingest`; `git diff --check` clean.
(`deno lint` reports the repo-wide `no-import-prefix` URL-import style — pre-existing,
also fires on untouched edge modules; the project's eslint gate covers `src/`, not
`supabase/functions`.)

## Migrations to apply (timestamp order)

1. `20260701160000_gmail_watch_renew_cron.sql`  — A5
2. `20260701160500_gmail_backfill_catchup_cron.sql` — A2
3. `20260701161000_gmail_mine_refresh_cron.sql` — A6

All three follow the **0197 Vault-guarded pattern**: they are `do $$…$$` blocks that
self-guard on `pg_cron` + `vault.decrypted_secrets` + the scoped secret, and
`RAISE NOTICE` + skip otherwise. **Safe to apply now** — they no-op until the
prerequisites exist, then activate on re-apply.

## Activation prerequisites (per cron)

### A5 — gmail-watch-renew-daily (03:00)
- Deploy: `supabase functions deploy gmail-watch-renew --no-verify-jwt` (already green fn).
- Secret: `supabase secrets set GMAIL_WATCH_RENEW_CRON_SECRET=<random-32-char>`.
- Vault: store the **same** value as vault secret `gmail_watch_renew_cron_secret`.
- Re-apply migration 1. Verify: `SELECT * FROM cron.job WHERE jobname='gmail-watch-renew-daily';`

### A2 — gmail-backfill-catchup (every 6h) & A6 — gmail-mine-refresh (04:30)
Both call frozen fns (`gmail-backfill`, `gmail-mine`) that accept a bearer as their
user JWT; they have **no `?secret=` gate**. The crons therefore send the
**service-role bearer**, read at run time from a Vault secret (never embedded in
`cron.job.command`, per 0197) — exactly how `automation-worker` already calls
`gmail-backfill`.
- Deploy: `gmail-backfill` and `gmail-mine` (if not already deployed).
- Vault: store the project **service-role key** as vault secret `service_role_key`
  (**shared by both A2 and A6 — provision once**).
- Re-apply migrations 2 and 3.

> Security note: injecting the service-role key is the only in-lane way to trigger
> these frozen, user-JWT-only fns. **Preferred follow-up (out of Lane A — belongs to
> the gmail-backfill/gmail-mine owner):** add a scoped `?secret=` cron gate to both
> fns so the crons use a narrow secret instead of the god key. Then swap the header
> for `?secret=` reading a scoped vault secret (mirrors A5).

## Scope boundaries (deliberate, documented — not gaps)

- **A2 is a catch-up backstop, not full history.** It sweeps only mailboxes the
  real-time push isn't keeping fresh (`last_synced_at` stale >6h) over a short recent
  window (`days=3`), and is idempotent via the existing `gmail_message_id` dedup. Deep
  historical import stays frontend/onboarding-driven — a fire-and-forget cron cannot
  carry `gmail-backfill`'s caller-held `page_token` cursor.
- **A6 is a recent-window refresh, not the first-scrape.** Same cursor limitation:
  `gmail-mine` paginates via a caller-held token, so the cron does one recent page
  (`days=14`), idempotent via `staged_entities` upsert-by-`canonical_key`. The full
  6-month first-scrape remains the Auto Setup wizard's job. **Preferred long-term
  wiring (out of Lane A):** add a `gmail_mine` job_kind to `automation-worker` (it
  already dispatches `gmail_backfill` the same way) so mining runs through the queue
  with cursor state + retry.
- **A4 has no cron by design.** `api-gateway → ingest` is an inbound-push endpoint;
  its "trigger" is the external connector calling it. A `document` push creates a
  bill under the pinned org and enqueues exactly one `bill_extract` job — the edge
  that feeds the extraction queue (B1). Proven by `ingest/handlers.test.ts`. A
  scheduled pull-connector / heartbeat was explicitly out of scope.

## Node-status deltas for `docs/automation-spine.html` (main worktree, untracked)

Apply these in the **main** worktree (not here) once the migrations + prereqs above
are live:
- **A2** `yellow → green` (autonomous catch-up cron; deep history remains wizard-driven).
- **A5** `green` (unchanged; cron now committed as a migration, not just a doc comment).
- **A6** `yellow → green` for recent-window autonomy; annotate that full first-scrape
  stays onboarding-driven pending a worker `gmail_mine` job_kind.
- **A4** keep `green`/documented — inbound-push, externally triggered; the A4→B1 edge
  (`dull → alive`) is proven by the document-push test.
- Recommended follow-ups for the owning lanes: scoped `?secret=` gate on
  `gmail-backfill`/`gmail-mine`; `gmail_mine` job_kind in `automation-worker`.
