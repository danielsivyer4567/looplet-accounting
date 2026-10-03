# DEPLOY_PROOF_P0-05 — Accountant portal + tag-drop deploy runbook & live overlay proof

> **Status: production Pages deployed and signed-in P0-05 proof complete.** On
> 2026-06-30, `0199`-`0207` were applied to live through
> `supabase db query --linked`, matching migration-history rows were recorded,
> and `team-invite` was redeployed. The current frontend was then deployed to
> Cloudflare Pages production deployment
> `933983a7-9d03-47e7-8be4-e33ef0f9b21a` from source `0e9dd07`, and a signed-in
> proof on `https://looplet-accounting.pages.dev` proved the accountant/tag
> overlay flow end to end with clean console/page-error/failed-response captures.
> The only remaining finish-line tracker TODOs are the externally gated ATO
> lodgement items.
>
> **Target project:** `dxoikltymmknxqpkpyhi` ("looplet accounting") — the live
> production project. ALWAYS pass `--project-ref dxoikltymmknxqpkpyhi` so a CLI
> deploy can never land on a sibling project (the user has previously had
> `auto-reconcile` deploy to the wrong project — see memory
> `supabase-project-refs`). The frontend ships separately via Cloudflare Pages;
> production UI proof must use the canonical Pages origin after a current build
> is deployed.

---

## 2026-06-30 live evidence collected

- Preflight proved `organizations`, `organization_memberships`,
  `team_invitations`, `jobs`, `audit_log`, `get_accessible_org_ids()`,
  `set_updated_at()`, and `notify(...)` existed before apply.
- Before apply, `accept_pending_invites()` and all six tag tables were absent.
- Applied `0199_accountant_portal.sql` through `0207_money_audit_triggers.sql`
  one file at a time via `supabase db query --linked`.
- `0202_fk_indexes.sql` initially failed because live no longer has the legacy
  `customer_invoices` table; the migration is now guarded for that consolidated
  schema and was re-applied successfully.
- Recorded `supabase_migrations.schema_migrations` rows for `0199`-`0207` with
  `created_by='codex-live-p0-05-20260630'`.
- Post-apply SQL proved all six tag tables exist and have RLS enabled:
  `tags`, `tag_staff`, `tag_attachments`, `tag_replies`, `tag_rate_limits`,
  `tag_drafts`.
- Post-apply SQL proved the expected tag and invite RPCs are present and
  `SECURITY DEFINER`: `accept_pending_invites`, `check_tag_rate_limit`,
  `create_tag_with_rate_limit`, `dispatch_tag_notification`,
  `get_taggable_staff`.
- Post-apply SQL proved `tag-attachments` storage bucket exists and is private,
  tag policies are present, `tag_drafts_user_org_page_uniq` exists,
  `get_accessible_org_ids()` references `accepted_at`, the `connector` role is
  `NOLOGIN`/`NOINHERIT`, `trg_journal_entries_audit_v2` exists, and
  `trigger_dispatch_tag_notification` exists.
- `deno check supabase/functions/team-invite/index.ts` passed.
- `supabase functions deploy team-invite --use-api --project-ref
dxoikltymmknxqpkpyhi` deployed `team-invite` v37.
- Unauthenticated POST to
  `https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/team-invite` returned
  `401 {"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}`.
- Rolled-back SQL proof `p0-05-accept-pending-proof.sql` returned
  `rolled_back_accept_pending_invites_pass`.
- Rolled-back SQL proof `p0-05-tag-rpc-proof.sql` returned
  `rolled_back_create_tag_with_rate_limit_pass`.

### 2026-06-30 signed-in UI proof

- Current frontend build passed `npm run build`, then deployed with:
  `npx wrangler pages deploy dist --project-name looplet-accounting --branch main --commit-hash 0e9dd074a245ee00c1969cdf88bf60fb43b895c7`.
- Cloudflare Pages reported production deployment
  `933983a7-9d03-47e7-8be4-e33ef0f9b21a` at
  `https://933983a7.looplet-accounting.pages.dev`, source `0e9dd07`, branch
  `main`.
- Canonical production origin `https://looplet-accounting.pages.dev` returned
  HTTP `200` with CSP, HSTS, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, and
  `permissions-policy: camera=(), microphone=(), geolocation=()` headers.
- Disposable smoke users/org were created through the supported Supabase Admin
  API, not manual auth-table inserts.
- Production `/bills` exposed the tag-drop toggle
  (`productionTagToggleCount: 1`).
- Accountant production proof created live tag
  `766bbf7a-f9d6-4b1c-8e73-4aa45ef0f868` from `/bills` through
  `create_tag_with_rate_limit`; the RPC returned `200` with
  `{"success":true}` and the tag row was verified server-side.
- Member production proof created notification
  `4d829475-7d7b-422e-99af-4860abf96494` with `category='mention'`,
  `resource_type='tag'`, and
  `/bills?tag=766bbf7a-f9d6-4b1c-8e73-4aa45ef0f868`.
- The mentioned member saw the mention in the bell and on `/notifications`.
  Clicking `View tag` navigated to
  `/bills?tag=766bbf7a-f9d6-4b1c-8e73-4aa45ef0f868`, rendered the projected
  overlay, and pressing Escape closed it.
- Cross-tenant negative check created synthetic foreign tag
  `486241e9-7a41-4c0a-b3d5-f0dd6b23b68f`; opening
  `/bills?tag=486241e9-7a41-4c0a-b3d5-f0dd6b23b68f` as the smoke member returned
  `200 []` from the `tags` select and rendered no tag card.
- Browser console, page-error, and failed-response captures were empty for both
  accountant and member proof sessions.
- Smoke data cleanup was verified after screenshots/network captures: remaining
  smoke orgs/users/tags/notifications all returned `0`.
- Screenshot artifacts captured under `.claude/scratch/`:
  `p0-05-prod-accountant-tag-popup.png`,
  `p0-05-prod-accountant-tag-saved.png`,
  `p0-05-prod-member-bell.png`,
  `p0-05-prod-member-notifications.png`,
  `p0-05-prod-member-deep-link.png`,
  `p0-05-prod-member-overlay-closed.png`, and
  `p0-05-prod-member-foreign-tag-negative.png`.

---

## 0. Scope & migration inventory

This slice ships the accountant-portal accept-invite RPC, the tag-drop schema +
data-plane functions, and the finish-line Wave A/B hardening migrations, then
redeploys the `team-invite` edge function. The broader local migration
ceiling is now `20261003190000_payg_tables_2025_26.sql`; use
`docs/MIGRATION_BASELINE_RUNBOOK.md` for full-release baseline proof before any
production migration apply.

**Migrations covered (all present in `supabase/migrations/`):**

| Wave | File                                  | What it lands                                                                                                                                                |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| core | `0199_accountant_portal.sql`          | `accept_pending_invites()` RPC (new-invitee membership + accept gate)                                                                                        |
| core | `0200_tag_drop.sql`                   | `tags`/`tag_staff`/`tag_attachments`/`tag_replies`/`tag_rate_limits`/`tag_drafts` tables + RLS + `tag-attachments` storage bucket + `check_tag_rate_limit()` |
| core | `0201_tag_functions.sql`              | `get_taggable_staff()`, `create_tag_with_rate_limit()`, `dispatch_tag_notification()` trigger on `tag_staff`                                                 |
| A    | `0202_fk_indexes.sql`                 | FK-covering indexes (incl. `tags.approved_by`, `tag_drafts.organization_id/job_id`)                                                                          |
| A    | `0203_accepted_membership_access.sql` | `get_accessible_org_ids()` only grants access when `accepted_at IS NOT NULL`                                                                                 |
| A    | `0204_tag_draft_contract.sql`         | UNIQUE arbiter on `tag_drafts(user_id, organization_id, page_url)` (`NULLS NOT DISTINCT`)                                                                    |
| B    | `0205_connector_hardening.sql`        | dedicated read-only `connector` Postgres role for gateway-minted JWTs                                                                                        |
| B    | `0206_definer_notify_hardening.sql`   | `notify()` interactive-caller org guard + DEFINER EXECUTE grant tightening                                                                                   |
| B    | `0207_money_audit_triggers.sql`       | audit trigger on every money table (closes `journal_entries` gap)                                                                                            |

> **Scope note:** P0-05 live overlay proof covers the accountant/tag deployment
> batch (`0199`-`0207`) only. Later migrations (`0208`-`0236`) and timestamped
> 2026-07-02 hardening repairs are covered by the full finish-line migration
> baseline runbook and their own slice evidence.

> **Dependency notes (why the order matters):**
>
> - `0201` references objects created in `0200` (`tags`, `tag_staff`,
>   `tag_rate_limits`) and the `audit_log` + `notify()` from earlier migrations.
> - `0202` indexes `tags`/`tag_drafts` (created in `0200`) and `tags.approved_by`.
> - `0204` adds the unique arbiter the tag-draft upsert needs; it depends on
>   `tag_drafts` (`0200`).
> - `0203` redefines `get_accessible_org_ids()` — the helper that `0200`/`0201`
>   RLS + functions call — so it must land before the tag tables are exercised by
>   real users, but is functionally independent of the tag DDL.
> - `0206`/`0207` are independent hardening and can land anytime after their
>   target objects exist; deploy in numeric order for simplicity.

---

## 1. Deploy order & method (migration-baseline-repair caveat)

### CRITICAL: do NOT run a broad `supabase db push`

The live `dxoikltymmknxqpkpyhi` schema was applied **out-of-band**, not through
tracked migrations (memory `migration-history-drift`):

- `supabase_migrations.schema_migrations` on prod does NOT mirror the repo chain.
  Recent migs are recorded under **timestamp** versions (e.g. `20260626125641`
  named `0090_books_health`), not bare `0090`. The recorded head is the timestamp
  era, while the repo files now run through `0230`.
- A plain `supabase db push` would diff the repo chain against that drifted
  history and try to (re)apply a large, unpredictable set of files — including
  migrations whose effects are already live — risking spurious failures or
  re-running DDL out of context.

**Therefore: do not use this P0-05 runbook as permission for a broad production
`db push`.** First run the baseline workflow in
`docs/MIGRATION_BASELINE_RUNBOOK.md`. If the baseline is still drifted, apply
each of the 9 P0-05 files explicitly and individually, in the order in the table
above, NOT via `db push`. Every file in this batch is written to be idempotent
and prod-safe (enums guarded by `DO`/`duplicate_object`, tables `IF NOT EXISTS`,
policies `DROP ... IF EXISTS` + `CREATE`, functions `CREATE OR REPLACE`,
triggers `DROP TRIGGER IF EXISTS` + `CREATE`, indexes `IF NOT EXISTS`, bucket
`ON CONFLICT DO NOTHING`, tables guarded with `to_regclass()`), so re-asserting
over a drifted live history is safe after the object prereqs are verified.

### Pre-flight (confirm live schema before touching it)

Branches come up empty for this project, so verify the live schema directly
(memory `migration-history-drift`). Run via the Supabase SQL editor or a
service-role `execute_sql`:

```sql
-- Prereqs the batch depends on must already exist on prod.
SELECT
  to_regclass('public.organizations')            AS organizations,
  to_regclass('public.organization_memberships') AS memberships,
  to_regclass('public.team_invitations')         AS team_invitations,
  to_regclass('public.jobs')                      AS jobs,
  to_regclass('public.audit_log')                 AS audit_log,
  to_regprocedure('public.get_accessible_org_ids()') AS get_accessible_org_ids,
  to_regprocedure('public.set_updated_at()')      AS set_updated_at,
  to_regprocedure(
    'public.notify(uuid,text,text,text,text,text,uuid,text,uuid,jsonb)'
  )                                               AS notify_fn;
-- Every column must be NON-NULL. If any is NULL, STOP — an earlier migration
-- this batch depends on is not actually live; resolve that first.

-- Confirm organization_memberships.accepted_at exists (0203 gate depends on it).
SELECT column_name
FROM information_schema.columns
WHERE table_schema='public' AND table_name='organization_memberships'
  AND column_name='accepted_at';   -- must return one row
```

### Apply order

Apply these in sequence; each is one transactional file (they each `BEGIN; ... COMMIT;`):

```
0199_accountant_portal.sql
0200_tag_drop.sql
0201_tag_functions.sql
0202_fk_indexes.sql
0203_accepted_membership_access.sql
0204_tag_draft_contract.sql
0205_connector_hardening.sql
0206_definer_notify_hardening.sql
0207_money_audit_triggers.sql
```

**Recommended method when the full-release dry run is not clean (per file,
idempotent, no `db push`):** paste each file's contents into the Supabase SQL
editor for `dxoikltymmknxqpkpyhi`, or apply via a service-role `execute_sql`
call, one file at a time, stopping on first error.

> **`0205` index-build caveat:** `0205` creates the `connector` role and grants;
> it runs inside its own `BEGIN/COMMIT`. The `0202` index sweep uses
> `CREATE INDEX IF NOT EXISTS` (NOT `CONCURRENTLY`), so it runs fine inside the
> file's transaction but takes a brief lock on the hot tables — apply during a
> low-traffic window if `bills`/`customer_invoices`/`bank_transactions` are large.

> **`0203` blast-radius note:** `0203` narrows `get_accessible_org_ids()` to
> accepted memberships only. Any user currently relying on a _pending_
> (`accepted_at IS NULL`) membership for access will lose it until they accept.
> `0039` backfilled all pre-existing memberships with
> `accepted_at = joined_at`, so only genuinely un-accepted invites are affected —
> this is the intended security fix, but call it out in the change ticket.

### Optionally record the applied versions

If you want the live `supabase_migrations` ledger to note these (matching the
existing timestamp-version convention rather than bare numbers), insert a
recorded row per file AFTER it applies cleanly — but this is bookkeeping only and
does not change behaviour. Do NOT let a missing ledger row trigger a
`db push` re-apply.

### Redeploy `team-invite`

`0199` (`accept_pending_invites()`) is the DB half of the new-invitee fix; the
`team-invite` edge function is the invite half and must be redeployed so the
deployed copy matches the repo (it inserts the pending `organization_memberships`
row with `accepted_at = NULL` that `accept_pending_invites()` later flips).

Only redeploy after `0199` has applied or live `accept_pending_invites()` has
been proven present. The CLI is logged-in + linked (memory
`edge-fn-deploy-method`):

```bash
supabase functions deploy team-invite --use-api --project-ref dxoikltymmknxqpkpyhi
```

- `--use-api` bundles server-side (no Docker) and resolves `../_shared/cors.ts`
  natively — the deno.json/import-map/nested-path workarounds are NOT needed.
- `team-invite` is absent from `config.toml [functions.*]`, so it defaults to
  `verify_jwt = true` — preserve that (it requires a signed-in caller).

---

## 2. Post-deploy SQL proof (tables / RLS / RPCs + team-invite)

Run as service-role against `dxoikltymmknxqpkpyhi` AFTER all 9 files apply. Each
block states the PASS condition.

### 2.1 Tag tables exist

```sql
SELECT tablename
FROM pg_tables
WHERE schemaname='public'
  AND tablename IN ('tags','tag_staff','tag_attachments',
                    'tag_replies','tag_rate_limits','tag_drafts')
ORDER BY tablename;
-- PASS: exactly 6 rows.
```

### 2.2 RLS enabled on every tag table

```sql
SELECT relname, relrowsecurity
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('tags','tag_staff','tag_attachments',
                  'tag_replies','tag_rate_limits','tag_drafts');
-- PASS: relrowsecurity = true for all 6.
```

### 2.3 Tag RLS policies present (org-scoped via get_accessible_org_ids)

```sql
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname='public'
  AND tablename IN ('tags','tag_staff','tag_attachments',
                    'tag_replies','tag_rate_limits','tag_drafts')
ORDER BY tablename, policyname;
-- PASS includes (non-exhaustive): tags_select / tags_insert / tags_update_own /
--   tags_delete_own; tag_staff_select_own / tag_staff_creator_manage;
--   tag_replies_select/insert/update_own/delete_own; tag_drafts_manage_own;
--   tag_rate_limits_select_own/insert_own; tag_attachments_select/_creator_manage.

-- Spot-check that the SELECT policy is org-scoped (not USING(true)):
SELECT pg_get_expr(polqual, polrelid) AS using_expr
FROM pg_policy
WHERE polrelid='public.tags'::regclass AND polname='tags_select';
-- PASS: expression references get_accessible_org_ids() and deleted_at IS NULL.
```

### 2.4 Tag storage bucket + object RLS

```sql
SELECT id, public FROM storage.buckets WHERE id='tag-attachments';
-- PASS: one row, public = false.

SELECT policyname, cmd
FROM pg_policies
WHERE schemaname='storage' AND tablename='objects'
  AND policyname LIKE 'tag_attachments_bucket_%';
-- PASS: tag_attachments_bucket_select / _insert / _update present.
```

### 2.5 Tag RPCs / trigger exist with the expected signatures + grants

```sql
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef                               AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public'
  AND p.proname IN ('get_taggable_staff','create_tag_with_rate_limit',
                    'check_tag_rate_limit','dispatch_tag_notification',
                    'accept_pending_invites')
ORDER BY p.proname;
-- PASS: all 5 present, prosecdef = true (all are SECURITY DEFINER).

-- DEFINER write/read fns must NOT be anon/public-callable (definer-fn-grant-gotcha):
SELECT routine_name, grantee, privilege_type
FROM information_schema.routine_privileges
WHERE specific_schema='public'
  AND routine_name IN ('get_taggable_staff','create_tag_with_rate_limit',
                       'check_tag_rate_limit','accept_pending_invites')
ORDER BY routine_name, grantee;
-- PASS: grantee 'anon' and 'PUBLIC' absent for all four; 'authenticated' present.
--   (service_role present for the tag fns; accept_pending_invites is
--    authenticated-only by design.)

-- Notify trigger wired onto tag_staff:
SELECT tgname FROM pg_trigger
WHERE tgrelid='public.tag_staff'::regclass
  AND tgname='trigger_dispatch_tag_notification';
-- PASS: one row.
```

### 2.6 Wave A/B invariants

```sql
-- 0203: accepted-only access gate is live.
SELECT pg_get_functiondef('public.get_accessible_org_ids()'::regprocedure) ~* 'accepted_at' AS gate_present;
-- PASS: true.

-- 0204: tag_drafts upsert arbiter (NULLS NOT DISTINCT on PG15+).
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname='public' AND tablename='tag_drafts'
  AND indexdef ILIKE '%UNIQUE%'
  AND indexdef ILIKE '%user_id%' AND indexdef ILIKE '%organization_id%'
  AND indexdef ILIKE '%page_url%';
-- PASS: a UNIQUE index over (user_id, organization_id, page_url) is returned.

-- 0205: read-only connector role.
SELECT rolname, rolcanlogin, rolinherit FROM pg_roles WHERE rolname='connector';
-- PASS: connector exists, rolcanlogin=false, rolinherit=false (NOINHERIT).

-- 0207: journal_entries audit trigger (the gap this batch closed).
SELECT tgname FROM pg_trigger
WHERE tgrelid='public.journal_entries'::regclass AND tgname='trg_journal_entries_audit_v2';
-- PASS: one row.
```

### 2.7 `team-invite` is redeployed (and matches repo)

```bash
# Confirm the function is deployed and its updated_at is recent (post-deploy):
supabase functions list --project-ref dxoikltymmknxqpkpyhi | grep team-invite
```

```bash
# Smoke the redeployed copy WITHOUT a user session: an unauthenticated POST
# must be rejected by verify_jwt (401 — NOT a 404). 404 would mean the deploy
# did not land.
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/team-invite' \
  -H 'Content-Type: application/json' --data '{}'
# PASS: 401 (verify_jwt rejects the missing JWT). FAIL: 404 (not deployed).
```

> Optional rolled-back deeper proof of `accept_pending_invites()` (memory
> `rolled-back-live-test-recipe`): in ONE service-role `execute_sql` call —
> `BEGIN;` seed a throwaway org + a pending `team_invitations` row for a real
> `auth.users` email + that user's pending membership; `SET LOCAL` the JWT claims
> (`request.jwt.claims` with `sub`=that user, `role`=`authenticated`,
> `email`=that email); `SELECT public.accept_pending_invites();`
> then `SELECT accepted_at FROM organization_memberships WHERE ...` (PASS:
> non-null) and `SELECT status FROM team_invitations WHERE ...` (PASS: 'accepted');
> `ROLLBACK;`. Re-confirm in a separate call that the throwaway org is absent.

---

## 3. Live overlay proof (signed-in accountant, real `public.tags`)

This is the human/manual leg — the static SQL above proves the objects exist; this
proves the end-to-end accountant tag-overlay experience works against live data.
Capture screenshots + a refreshed browser console at each step.

### 3.1 Preconditions

- A signed-in **accountant** user (a user with an accepted membership whose
  `role_enum='accountant'` on at least one client org) on the production frontend
  (Cloudflare Pages build off `main`). `get_accessible_org_ids()` returns that
  accountant's client orgs, so they can read/create tags on a client org.
- A second org member to mention (so `dispatch_tag_notification` fires — it skips
  the creator). Confirm via `get_taggable_staff(<client_org_id>)` returning ≥2 users.
- Browser devtools open with **"Preserve log"** on, console cleared.

### 3.2 Create a tag via the overlay (real `public.tags`)

1. Navigate to any page that mounts `TagDropManager` (e.g. `/bills`).
2. Open the tag-drop overlay, drop a pin, add a comment, and tag the second
   member, then save.
3. **Expected:** the save calls `create_tag_with_rate_limit(...)`, which inserts
   into `public.tags` and fans out into `public.tag_staff`. The popup shows the
   created tag; the network tab shows the RPC returning `{ success: true, data:{ id } }`.
4. **Capture:** screenshot of the placed pin + open tag card; the network entry
   for the `create_tag_with_rate_limit` RPC (200, success payload); a **refreshed
   console** with NO errors (no 401/403/42501, no "no unique or exclusion
   constraint" error from the draft upsert path).
5. Confirm server-side it is real data:
   ```sql
   SELECT id, organization_id, creator_id, page_url, comment
   FROM public.tags ORDER BY created_at DESC LIMIT 1;
   -- PASS: the just-created tag, on the client org, creator = the accountant.
   ```

### 3.3 Mention notification appears in the bell + inbox

`dispatch_tag_notification` (AFTER INSERT on `tag_staff`) raises
`notify(category='mention', resource_type='tag', link='<page_url>?tag=<id>')` to
the mentioned user.

1. As the **mentioned** user (second member), reload the app.
2. **Bell:** the `NotificationBell` shows an unread count; the dropdown lists a
   "<accountant> tagged you" mention. `isTagMentionNotification` classifies it as a
   tag mention (category `mention` / resource_type `tag` / `?tag=` in the link).
3. **Inbox:** open `/notifications` (the Notifications page). The mention appears
   under the **Mentions** category filter with the Tag icon.
4. **Capture:** screenshot of the bell dropdown showing the mention, and the
   Notifications page filtered to Mentions showing the same row.
5. Confirm server-side:
   ```sql
   SELECT category, resource_type, link, user_id
   FROM public.notifications
   WHERE resource_type='tag' ORDER BY created_at DESC LIMIT 1;
   -- PASS: category='mention', link ends with '?tag=<id>', user_id = mentioned user.
   -- Also confirm no dropped mention:
   SELECT count(*) FROM public.audit_log WHERE action='TAG_NOTIFY_FAILED';
   -- PASS: 0 new rows for this run.
   ```

### 3.4 Deep link `/<page>?tag=<uuid>` projects the tag overlay

Clicking the notification navigates to its `link`
(`<page_url>?tag=<id>`); `TagDropManager`'s deep-link `useEffect` reads the `tag`
query param, fetches the tag from `public.tags`, resolves the creator via
`get_taggable_staff`, and projects the tag card/overlay at the pin coordinates.

1. From the inbox or bell, click the mention (Notifications page calls
   `navigate(n.link)`).
2. **Expected:** the app lands on the tagged page with `?tag=<uuid>` in the URL;
   the tag's overlay/card renders anchored at the pin. For a bills tag the URL is
   `/bills?tag=<uuid>` (the `bills` route is registered in `App.tsx`).
3. **Manual interaction:** confirm the projected tag shows the original comment;
   open and close the card and confirm the overlay clears back to the normal page.
4. **Capture:** screenshot of `/bills?tag=<uuid>` with the projected overlay
   visible, the address bar showing the deep-link URL, and a **refreshed console**
   with no errors (no failed `tags` select → would indicate RLS denying the
   accountant, i.e. an `0203`/`get_accessible_org_ids` regression).

### 3.5 Cross-tenant negative check (proves RLS, not just happy path)

As the accountant, hit the deep link for a tag id belonging to an org NOT in their
`get_accessible_org_ids()` (e.g. craft `/bills?tag=<foreign-tag-uuid>`).
**PASS:** the overlay does NOT render (the `tags` select returns no row under RLS)
and the page falls back to normal — no foreign-org data leaks into the overlay.

---

## 4. Manual-interaction + evidence checklist

Close the slice only when ALL boxes are ticked and screenshots/console captures
are attached.

- [x] Pre-flight `to_regclass`/`accepted_at` checks all non-NULL (Section 1).
- [x] Full-release migration baseline checked per `docs/MIGRATION_BASELINE_RUNBOOK.md`.
- [x] All 9 P0-05 files applied individually in order, or the full-release
      dry run was clean and applied through the reviewed baseline workflow.
- [x] §2.1 six tag tables exist.
- [x] §2.2 RLS enabled on all six.
- [x] §2.3 expected tag policies present; `tags_select` is org-scoped (not `true`).
- [x] §2.4 `tag-attachments` bucket exists (private) + 3 object policies.
- [x] §2.5 5 RPCs/trigger present, all SECURITY DEFINER, no anon/PUBLIC EXECUTE.
- [x] §2.6 `get_accessible_org_ids()` references `accepted_at`; `tag_drafts` unique
      arbiter present; `connector` role NOLOGIN/NOINHERIT; `journal_entries` audit
      trigger present.
- [x] §2.7 `team-invite` listed as deployed with recent `updated_at`; unauth POST → 401.
- [x] §3.2 tag created via overlay; RPC 200; refreshed console clean; row in `public.tags`.
- [x] §3.3 mention shows in bell dropdown AND Notifications page (Mentions filter);
      notifications row has `category='mention'` + `?tag=` link; 0 `TAG_NOTIFY_FAILED`.
- [x] §3.4 clicking the mention deep-links to `/bills?tag=<uuid>`; overlay projects;
      open/close clears it; refreshed console clean.
- [x] §3.5 foreign-org `?tag=` deep link projects nothing (RLS holds).
- [x] Screenshots attached: placed pin/card, bell dropdown, Notifications/Mentions,
      `/bills?tag=<uuid>` overlay (with URL visible).
- [x] Refreshed-console captures attached for §3.2 and §3.4 (no 401/403/42501).

---

## 5. Rollback / abort

Every file is `BEGIN/COMMIT` and idempotent; if one fails mid-batch, fix the
prereq and re-run that single file (re-running already-applied files is safe). To
back out behaviourally:

- **`0203`** is the only file with user-facing access impact; to revert, restore
  the prior `get_accessible_org_ids()` definition (without the `accepted_at`
  filter) via `CREATE OR REPLACE` — but this re-opens the pending-membership read
  gap, so only do so as an emergency mitigation.
- Tag tables/functions and `0205`/`0206`/`0207` are additive (new objects + grant
  tightening); dropping the tag objects or loosening grants would only be needed
  if a defect is found, and should go through a fresh migration, not an ad-hoc
  `DROP`.

Do NOT attempt to "roll back" by re-pointing `supabase db push` at the drifted
history — that is exactly the hazard Section 1 warns against.
