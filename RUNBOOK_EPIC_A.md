# EPIC A Runbook — "Keep the lights on" (background actually runs)

Steps **you** run on your machine (they need the Supabase CLI + secrets that must not
leave your environment). Nothing sensitive needs to be shared with anyone.

Prereqs: `supabase login`, and `supabase link --project-ref dxoikltymmknxqpkpyhi`.

---

## 1. Apply the migrations (security P0 + cron monitor)

```bash
supabase db push        # applies 0055 (P0 security), 0056 (api_keys), 0057 (cron monitor)
```

> 0055 is idempotent and was already applied live, so push will no-op it.

## 2. Deploy the changed functions

```bash
supabase functions deploy bank-sync --project-ref dxoikltymmknxqpkpyhi
supabase functions deploy bank-sync-all --project-ref dxoikltymmknxqpkpyhi --no-verify-jwt
supabase functions deploy notifications-cron --project-ref dxoikltymmknxqpkpyhi --no-verify-jwt
supabase functions deploy gmail-watch-renew --project-ref dxoikltymmknxqpkpyhi
```

These now use constant-time auth and drop the forgeable "trust the JWT's role claim" path.

## 3. Fix `bank-sync-all`

Status 2026-06-29: completed live. `bank-sync-all` is active as cron job 14,
uses a scoped secret stored in Supabase Vault as `bank_sync_all_cron_secret`,
and a DB-side `pg_net` probe returned HTTP 200 with `ok=true`, `orgs=0`.

Use this only if rotating/recreating the scoped cron secret:

```bash
openssl rand -hex 24                       # generate a scoped secret (NOT the service-role key)
supabase secrets set BANK_SYNC_ALL_CRON_SECRET=<paste> --project-ref dxoikltymmknxqpkpyhi
```

Then store the same value in Vault and schedule the cron without embedding the
secret in `cron.job.command`:

```sql
select vault.create_secret('<paste>', 'bank_sync_all_cron_secret');

select cron.schedule('bank-sync-all', '0 0,6,12,18 * * *', $$
  select net.http_post(
    url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/bank-sync-all?secret='
      || (select decrypted_secret from vault.decrypted_secrets where name = 'bank_sync_all_cron_secret' limit 1),
    headers := jsonb_build_object('Content-Type','application/json')
  ); $$);
```

## 4. Fix `accountant-digest-cron`

Status 2026-06-29: completed live. `accountant-session-digest` is deployed with
`verify_jwt=false`, cron mode requires `ACCOUNTANT_SESSION_DIGEST_CRON_SECRET`
or the exact service-role bearer, and the active cron job 15 reads a scoped
secret stored in Supabase Vault as `accountant_session_digest_cron_secret`.
A DB-side `pg_net` probe returned HTTP 200 with `ok=true`, `sent=0`,
`failed=0`.

Use this only if rotating/recreating the scoped cron secret:

```bash
openssl rand -hex 24
supabase secrets set ACCOUNTANT_SESSION_DIGEST_CRON_SECRET=<paste> --project-ref dxoikltymmknxqpkpyhi
```

Then store the same value in Vault and schedule the cron without embedding the
secret in `cron.job.command`:

```sql
select vault.create_secret('<paste>', 'accountant_session_digest_cron_secret');

select cron.schedule(
  'accountant-digest-cron',
  '*/10 * * * *',
  $$
    select net.http_post(
      url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/accountant-session-digest?secret='
        || (select decrypted_secret from vault.decrypted_secrets where name = 'accountant_session_digest_cron_secret' limit 1),
      headers := jsonb_build_object('Content-Type','application/json'),
      body := '{}'::jsonb
    );
  $$
);
```

## 5. Re-connect Gmail (dead since 2026-05-09, `invalid_grant`)

The refresh token is permanently revoked — only re-consent fixes it. In the app:
**Settings → Integrations → Gmail → Reconnect** (runs `gmail-oauth-start`). After the
deploy in step 2, if a renewal ever fails fatally again the integration auto-disables
and the app shows a reconnect banner instead of silently no-op'ing.

---

## Verify it worked

Run in the SQL editor (ops-only function from migration 0057):

```sql
select jsonb_pretty(public.cron_health_summary());
```

Expect `http_failures_24h` to fall toward 0 over the next day (it was **37**: 36×401 +
1×403 at audit time). Re-check after each cron fires.
