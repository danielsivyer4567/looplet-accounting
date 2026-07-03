# Handover: Claude Chrome — get a working Basiq API key into production

**Why:** we've spent several rounds manually retrieving a Basiq API key and
it keeps failing (`Invalid authorization header` from Basiq, or a missing
`basiq-version` header on the test page) — too slow going back and forth
over chat. This handover lets a browser-driving agent do the whole
retrieve → verify → set → confirm loop in one pass.

**Login:** `dashboard.basiq.io` — owner account
danielsivyer4567@gmail.com (or whichever account the 3 existing API keys
were created under — visible on the Applications/API Keys pages once
logged in). Credentials must be supplied out of band; do not guess or
attempt recovery flows.

## Background — what's already been tried and ruled out

- The `BASIQ_API_KEY` Supabase secret HAS been successfully updated at
  least twice this session (confirmed via secret hash changing each time)
  — so "the secret didn't actually update" is ruled out.
- Every value set so far has been rejected by Basiq's real `/token`
  endpoint with `400 Invalid authorization header`.
- One earlier attempt turned out to be Basiq's own **documentation
  placeholder value** (`Basic NjMxMjNmMWMtZjYxMy00ZjMyLWFiYzUtYzBhZDdhYTY2YmU1OjQ3NWYwMzhkLTBlZmItNGM1ZS1iMzQ0LTAzMzYxOTkyYTRlMw==`)
  — the `x-default` example baked into Basiq's OpenAPI spec, copied from
  the "Try It!" panel on a reference page instead of the real dashboard
  key. **Do not copy any credential value from an `api.basiq.io/reference/*`
  page's Try It panel** — those are pre-filled with a generic example, not
  a real key.
- The API Keys table at `dashboard.basiq.io` (Applications → select app →
  API Keys) shows keys **masked** (e.g. `N2Zh**********hhZg==`). Copying
  the visibly masked text (with literal asterisks) would also produce
  exactly this "Invalid authorization header" error. This is the current
  leading suspect — has not yet been definitively ruled out or confirmed.

## Task — do these steps in order, stop and report at any failure

### 1. Confirm which application the keys belong to
On `dashboard.basiq.io`, check the Applications switcher (top-left, showed
"Demo Application" earlier this session — confirm whether that's still
selected or whether a new production application was created). Report
which application name owns the API keys being tested.

### 2. Get the real, unmasked key value
Go to that application's **API Keys** page. There are 3 existing keys
("sec of july" created 02 Jul 2026, two "accounting..." keys from 21 Jun
and 03 May 2026). Use the newest one ("sec of july") unless told
otherwise.

- Look for an explicit **reveal/eye icon** or a **dedicated copy-icon
  button** next to the key row — do NOT select-and-copy the masked table
  text directly.
- If no reveal option exists on this key, click **"Create key"** to
  generate a brand new one instead — a freshly created key is typically
  shown in full, unmasked, exactly once at creation time. Name it
  `looplet-accounting-verified` so it's identifiable, and capture the full
  value immediately (it usually cannot be viewed again after this).

### 3. Verify the key independently of our system
Go to `https://api.basiq.io/reference/posttoken` ("Generate an auth
token"). In the **Credentials** field, replace the pre-filled placeholder
with the real key you just captured. In the **Headers** section, ensure
`basiq-version` is explicitly set to `3.0` (this field must be filled in
on the Try-It panel itself, not just show a greyed placeholder). Set
`scope` to `SERVER_ACCESS` in the form data. Click **Try It!**.

- **200 response with an `access_token`** → the key is genuinely valid.
  Proceed to step 4.
- **Any error** → capture the exact error JSON and stop here. Report back
  — this means the key itself is bad (wrong app, revoked, or copy issue
  persisted), not a problem with our system, and needs a different key or
  Basiq support involvement.

### 4. Set the verified key in Supabase
Once step 3 confirms a real `access_token` comes back, the key is proven
good. If this agent has terminal/shell access in this environment, run
from `c:\Users\danie\looplet-accounting`:

```powershell
supabase secrets set "BASIQ_API_KEY=<the-verified-key>" --project-ref dxoikltymmknxqpkpyhi
```

If no terminal access, report the verified key back through a secure
channel (not pasted in a shared chat log if avoidable) so it can be set
manually.

### 5. Confirm end-to-end against our own system
After the secret is set, run this from the repo root (or ask the primary
session to run it) to confirm our function chain now authenticates
successfully:

```powershell
$SRK = (Get-Content .env.local | Select-String '^SUPABASE_SERVICE_ROLE_KEY=').ToString().Split('=',2)[1]
Invoke-RestMethod -Method Post `
  -Uri "https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/bank-link-token" `
  -Headers @{ Authorization = "Bearer $SRK"; "Content-Type" = "application/json" } `
  -Body (@{
    organization_id = "9d5c9b9a-a576-458d-913a-fa822d33320d"
    redirect_uri = "https://looplet-accounting.pages.dev/settings/bank-callback"
    mobile = "+61412345678"
    email = "affordablefencinggc@gmail.com"
  } | ConvertTo-Json)
```

- **`{"ok": true, "url": "...", ...}`** → fully fixed. The `bank-link-token`
  function now successfully authenticates with Basiq and returns a real
  Connect URL. Report success.
- **Still an error** → capture and report the exact error text; something
  beyond just the key is wrong (e.g. `BASIQ_BASE_URL` misconfigured, or the
  key belongs to a sandbox-only application that can't reach production
  endpoints).

## Guardrails

- Do not click through an actual bank Connect flow with a real bank login
  during this handover — this task is only about getting the API key
  working, not completing a live bank connection.
- Do not create more than one new API key unless the first attempt fails
  verification in step 3.
- Do not touch anything else in the Basiq dashboard (consent policy,
  institutions, branding) — that's already configured from earlier this
  session.
- **Prefer creating a brand new key over reveal-hunting an existing one.**
  Existing keys in the API Keys table render masked
  (`N2Zh**********hhZg==`); most platforms including Basiq only return the
  real value once, at creation — there is likely no reveal action that
  works on an already-existing key. Don't spend more than one attempt
  looking for a reveal/eye icon before falling back to "Create key".

## Report back — write your result to this file when done

The primary session is watching for this file to appear/change and will
pick up automatically — you do not need the user to relay results over
chat. Write (create or overwrite) this exact path when you finish, whether
you succeeded or got stuck:

```
c:\Users\danie\looplet-accounting\.claude\scratch\basiq-key-handover-result.md
```

Contents — plain markdown, include:
- `## Status: SUCCESS` or `## Status: FAILED` as the first line
- Which application the key came from (step 1)
- Whether it was an existing revealed key or a freshly created one (step 2)
- The exact response from the verification call in step 3 (success or the
  error JSON)
- Whether the Supabase secret was set (step 4) and by what method
- The exact response from the end-to-end test in step 5
- Do NOT include the raw key value itself in this file — reference "the
  key" or "verified key", not the literal string, since this file may be
  read by other tooling.
