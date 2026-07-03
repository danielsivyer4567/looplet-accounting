# Credentials & secrets — setup checklist

Complete inventory of every credential the app reads, derived from the code
(`Deno.env.get`/`requireEnv` in `supabase/functions`, `import.meta.env.VITE_*`
in `src`). **Placeholders only — never commit real values.** Fill a private copy.

Credentials live in **three** places:
1. **Cloudflare Pages** — frontend build vars (`VITE_*`).
2. **Supabase edge-function secrets** — project `dxoikltymmknxqpkpyhi`.
3. **External provider portals** — values that must *match* the above.

> **Auto-injected — do NOT set manually:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
> `SUPABASE_SERVICE_ROLE_KEY` are provided to every edge function by the
> platform. Setting them by hand is reserved/blocked.

---

## 1 · Cloudflare Pages (frontend build vars)

Project → Settings → Environment variables → Production.

| Var | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://dxoikltymmknxqpkpyhi.supabase.co` |
| `VITE_SUPABASE_PROJECT_REF` | `dxoikltymmknxqpkpyhi` |
| `VITE_SUPABASE_ANON_KEY` | `<anon key — public, Supabase dashboard → API>` |
| `VITE_XERO_CLIENT_ID` | `<Xero app Client ID>` |
| `VITE_XERO_REDIRECT_URI` | `https://accounting.looplet.com.au/auth/callback/xero` |
| `VITE_SENTRY_DSN` | `<optional — blank to disable>` |

---

## 2 · Supabase edge-function secrets (`dxoikltymmknxqpkpyhi`)

Put in a **private** `secrets.env` (outside the repo), then:

```bash
export SUPABASE_ACCESS_TOKEN=<personal access token>
supabase secrets set --project-ref dxoikltymmknxqpkpyhi --env-file secrets.env
```

…or paste in Dashboard → Project Settings → Edge Functions → Secrets (no token).

### Core (required)
| Secret | Notes |
|---|---|
| `ENCRYPTION_KEY` | 32+ char random; encrypts stored OAuth tokens |
| `CONNECTOR_JWT_SECRET` | **MUST equal the project's *legacy* JWT secret** (Dashboard → API → JWT Settings). Random value ⇒ cross-fn HS256 auth breaks |
| `SITE_URL` | `https://accounting.looplet.com.au` |
| `APP_ORIGIN` | `https://accounting.looplet.com.au` |

### Xero
| Secret | Notes |
|---|---|
| `XERO_CLIENT_ID` | Xero app Client ID |
| `XERO_CLIENT_SECRET` | Xero app Client Secret |
| `XERO_OAUTH_STATE_SECRET` | random; HMAC-signs OAuth state — **connect fails closed without it** |
| `XERO_WEBHOOK_KEY` | the signing key from Xero (rotate → paste new value) |
| `XERO_CRON_SECRET` | generate random |
| `XERO_SCOPES` | optional (code default) |
| `XERO_STUB_MODE` | `false` in prod |
| `XERO_DEFAULT_ACCOUNT_CODE` / `XERO_DEFAULT_INCOME_ACCOUNT_CODE` / `XERO_DEFAULT_TAX_TYPE` | optional defaults |

### Bank feeds / Basiq
| Secret | Notes |
|---|---|
| `BASIQ_API_KEY` | Basiq API key |
| `BASIQ_BASE_URL` | `https://au-api.basiq.io` |
| `BASIQ_WEBHOOK_VERIFY_TOKEN` | random; `?token=` gate on bank-webhook |
| `BASIQ_WEBHOOK_HMAC_SECRET` | optional; only if Basiq HMAC enabled |

### Gmail ingest
| Secret | Notes |
|---|---|
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | Google OAuth client |
| `GMAIL_PUBSUB_TOPIC` | `projects/<proj>/topics/<topic>` |
| `GMAIL_PUSH_VERIFY_TOKEN` | random; Pub/Sub push gate |
| `GMAIL_WATCH_RENEW_CRON_SECRET` | generate random |

### OCR / AI (set `OCR_PROVIDER` + at least that provider's key)
| Secret | Notes |
|---|---|
| `OCR_PROVIDER` | `openai` \| `groq` \| `anthropic` \| `minimax` |
| `OPENAI_API_KEY` / `GROQ_API_KEY` / `ANTHROPIC_API_KEY` / `MINIMAX_API_KEY` | provider keys |
| `PERPLEXITY_API_KEY` | legal research / horizon scan |
| `*_BASE_URL`, `*_VISION_MODEL` | optional overrides (code defaults) |

### Email
| Secret | Notes |
|---|---|
| `RESEND_API_KEY` | outbound transactional email |
| `EMAIL_INBOUND_SECRET` | random; inbound email webhook auth |

### CRM sync (P&L push)
| Secret | Notes |
|---|---|
| `CRM_SYNC_ENDPOINT_URL` | CRM receiver URL (from CRM team) |
| `CRM_SYNC_SECRET` | shared secret (agree with CRM team) |

### Cron shared secrets (each an invented random string)
`AUTOMATION_WORKER_SECRET`, `AUTOMATION_WATCHDOG_SECRET`,
`AUTO_RECONCILE_CRON_SECRET`, `BANK_CLASSIFIER_CRON_SECRET`,
`BANK_SYNC_ALL_CRON_SECRET`, `ACCOUNTANT_ORCHESTRATOR_CRON_SECRET`,
`ACCOUNTANT_SESSION_DIGEST_CRON_SECRET`, `ACCRUALS_RUN_CRON_SECRET`,
`DEPRECIATION_RUN_CRON_SECRET`, `ADVISOR_CRON_SECRET`,
`NOTIFICATIONS_CRON_SECRET`, `RECEIPT_SYNC_DISPATCH_CRON_SECRET`,
`LEGAL_INGEST_SECRET`, `LEGAL_SCAN_SECRET`, `LEGAL_SYNC_SECRET`.

---

## 3 · External portals (must match §1/§2)

**Xero Developer app** (developer.xero.com/app/manage → your app):

```
Redirect URI :  https://accounting.looplet.com.au/auth/callback/xero
Redirect URI :  https://accounting.looplet.com.au/settings/xero-callback   (belt-and-braces)
Webhook URL  :  https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/xero-webhook
Webhook key  :  regenerate → paste same value into XERO_WEBHOOK_KEY
Client ID/Secret → XERO_CLIENT_ID/_SECRET (+ VITE_XERO_CLIENT_ID)
```

**Google Cloud** (Gmail): OAuth client → `GMAIL_CLIENT_ID/_SECRET`; Pub/Sub
topic → `GMAIL_PUBSUB_TOPIC`; push subscription verify token → `GMAIL_PUSH_VERIFY_TOKEN`.

**Basiq / Resend / AI providers / Perplexity:** issue an API key in each
console → the matching secret above.

---

## Current status — audited 2026-07-03 (project `dxoikltymmknxqpkpyhi`)

Diff of code-referenced vs actually-set secrets (`supabase secrets list`).

**🔴 Missing & referenced — set these:**
- `ACCOUNTANT_ORCHESTRATOR_CRON_SECRET`, `ACCRUALS_RUN_CRON_SECRET`,
  `DEPRECIATION_RUN_CRON_SECRET`, `ADVISOR_CRON_SECRET` — those crons fail
  closed (can't run) until set.
- `EMAIL_INBOUND_SECRET` — inbound email webhook fails closed.
- `SITE_URL`, `APP_ORIGIN` — email/callback links + CORS origin.

**🟡 Missing but optional / situational:**
- `XERO_OAUTH_STATE_SECRET` — **not a blocker**: falls back to
  `XERO_CLIENT_SECRET` (which is set), so connect works. Set a dedicated one
  for hygiene.
- `CRM_SYNC_ENDPOINT_URL`, `CRM_SYNC_SECRET` — only when CRM P&L push goes live.
- `XERO_DEFAULT_INCOME_ACCOUNT_CODE`, `XERO_SCOPES` — optional defaults.
- `ANTHROPIC_API_KEY` (+ base/model) — only if `OCR_PROVIDER=anthropic`.
- `BASIQ_WEBHOOK_HMAC_SECRET`, `*_BASE_URL`, `*_VISION_MODEL` — optional.

**⚪ Set but unused by current code (safe to ignore / delete):**
- `XERO_REDIRECT_URI` — redirect is frontend-driven (`VITE_XERO_REDIRECT_URI`).
- `XERO_DEFAULT_TENANT_ID`, `GOOGLE_MAPS_SERVER_KEY` — no code reference.

**✅ All Xero-connect essentials are set** (`XERO_CLIENT_ID`,
`XERO_CLIENT_SECRET`, `XERO_WEBHOOK_KEY`, `XERO_CRON_SECRET`, etc.). The connect
blocker is the redirect-URI registration in the Xero portal, **not** a missing
secret. `XERO_WEBHOOK_KEY` is set but must be **rotated** (leaked) + the
`xero-webhook` function deployed.

## Gotchas (silent failures)
- `CONNECTOR_JWT_SECRET` = the **legacy** JWT secret, not random. Clicking
  "Migrate JWT secret" in the dashboard re-breaks every HS256-minting function.
- `XERO_WEBHOOK_KEY` must **exactly** equal Xero's current signing key — rotate
  in Xero *first*, then update this.
- `XERO_OAUTH_STATE_SECRET` is required for connect (HMAC-signed state).
- Cron secrets are invented by you; each cron endpoint checks its own.
