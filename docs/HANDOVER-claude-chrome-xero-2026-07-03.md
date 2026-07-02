# Handover: Claude Chrome — connect Xero to Looplet Accounting

**Situation:** the Xero app already exists (it's shared with the Looplet CRM —
its webhook points at the CRM's Supabase project `afytnccutuurafmeymud`, leave
that alone). We are REUSING this same Xero app for Looplet Accounting. Two
things are missing: (1) the accounting app's redirect URI isn't registered,
and (2) the accounting Supabase project doesn't have a known-good client
secret. This handover fixes both, then does the OAuth connect.

**Do the steps in order. Stop and report at any failure.**

## Known values (already confirmed)

- **Xero Client ID:** `7D58CFE0335E44509337C3D3955DB722`
- **Accounting Supabase project ref:** `dxoikltymmknxqpkpyhi`
- **Accounting app prod URL:** `https://looplet-accounting.pages.dev`
- **Accounting Xero callback route the app actually sends:**
  `https://looplet-accounting.pages.dev/settings/xero-callback`

## Step 1 — Register the accounting redirect URI in the Xero app

1. Go to **https://developer.xero.com/app/manage** and open the app whose
   Client ID is `7D58CFE0335E44509337C3D3955DB722` (the one whose Redirect
   URIs already include `accounting.looplet.com.au/auth/callback/xero` and
   several `localhost:5173` entries).
2. Open its **Configuration** page → **Redirect URIs** → **Add another URI**.
3. Add EXACTLY this (character-for-character, no trailing slash):
   ```
   https://looplet-accounting.pages.dev/settings/xero-callback
   ```
4. Save. Do NOT remove any existing redirect URIs — the CRM and other
   environments rely on them.

## Step 2 — Get a client secret we can use

The existing "Client secret 1" (created 2026-06-19) only shows a creation
date — its value is hidden and can't be recovered. Xero allows TWO secrets
per app, and generating a second does NOT invalidate the first, so this is
safe and will NOT break the CRM.

1. On the same Configuration page, click **Generate another secret**
   ("Client secret 2").
2. **Copy the full secret value immediately** — it is shown only once.

## Step 3 — Set the credentials in the accounting Supabase project

Set both secrets on project `dxoikltymmknxqpkpyhi` (NOT the CRM project).

- **Via the Supabase dashboard:** go to
  `https://supabase.com/dashboard/project/dxoikltymmknxqpkpyhi/settings/functions`
  (Edge Functions → Secrets), and set:
  - `XERO_CLIENT_ID` = `7D58CFE0335E44509337C3D3955DB722`
  - `XERO_CLIENT_SECRET` = the secret value from Step 2
- **Or, if this agent has terminal access,** from
  `c:\Users\danie\looplet-accounting`:
  ```
  supabase secrets set "XERO_CLIENT_ID=7D58CFE0335E44509337C3D3955DB722" --project-ref dxoikltymmknxqpkpyhi
  supabase secrets set "XERO_CLIENT_SECRET=<secret-from-step-2>" --project-ref dxoikltymmknxqpkpyhi
  ```
- Also confirm `XERO_STUB_MODE` is NOT `true` on this project (if it's set to
  `true`, the app deliberately fakes Xero and never really connects — it must
  be unset or `false`).

## Step 4 — Do the OAuth connect in the app

1. Go to **https://looplet-accounting.pages.dev/settings**
2. Log into Looplet Accounting (owner account
   affordablefencinggc@gmail.com — credentials supplied out of band).
3. Find the **Xero** card → click **Connect Xero**.
4. It redirects to Xero's login/consent. Log into Xero, pick the organisation
   to connect (a real org, or Xero's free **Demo Company** for a safe test),
   and click **Allow access**.
5. It should redirect back to `/settings/xero-callback` and show a success
   state ("Xero connected").

- If you get a **redirect_uri mismatch** error → Step 1's URI wasn't saved
  exactly; recheck it.
- If you get an **unauthorized_client / invalid client** error → the
  `XERO_CLIENT_SECRET` in Step 3 doesn't match; regenerate and re-set.

## Step 5 — Report the result

Write your result (create/overwrite) to:
```
c:\Users\danie\looplet-accounting\.claude\scratch\xero-connect-result.md
```
Include: `## Status: SUCCESS` or `## Status: FAILED` first line; whether the
redirect URI was added; whether a new secret was generated and set (do NOT
paste the secret value into the file — just say "set"); which Xero org was
connected; and the exact error text if any step failed. The primary session
is watching for this file and will verify the `xero_integrations` row landed.

## Guardrails

- Do NOT touch the Xero app's **webhook** config (it points at the CRM
  project `afytnccutuurafmeymud` — that's intentional, not ours to change).
- Do NOT delete any existing redirect URIs or the existing Client secret 1.
- Do NOT change anything in the CRM's Supabase project.
- Do NOT paste the client secret value into the result file or anywhere
  public — only into the Supabase secret field.
