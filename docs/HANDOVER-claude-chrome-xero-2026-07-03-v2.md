# Handover: Claude Chrome — finish Xero for Looplet Accounting (2026-07-03, v2)

Supersedes v1. v1 assumed the `pages.dev` domain and "leave webhook on CRM";
both are revised below after this session's work + a canonical-domain decision.

## Current state (verified this session)
- **Accounting Supabase project:** `dxoikltymmknxqpkpyhi` (NOT the CRM's
  `afytnccutuurafmeymud`).
- **Canonical prod app:** `https://accounting.looplet.com.au` (decided this
  session — supersedes pages.dev). The deployed build sends OAuth redirect_uri
  `https://accounting.looplet.com.au/auth/callback/xero`.
- **`xero_integrations` table = EMPTY.** No org has ever connected. **The goal
  is to land the first row.**
- **Xero app is SHARED with the CRM.** Client ID `7D58CFE0335E44509337C3D3955DB722`.
- **Accounting `xero-webhook` is deployed + working** at
  `https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/xero-webhook`
  (bad signature → 401, verified). Table `xero_webhook_events` exists.
- On the accounting project, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`,
  `XERO_WEBHOOK_KEY` are all SET — but the client secret may be **stale** and the
  webhook key was **exposed** (rotate). See below.

## ⚠️ CRITICAL — use `accounting.looplet.com.au` for the WHOLE flow (NOT pages.dev)
v1 said use `looplet-accounting.pages.dev`. **That is wrong and is the likely
cause of every prior failure.** The deployed build's redirect_uri is baked to
`https://accounting.looplet.com.au/auth/callback/xero`, so Xero **always**
redirects the callback to `com.au` no matter where you clicked Connect. The
callback throws `Not signed in` if there's no Supabase session, and that session
is **per-origin** — so if you log in / Connect on `pages.dev`, the callback lands
on `com.au` unauthenticated and writes **no** connection. **Log in, Connect, and
receive the callback all on `https://accounting.looplet.com.au`.** The two app
tabs already open on `com.au` are the correct place — stay there.

**CORS also enforces this (confirmed 2026-07-03):** `APP_ORIGIN`/`SITE_URL` were
set to `https://accounting.looplet.com.au` this session, so every edge function's
`Access-Control-Allow-Origin` is now pinned to `com.au` (it was wildcard `*`
before). A Connect from `pages.dev` therefore fails **"Failed to fetch"**
(CORS-blocked at `xero-oauth-start`) before reaching Xero — expected off-domain,
NOT a bug. **Do NOT add pages.dev to the allowlist** — com.au-only is the intended
hardening. From `com.au` the request is allowed.

## What you (Claude Chrome) can / cannot do
- **CAN:** operate the Xero Developer portal (developer.xero.com) — read/add
  redirect URIs, generate a client secret, view/set the webhook, click
  "Intent to receive"; operate the app UI **once logged in**.
- **CANNOT:** log into the app (**never enter passwords** — wait for an
  authenticated session handed to you); run CLI/DB.
- Supabase secrets: you *may* set them via the dashboard UI
  (`supabase.com/dashboard/project/dxoikltymmknxqpkpyhi` → Edge Functions →
  Secrets), or report the value to the primary session to set via CLI.

## STEP 1 — Redirect URI (probably already fine; verify)
1. `https://developer.xero.com/app/manage` → open the app with Client ID
   `7D58CFE0335E44509337C3D3955DB722` → **Configuration** → **Redirect URIs**.
2. CONFIRM it contains EXACTLY (no trailing slash):
   `https://accounting.looplet.com.au/auth/callback/xero`
   (prior notes say it already does). If missing, add it.
3. Belt-and-braces, also add `https://accounting.looplet.com.au/settings/xero-callback`
   (the app supports both callback routes).
4. **Do NOT remove** any existing redirect URIs — CRM + localhost entries rely
   on them.

## STEP 2 — Client secret (the LIKELY real blocker)
The original "Client secret 1" value is unrecoverable, so the secret currently
set on the accounting project may be wrong → the OAuth callback can't exchange
the code → no connection is written (this is the most probable reason the table
is empty despite the redirect URI matching).
1. On the same Configuration page → **Generate another secret** ("Client secret 2").
   This does NOT invalidate secret 1, so it will NOT break the CRM.
2. **Copy the value immediately** (shown once).
3. Set it as `XERO_CLIENT_SECRET` on project `dxoikltymmknxqpkpyhi` (dashboard
   Edge-Function Secrets, or hand to the primary session — **never paste it into
   a file/chat**). Also confirm `XERO_CLIENT_ID` = `7D58CFE0335E44509337C3D3955DB722`
   and `XERO_STUB_MODE` is not `true` (already verified this session: it is
   `false` — no action needed there).

## STEP 3 — Do the connect
1. A human logs into `https://accounting.looplet.com.au` (owner
   affordablefencinggc@gmail.com). **Wait for the authenticated session — do not
   type the password yourself.**
2. `/settings` → Xero card → **Connect Xero**.
3. On Xero's consent screen, BEFORE clicking Allow: read the `redirect_uri=`
   param in the `login.xero.com/identity/connect/authorize` URL and confirm it
   is EXACTLY `https://accounting.looplet.com.au/auth/callback/xero`. If it
   differs → STOP and report.
4. Pick the org (or Xero **Demo Company** for a safe test) → **Allow access**.
5. Confirm it lands back on `/settings` with "Xero connected" and the card shows
   the tenant name + `active`.

Error map: `redirect_uri mismatch` → Step 1 URI not exact. `unauthorized_client`
/ `invalid_client` → Step 2 secret wrong; regenerate + re-set.

## STEP 4 — Webhook: DECISION NEEDED — do NOT change unprompted
- The Xero app's webhook currently points at the CRM project
  `https://afytnccutuurafmeymud.supabase.co/functions/v1/xero-webhook`, which is
  failing "Intent to receive / Response not 2XX" (that CRM endpoint isn't working).
- A Xero app has only ONE webhook URL. This session deployed a **working**
  accounting webhook: `https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/xero-webhook`.
- **Recommendation (needs the user's explicit OK):** repoint the webhook to the
  Accounting URL — Accounting is the system that processes Xero financials, and
  the CRM reads financials from Accounting, so Accounting owning the webhook is
  consistent. If confirmed: set the webhook URL to the accounting one → **rotate
  the signing key** (the current one leaked) → set `XERO_WEBHOOK_KEY` on
  `dxoikltymmknxqpkpyhi` to the new value → click "Intent to receive" (it will
  pass: the accounting endpoint returns 200 on valid / 401 on invalid).
- **If not confirmed:** leave the webhook on the CRM; it's the CRM team's endpoint
  to fix. **Either way, do NOT repoint the webhook without explicit confirmation.**

## STEP 5 — Report
Write result to `c:\Users\danie\looplet-accounting\.claude\scratch\xero-connect-result.md`:
first line `## Status: SUCCESS` or `## Status: FAILED`; whether the redirect URIs
were present/added; whether a new client secret was generated + set (say "set" —
never paste the value); which org connected; exact error text for any failed
step. The primary session watches for this file and verifies the
`xero_integrations` row landed.

## Guardrails
- Never enter the app password; never paste secrets into files/chat.
- Don't remove existing Xero redirect URIs or delete Client secret 1.
- Don't touch the CRM's Supabase project (`afytnccutuurafmeymud`).
- Webhook: no change without explicit user confirmation (Step 4).
