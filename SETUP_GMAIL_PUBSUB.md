# Gmail Pub/Sub intake — GCP setup

The Looplet Accounting code is in place (migrations `0005`/`0006`, four edge
functions under `supabase/functions/gmail-*`, and the `Settings → Gmail intake`
UI). To make it actually receive mail, you need to wire up a Google Cloud
project once. Allow ~15-20 minutes.

---

## 1. Pick or create a GCP project

- Console: https://console.cloud.google.com
- Note your project id — you'll paste it into the topic name later.

## 2. Enable two APIs

In **APIs & Services → Library**, enable both:

- **Gmail API**
- **Cloud Pub/Sub API**

## 3. OAuth consent screen

**APIs & Services → OAuth consent screen**

- User type: **External**
- App name: `Looplet Accounting`
- Support email: yours
- Developer contact: yours
- Scopes — add these two:
  - `.../auth/gmail.readonly`
  - `.../auth/gmail.metadata`
- Test users — add your own Gmail address (you can publish later for production)

## 4. OAuth client credentials

**APIs & Services → Credentials → Create credentials → OAuth client ID**

- Type: **Web application**
- Name: `Looplet Accounting (web)`
- Authorised redirect URI:
  ```
  http://localhost:5174/settings/gmail-callback
  ```
  (Add your prod URL too when you have one.)
- Click **Create** → copy the **Client ID** and **Client secret**.

## 5. Pub/Sub topic + permissions

**Pub/Sub → Topics → Create topic**

- Topic ID: `gmail-watch`
- Default subscription: **uncheck** (we'll create a custom push sub next)

After creation, on the topic detail page → **Permissions** tab → **Add principal**:

- Principal: `gmail-api-push@system.gserviceaccount.com`
- Role: **Pub/Sub Publisher**

This is the magic step — without it, Gmail can't publish to your topic and
`watch()` returns 403.

## 6. Pub/Sub push subscription

**Pub/Sub → Subscriptions → Create subscription**

- Subscription ID: `gmail-watch-push`
- Topic: `gmail-watch` (the one you just made)
- Delivery type: **Push**
- Endpoint URL:
  ```
  https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/gmail-pubsub-push?token=PASTE_RANDOM_VERIFY_TOKEN
  ```
  (Generate a random string for `PASTE_RANDOM_VERIFY_TOKEN` — same value
  goes into Supabase secret `GMAIL_PUSH_VERIFY_TOKEN` in step 7.)
- **Enable authentication**: optional but recommended. If enabled, set a
  service account with no special perms; the function ignores the OIDC token
  by default and uses the URL `?token=` instead.
- Acknowledgement deadline: 60s (default is 10s; bump it because we may
  hit Gmail API + storage uploads in the push handler)
- Message retention: leave default

## 7. Hand the values to me

Paste these three values back to me in chat (or set them yourself):

| Var | Where it came from | Sensitivity |
|---|---|---|
| `GMAIL_CLIENT_ID` | Step 4 OAuth client | low |
| `GMAIL_CLIENT_SECRET` | Step 4 OAuth client | high — rotate if leaked |
| `GMAIL_PUBSUB_TOPIC` | `projects/<your-gcp-project-id>/topics/gmail-watch` | low |
| `GMAIL_PUSH_VERIFY_TOKEN` | Random string from step 6 URL | medium |

I'll run:

```powershell
npx supabase secrets set --project-ref dxoikltymmknxqpkpyhi `
  GMAIL_CLIENT_ID=... `
  GMAIL_CLIENT_SECRET=... `
  GMAIL_PUBSUB_TOPIC=projects/.../topics/gmail-watch `
  GMAIL_PUSH_VERIFY_TOKEN=...
```

## 8. Test the flow

1. `npm run dev`, open `http://localhost:5174/settings`
2. Click **+ Connect Gmail**
3. Sign in to your Google account, accept the readonly scope
4. You should land back at `/settings/gmail-callback` and see "Connected
   you@gmail.com. Redirecting…"
5. Send yourself a test email with a PDF attached
6. Within ~30s the bill should appear at `/bills` with `source=gmail`

## 9. Cron the watch renewal

Gmail's `users.watch()` expires every 7 days. Set up a daily renewal:

```sql
-- Run once in Supabase SQL editor
SELECT cron.schedule(
  'gmail-watch-renew',
  '0 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/gmail-watch-renew',
    headers := jsonb_build_object('Content-Type', 'application/json')
  );
  $$
);
```

(Requires `pg_cron` and `pg_net` extensions — both available in Supabase.)

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| OAuth callback → `No refresh_token returned` | You authorised before with `prompt!=consent`. Revoke at https://myaccount.google.com/permissions and reconnect. |
| `watch() failed (403)` in callback | Forgot step 5 — add `gmail-api-push@system.gserviceaccount.com` as Publisher on the topic. |
| Pub/Sub keeps retrying | The push fn returned 5xx. Check function logs in Supabase dashboard. The fn is designed to return 200 even on app-level errors so Pub/Sub doesn't retry-storm. |
| `Invalid push verification token` | URL `?token=` doesn't match `GMAIL_PUSH_VERIFY_TOKEN` Supabase secret. |
| Bills appear but stay `received` | `bills-extract` failed. Check its function logs and your `GROQ_API_KEY` secret. |

---

**Files this depends on:**

- migrations: [0005_gmail_integrations.sql](supabase/migrations/) (applied to `dxoikltymmknxqpkpyhi`)
- shared: [supabase/functions/_shared/gmail/auth.ts](supabase/functions/_shared/gmail/auth.ts)
- functions: [gmail-oauth-start](supabase/functions/gmail-oauth-start/), [gmail-oauth-callback](supabase/functions/gmail-oauth-callback/), [gmail-pubsub-push](supabase/functions/gmail-pubsub-push/), [gmail-watch-renew](supabase/functions/gmail-watch-renew/)
- UI: [src/components/settings/GmailConnect.tsx](src/components/settings/GmailConnect.tsx), [src/pages/GmailCallback.tsx](src/pages/GmailCallback.tsx)
