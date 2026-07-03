# Cron + edge-function secrets (provisioning)

The completion audits found a set of secrets that the cron-driven edge functions
read but that are **not yet set in the live Supabase project**. Until each is
set, the corresponding scheduled job cannot authenticate and the feature stays
inert (or, for the orchestrator, the function refuses to start).

> **All of these are deploy-gated.** They are infrastructure secrets, not repo
> config — they live in the Supabase project's secret store, never in git. The
> migrations that register the crons (`0065`, `0096`, `0099`, `0185`) are
> committed but intentionally **inert** (the `cron.schedule()` call is commented
> out). Enabling each job is a deliberate, separate step: deploy the function,
> set the secret in the live project, then uncomment and run the
> `cron.schedule()` statement once. The placeholders in `.env.example` are for
> local reference only; setting them locally does **not** affect production.

## How to set a secret in the live project

CLI (preferred — run against the live project ref `dxoikltymmknxqpkpyhi`):

```sh
supabase secrets set AUTO_RECONCILE_CRON_SECRET=<random-32-char-string> \
  --project-ref dxoikltymmknxqpkpyhi
```

Generate a value with `openssl rand -hex 16` (or any 32+ char random string).

Dashboard alternative: **Project → Edge Functions → Manage secrets → Add new
secret** (or **Project Settings → Edge Functions → Secrets**). Set the name and
value, save. The secret becomes available to every edge function in the project
on its next invocation (no redeploy needed).

To check whether a secret is already set: `supabase secrets list
--project-ref dxoikltymmknxqpkpyhi` (values are not shown, only names).

---

## Cron secrets

Each cron job POSTs to its edge function with `?secret=<VALUE>` in the URL. The
function constant-time-compares that value to its env secret. When the secret is
**unset**, the comparison can never pass, so the cron path is unreachable — the
job effectively does nothing.

### `AUTO_RECONCILE_CRON_SECRET`

- **What it's for:** authenticates the daily auto-reconcile sweep so pg_cron can
  drive the function without a user JWT.
- **Consumed by:** `supabase/functions/auto-reconcile/index.ts`
  (`Deno.env.get('AUTO_RECONCILE_CRON_SECRET')`); auth gate accepts a
  service-role bearer **or** `?secret=<AUTO_RECONCILE_CRON_SECRET>`.
- **Cron:** `auto-reconcile-daily`, `15 3 * * *` (03:15 daily), registered by
  `supabase/migrations/0065_auto_reconcile_cron.sql` (currently inert). The cron
  iterates active orgs and POSTs once per org.
- **Fail mode when unset:** the cron path is unreachable; a request without a
  valid secret falls through to the user-JWT path, so the scheduled sweep does
  nothing.
- **Set with:**
  ```sh
  supabase secrets set AUTO_RECONCILE_CRON_SECRET=<random-32-char-string> \
    --project-ref dxoikltymmknxqpkpyhi
  ```

### `ACCOUNTANT_ORCHESTRATOR_CRON_SECRET`

- **What it's for:** authenticates the nightly accountant-orchestrator decision
  engine. Also used as the **handoff token** so the already-scheduled
  `notifications-cron` can invoke the orchestrator without a second all-org
  sweep.
- **Consumed by:**
  - `supabase/functions/accountant-orchestrator/index.ts`
    (`Deno.env.get("ACCOUNTANT_ORCHESTRATOR_CRON_SECRET")`); auth gate accepts a
    service-role bearer **or** `?secret=<ACCOUNTANT_ORCHESTRATOR_CRON_SECRET>`.
  - `supabase/functions/notifications-cron/index.ts` reads the same secret as an
    **optional** handoff — when set, notifications-cron also fires the
    orchestrator.
- **Cron:** preferred shape is the existing nightly `notifications-cron`
  handoff (no separate schedule needed). A standalone
  `accountant-orchestrator-daily` job (`45 3 * * *`, 03:45 daily) is documented
  as an operations fallback in
  `supabase/migrations/0185_accountant_orchestrator_cron.sql` (currently inert).
- **Fail mode when unset:** the orchestrator function **fails closed** — it
  returns HTTP 500 `"Server config missing (need
  ACCOUNTANT_ORCHESTRATOR_CRON_SECRET)"` and does nothing. notifications-cron
  simply skips the orchestrator handoff.
- **Set with:**
  ```sh
  supabase secrets set ACCOUNTANT_ORCHESTRATOR_CRON_SECRET=<random-32-char-string> \
    --project-ref dxoikltymmknxqpkpyhi
  ```

### `ACCRUALS_RUN_CRON_SECRET`

- **What it's for:** authenticates the monthly accruals sweep (recurring
  multi-month bills) so pg_cron can drive the function.
- **Consumed by:** `supabase/functions/accruals-run/index.ts`
  (`Deno.env.get("ACCRUALS_RUN_CRON_SECRET")`); auth gate accepts a service-role
  bearer **or** `?secret=<ACCRUALS_RUN_CRON_SECRET>`. There is **no user-JWT
  path** — this function is cron-only.
- **Cron:** `accruals-run-monthly`, `30 4 3 * *` (04:30 on the 3rd of each
  month), registered by `supabase/migrations/0099_accruals_cron.sql` (currently
  inert). A single no-body POST sweeps every org.
- **Also requires:** `CONNECTOR_JWT_SECRET` must already be set (the function
  mints a per-org token via api-gateway to post journals; unset ⇒ each bill
  fails closed with no journal).
- **Fail mode when unset:** the cron secret is unavailable, the auth gate can
  never pass, and the scheduled run is rejected.
- **Set with:**
  ```sh
  supabase secrets set ACCRUALS_RUN_CRON_SECRET=<random-32-char-string> \
    --project-ref dxoikltymmknxqpkpyhi
  ```

### `DEPRECIATION_RUN_CRON_SECRET`

- **What it's for:** authenticates the monthly depreciation sweep (active asset
  schedules, previous-month period) so pg_cron can drive the function.
- **Consumed by:** `supabase/functions/depreciation-run/index.ts`
  (`Deno.env.get("DEPRECIATION_RUN_CRON_SECRET")`); auth gate accepts a
  service-role bearer **or** `?secret=<DEPRECIATION_RUN_CRON_SECRET>`. There is
  **no user-JWT path** — this function is cron-only.
- **Cron:** `depreciation-run-monthly`, `0 4 3 * *` (04:00 on the 3rd of each
  month), registered by `supabase/migrations/0096_depreciation_cron.sql`
  (currently inert). A single no-body POST sweeps every org.
- **Also requires:** `CONNECTOR_JWT_SECRET` must already be set (same per-org
  token minting as accruals; unset ⇒ fail closed, no journal).
- **Fail mode when unset:** the cron secret is unavailable, the auth gate can
  never pass, and the scheduled run is rejected.
- **Set with:**
  ```sh
  supabase secrets set DEPRECIATION_RUN_CRON_SECRET=<random-32-char-string> \
    --project-ref dxoikltymmknxqpkpyhi
  ```

---

## `SITE_URL` (team-invite links)

- **What it's for:** the base URL embedded in team / accountant invite emails.
  The invite links the recipient to `${SITE_URL}/accept-invite` (and the
  copy-paste fallback link uses the same base).
- **Consumed by:** `supabase/functions/team-invite/index.ts`
  (`Deno.env.get('SITE_URL')`).
- **Fail mode when unset:** the function falls back to the Supabase project URL
  (`https://<ref>.supabase.co`). Invite links then point at the API host instead
  of the app, so `/accept-invite` does not resolve and invitees cannot accept —
  invites are effectively broken until `SITE_URL` is set to the real app origin.
- **Value:** the public app origin with **no** trailing slash, e.g.
  `https://app.looplet.com` (whatever host serves the front-end / `/accept-invite`
  route).
- **Set with:**
  ```sh
  supabase secrets set SITE_URL=https://app.looplet.com \
    --project-ref dxoikltymmknxqpkpyhi
  ```

> Deploy-gated like the cron secrets: it must be set in the **live** project for
> production invite emails to work. A local placeholder does not affect prod.
