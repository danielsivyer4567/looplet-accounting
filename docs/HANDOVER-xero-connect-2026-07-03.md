# Handover: what's needed from Xero to connect it

**Goal:** get one real Xero organisation connected so `xero_integrations` has a
live row and pushes stop running the `STUB-<id>` fallback. Unlike Basiq,
**Xero's API and OAuth are free** — there's no platform fee, no sandbox-vs-
production paywall, no 12-month contract. The only cost is a Xero
subscription for whatever org you connect (or use Xero's free **Demo
Company** for testing). So this is genuinely doable today at no cost.

## Current state (verified 2026-07-03)

- All Xero secrets ARE already set in Supabase: `XERO_CLIENT_ID`,
  `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI`, `XERO_CRON_SECRET`,
  `XERO_WEBHOOK_KEY`, `XERO_DEFAULT_ACCOUNT_CODE`, `XERO_DEFAULT_TAX_TYPE`,
  `XERO_DEFAULT_TENANT_ID`, `XERO_STUB_MODE`.
- `xero_integrations` table has **0 rows** → never actually connected.
- The edge functions (`xero-oauth-start`, `xero-oauth-callback`) are deployed
  and the OAuth `state` is HMAC-signed (already hardened).
- **Unknown:** whether the `XERO_CLIENT_ID`/`XERO_CLIENT_SECRET` currently set
  are from a REAL Xero app or leftover placeholders. That's the first thing to
  confirm.

## What I need from Xero, exactly

### 1. A real Xero OAuth 2.0 app
At **developer.xero.com → My Apps** (https://developer.xero.com/app/manage):
- Confirm there is a real app (or create one: "New app" → Web app).
- From that app's **Configuration** page, capture:
  - **Client id**
  - **Client secret** (generate one if none shown — shown once)

### 2. The redirect URI registered in that Xero app — MUST match exactly
The app sends this redirect URI, so the Xero app must have it registered
**character-for-character** or OAuth fails with a redirect-mismatch error:

```
https://looplet-accounting.pages.dev/settings/xero-callback
```

(The app also has a second callback route `…/auth/callback/xero` — register
that too if you want it as a fallback, but `/settings/xero-callback` is the
one the Connect button actually uses.)

### 3. The scopes the app must be allowed to grant
The OAuth request asks for exactly these — the Xero app must permit them:

```
openid profile email offline_access accounting.invoices accounting.contacts accounting.settings.read
```

### 4. A Xero organisation to connect
Either a real Xero org you own, or Xero's free **Demo Company** (every Xero
login has one — good for proving the flow without touching real books).

## The actual connect step (after 1–4 are confirmed)

1. Make sure the Supabase secrets `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET`
   hold the values from step 1 (if the existing ones are placeholders, they
   must be updated — tell me and I'll set them via
   `supabase secrets set … --project-ref dxoikltymmknxqpkpyhi`).
2. In the app: `https://looplet-accounting.pages.dev/settings` → **Xero**
   card → **Connect Xero**.
3. Log into Xero, pick the organisation, click **Allow access**.
4. It redirects back to `/settings/xero-callback`, which creates the
   `xero_integrations` row. Done — pushes now hit real Xero instead of stub.

## How I verify it worked (I'll run this)

```sql
select organization_id, xero_tenant_name, is_enabled, status, last_synced_at
from xero_integrations;
```

One+ row with `is_enabled = true` = connected for real.

## Bottom line — the two things only YOU can provide

1. **Confirmation the Client ID/Secret are from a real Xero app** (and the new
   secret value if they're placeholders).
2. **The one browser click-through** of the Xero login + "Allow access"
   consent — same as Basiq, this legally can't be scripted; it needs your
   actual Xero login.

Everything else (functions, secrets plumbing, callback handling, HMAC state)
is already built and deployed. Xero is the easy one — no paywall, no waiting.
