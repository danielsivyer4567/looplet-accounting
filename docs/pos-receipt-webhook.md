# POS Receipt Webhook Design

This design covers the merchant/POS side of Looplet Receipt Hub. It is the path
where a business sends a structured receipt directly to Looplet at checkout.

The target model is rewards-style eReceipt capture: the customer presents a
Looplet identity before payment, the POS attaches that identity to the sale, and
the POS or bridge sends the full itemised receipt after the EFTPOS tender is
accepted. EFTPOS can confirm payment, but it is not the source of truth for
receipt lines, GST, receipt number, job reference, or merchant catalogue data.

## End-to-end Flow

```text
Customer presents Looplet identity as QR/barcode/NFC/pass
        |
        v
POS scans identity and attaches it to the basket
        |
        v
EFTPOS/card/cash tender is accepted
        |
        +-- direct webhook, if the POS supports custom webhooks
        |
        +-- local/cloud bridge, if the POS needs middleware
        |
        v
POST /functions/v1/receipt-webhook
        |
        v
Receipt Hub validates identity, idempotency, totals, and line items
        |
        +-- receipt_events + receipt_event_line_items
        +-- bill + bill_line_items, when business/deductible
        +-- receipt_audit_packages
        +-- receipt_sync_jobs for Xero/MYOB/QuickBooks/generic API
```

Looplet never requires inbound access to the merchant network. The business side
only needs outbound HTTPS to Supabase.

## Why POS-first, not EFTPOS-only

EFTPOS/payment terminals usually know payment facts: merchant, amount, tender
time, card scheme, masked card, and an authorisation/reference id. They usually
do not know the basket-level facts Looplet needs for accounting and tax:

- line item descriptions, quantities, and categories
- GST/subtotal split by receipt
- merchant receipt number
- job/customer reference captured at sale time
- whether the sale should become a bill, evidence-only receipt, or review item

For a reliable accounting receipt, the trigger should be the POS transaction
that has both the scanned Looplet identity and the completed tender result.
Payment data can be included as supporting metadata.

## Business-side Install Options

| Option | Install at the business | Best fit | Notes |
|---|---|---|---|
| Direct POS webhook | POS configuration only | Modern POS supports custom webhook URL, headers, and JSON body mapping | Lowest moving parts. Configure endpoint, bearer key, `Idempotency-Key`, and payload mapping. |
| POS plugin/app | Vendor-specific plugin | POS has an app marketplace or extension SDK | Plugin reads checkout events and sends Looplet-shaped JSON. |
| Local bridge | Small Node service on back-office PC/server | POS exports files, has local database/API, or cannot set custom headers | Bridge watches an export folder or polls the POS API, maps receipt data, retries transient failures, dead-letters permanent failures, and posts to Looplet. |
| Cloud bridge | Hosted connector service, Zapier, Make, or custom integration | POS already emits events to a cloud platform | Connector transforms vendor payload to Looplet schema and preserves a stable idempotency key. |
| EFTPOS-only monitor | Payment-terminal/export integration plus later POS matching | Last-resort fallback only | Can create a payment stub, but cannot reliably create a tax receipt without POS basket data. |

Use the merchant package's fit check before choosing a path:

```powershell
node C:\ProgramData\Looplet\pos-bridge\integration-fit.mjs C:\ProgramData\Looplet\pos-integration-profile.json
```

Copy `integration-fit.example.json`, fill in the business POS capabilities, and
require `ok: true` before proceeding. The check recommends the connector mode
plus `receipt_source_format` and `field_sample_capture_method` for
`pos-pilot-site.json`; it fails EFTPOS-only paths and missing support for
identity capture, final tender trigger, itemised lines, GST, stable idempotency,
payment reference, or refund/void original-sale references. It does not replace
go-live evidence from real POS sale/refund/void field samples.

After the fit check passes, generate the business pilot kit:

```powershell
node C:\ProgramData\Looplet\pos-bridge\pilot-kit.mjs C:\ProgramData\Looplet\pos-integration-profile.json --output-dir C:\ProgramData\Looplet\pilot-kit
```

The kit emits `pos-integration-profile.json`, `pos-integration-fit.json`,
`pos-pilot-site.template.json`, `PILOT_RUNBOOK.md`, and `go-live-command.ps1`.
Use the profile file for `--fit-profile`/`--fit`; keep the fit result for
archive readback. The generated site template inherits the recommended connector
mode, completed receipt trigger, source format, and field capture method,
reducing manual mismatch before go-live.

## Required Looplet Setup

1. Create an organization-bound API key with `write:receipts`.
2. Issue active receipt identity tokens with `issue_receipt_identity` for
   customer passes/tags or pilot identities.
3. Store the merchant API key in the POS connector's secret store, not in source
   code. Store `LOOPLET_RECEIPT_IDENTITY_TOKEN` only as a fallback/readiness
   token; production POS payloads should carry the customer-scanned
   `identity_token` per receipt.
4. Configure the webhook URL:

```text
https://<supabase-project>.supabase.co/functions/v1/receipt-webhook
```

5. Configure headers:

```text
Authorization: Bearer llp_<prefix>.<secret>
Idempotency-Key: <stable POS payment or receipt event id>
Content-Type: application/json
```

The API key authenticates the merchant integration. The receipt identity token
links the checkout to the customer/pass/tag identity that Looplet issued. In a
rewards-style flow this identity is scanned at checkout and sent on that receipt,
not hardcoded once for the whole business.

## Checkout Sequence

1. Cashier scans the Looplet QR/barcode/pass, or the customer taps an NFC/pass if
   the POS supports it.
2. POS records the scanned value as the Looplet receipt identity for the basket.
3. Sale is paid through EFTPOS/card/cash as normal.
4. POS or bridge waits for final tender success.
5. POS or bridge sends one receipt event to Looplet with the same stable
   `Idempotency-Key` every time it retries.
6. Looplet stores the receipt, creates the bill/evidence where appropriate, and
   queues downstream sync jobs.

Do not fire the final receipt webhook when payment is merely authorised or still
pending unless the POS later sends a reversal/cancellation event. The current
receipt endpoint is designed for completed receipts.

## Payload Contract

The request body must include:

- `identity_token`: the `rhp_<prefix>.<secret>` receipt identity token scanned
  from the customer pass/tag for this checkout.
- `idempotency_key`: recommended duplicate of the header value for systems that
  log bodies more reliably than headers.
- `event_type`: `sale`, `refund`, or `void`.
- `source_channel`: usually `pos`.
- `payload.merchant.name`: merchant display name.
- `payload.receipt.number`: receipt number, unless a stable idempotency key is
  supplied.
- `payload.receipt.purchase_at`: original POS/EFTPOS completed tender timestamp
  as a date-time string. Do not use bridge send time.
- `payload.receipt.total_inc_gst_cents`: total in cents.
- `payload.receipt.gst_cents` and `payload.receipt.subtotal_ex_gst_cents`.
  Amount fields must be integer cents such as `36000`, not dollar decimals
  such as `360.00` or fractional cents.
- `payload.receipt.tender_status`: final tender state, such as `completed`,
  `refunded`, or `voided`.
- `payload.receipt.payment_reference`: stable EFTPOS/POS tender reference,
  authorization id, transaction id, or cash-drawer sequence.
- `payload.receipt.payment_method`: card, cash, account, or the POS tender type.
- `payload.receipt.payment_last4`: optional card last four only. Masked values
  such as `****1234` are normalized to `1234`; full card numbers are rejected.
- `payload.line_items`: required for `source_channel: "pos"`; the line totals
  must match the receipt total and the line GST values must sum to
  `payload.receipt.gst_cents`. Non-POS legacy channels may omit lines and be
  stored as evidence, but merchant POS integrations should not.

Example:

```json
{
  "identity_token": "rhp_1234abcd.<secret>",
  "idempotency_key": "payment-evt-100042",
  "event_type": "sale",
  "source_channel": "pos",
  "payload": {
    "merchant": {
      "name": "Bunnings Trade",
      "abn": "12123456789",
      "external_id": "store-017"
    },
    "receipt": {
      "number": "POS-2026-0001",
      "event_type": "sale",
      "external_event_id": "payment-evt-100042",
      "purchase_at": "2026-06-28T03:00:00Z",
      "currency": "AUD",
      "subtotal_ex_gst_cents": 32727,
      "gst_cents": 3273,
      "total_inc_gst_cents": 36000,
      "tender_status": "completed",
      "payment_method": "card",
      "payment_last4": "1234",
      "payment_reference": "eftpos-auth-777331",
      "terminal_id": "TERM-04",
      "store_id": "STORE-017"
    },
    "classification": {
      "business_use": "business",
      "deductibility": "deductible",
      "job_reference": "JOB-1042",
      "sync_targets": ["xero", "myob"]
    },
    "line_items": [
      {
        "description": "Timber",
        "quantity": 2,
        "unit_price_cents": 15000,
        "total_inc_gst_cents": 30000,
        "gst_cents": 2727
      },
      {
        "description": "Fasteners",
        "quantity": 1,
        "unit_price_cents": 6000,
        "total_inc_gst_cents": 6000,
        "gst_cents": 546
      }
    ]
  },
  "sync_targets": ["xero", "myob"]
}
```

## Reliability Rules

- Use cents as integers. Do not send decimal currency amounts.
- POS payloads must include `payload.merchant.name`, supplied GST cents,
  supplied subtotal cents, `payload.receipt.purchase_at`, and
  `payload.receipt.payment_reference`. Looplet rejects missing merchant names,
  missing payment references, missing or invalid purchase timestamps, missing GST,
  missing subtotal, and
  subtotal + GST values that do not reconcile to the receipt total.
- Never send a full card number. `payload.receipt.payment_last4` may contain
  only the final four digits or a masked value that contains exactly four
  digits. Looplet rejects full PANs before storage.
- Send `sale` only after completed tender. Send `refund` only after the refund
  is final. Send `void` only after the sale is voided/cancelled.
- Every `refund` or `void` event must include `original_receipt_number` or
  `original_external_event_id`, and that reference must resolve to an existing
  Looplet sale event for the same organization/merchant. Unresolved refund/void
  references are rejected instead of being stored as unlinked evidence.
- Always send a stable `Idempotency-Key`. Use the POS payment id, receipt event
  id, or transaction id. Do not use a random UUID generated per retry.
- If the body also contains `idempotency_key` or
  `payload.receipt.idempotency_key`, it must exactly match the
  `Idempotency-Key` header.
- Retry only with the same idempotency key and the same payload.
- A repeated idempotency key with changed receipt number, purchase timestamp,
  total, payment reference, GST/subtotal split, terminal, store, or merchant
  facts is rejected as unsafe key reuse.
- Keep payloads under 128 KB and line item count at 100 or fewer.
- Every POS line item must include `gst_cents`; line GST must reconcile to the
  receipt GST total.
- Treat `200` with `"duplicate": true` as success.
- Treat `400`, `401`, and `403` as configuration or payload errors; do not keep
  retrying without a fix.
- Retry `429` and `5xx` with exponential backoff and a local dead-letter queue.
- Refund/void events are evidence-only for now; they do not create positive
  bills or downstream accounting sync jobs until the credit workflow exists.

## Response Contract

Success:

```json
{
  "ok": true,
  "duplicate": false,
  "event_type": "sale",
  "receipt_event_id": "<uuid>",
  "related_receipt_event_id": null,
  "bill_id": "<uuid-or-null>",
  "audit_package_id": "<uuid>",
  "sync_jobs": [
    { "id": "<uuid>", "provider": "xero", "status": "pending" }
  ],
  "classification": {
    "business_use": "business",
    "deductibility_status": "deductible",
    "job_id": "<uuid-or-null>",
    "job_reference": "JOB-1042",
    "gst_estimated": false
  }
}
```

Refund event:

```json
{
  "identity_token": "rhp_1234abcd.<secret>",
  "idempotency_key": "refund-evt-100043",
  "event_type": "refund",
  "source_channel": "pos",
  "payload": {
    "merchant": { "name": "Bunnings Trade", "abn": "12123456789" },
    "receipt": {
      "number": "POS-2026-0001-R",
      "event_type": "refund",
      "external_event_id": "refund-evt-100043",
      "original_receipt_number": "POS-2026-0001",
      "original_external_event_id": "payment-evt-100042",
      "purchase_at": "2026-06-28T03:20:00Z",
      "currency": "AUD",
      "subtotal_ex_gst_cents": 5455,
      "gst_cents": 545,
      "total_inc_gst_cents": 6000,
      "tender_status": "refunded",
      "payment_method": "card",
      "payment_reference": "eftpos-refund-777332"
    },
    "line_items": [
      {
        "description": "Fasteners returned",
        "quantity": 1,
        "unit_price_cents": 6000,
        "total_inc_gst_cents": 6000,
        "gst_cents": 545
      }
    ]
  }
}
```

Duplicate retry:

```json
{
  "ok": true,
  "duplicate": true,
  "receipt_event_id": "<same uuid>",
  "bill_id": "<same uuid-or-null>",
  "sync_jobs": [
    { "id": "<uuid>", "provider": "xero", "status": "pending" }
  ]
}
```

## Bridge Design

Use a bridge when the POS cannot call Looplet directly.

```text
POS native event/export
        |
        v
Bridge adapter
  - reads POS event
  - maps vendor fields to Looplet payload
  - chooses stable idempotency key
  - signs request with Looplet API key
  - retries transient failures
  - writes dead-letter queue on failure
        |
        v
Looplet receipt-webhook
```

Minimum bridge requirements:

- Runs on Node 20+, a POS plugin runtime, a vendor cloud function, or an
  equivalent HTTPS-capable integration platform.
- Has outbound HTTPS access to `https://<supabase-project>.supabase.co`.
- Stores `LOOPLET_POS_API_KEY` securely. `LOOPLET_RECEIPT_IDENTITY_TOKEN` is a
  fallback/readiness token only; live POS exports should include the scanned
  customer `identity_token` on each receipt.
- Persists failed sends locally or in the integration platform's retry queue.
- Logs the POS event id, HTTP status, Looplet `receipt_event_id`, and error body.
- Treats permanent setup gaps as non-retryable operator actions. For example,
  missing job attachment for Xero or an unconfigured MYOB adapter should land as
  `skipped`, not an endlessly retried `failed` job.

See [`../examples/pos-bridge`](../examples/pos-bridge) for a small Node bridge
that implements the expected headers, retry behavior, and dead-letter queue.
It supports both one-shot sends and an inbox watcher:

```bash
node bridge.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env --watch receipts-inbox
node bridge.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env --watch-once receipts-inbox
```

For a Windows back-office POS machine, install that bridge as a scheduled task:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\package-windows-bridge.ps1 -OutputDir .\dist
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows-task.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows-task.ps1 -Apply
```

The package command creates a merchant-facing ZIP with a manifest and hashes.
The first installer command is a dry run. The applied install copies the bridge into
`C:\ProgramData\Looplet\pos-bridge`, creates an env template and inbox folder,
hardens the env file ACL so only the installing Windows account,
Administrators, and SYSTEM can read it, copies the pilot-evidence, acceptance,
and verifier tools, and registers a once-per-minute task that calls
`run-watch-once.ps1`. That wrapper runs the bridge `--watch-once` pass and
writes stdout/stderr plus the exit code into
`C:\ProgramData\Looplet\pos-bridge\logs`. The runner redacts Looplet secrets and
protects each daily log file. Use `-NoRegister` for test installs where you only
want the files and readiness check.

In the app, open Receipt Hub and use **POS bridge setup** to generate the
one-time bridge config. That creates a `write:receipts` API key and POS receipt
identity token, then prints the env file contents once for the installer.

For a field pilot, generate a printable scan pass from that issued receipt
identity:

```powershell
node C:\ProgramData\Looplet\pos-bridge\pilot-pass.mjs `
  --env-file C:\ProgramData\Looplet\pos-bridge.env `
  --output C:\ProgramData\Looplet\looplet-pilot-pass.html `
  --business-name "Pilot Trade Pty Ltd" `
  --pilot-id "pilot-001"
```

The generated HTML contains a Code 128 barcode plus the raw `rhp_...` token.
It is intentionally sensitive: use it to prove the cashier/POS can capture the
Looplet identity before tender, but do not attach it to support tickets or logs.

If support is configuring the bridge manually from separately issued one-time
credentials, generate the bridge env file without printing the secrets:

```powershell
node C:\ProgramData\Looplet\pos-bridge\configure-env.mjs `
  --output C:\ProgramData\Looplet\pos-bridge.env `
  --webhook-url https://<supabase-project>.supabase.co/functions/v1/receipt-webhook `
  --api-key llp_<prefix>.<secret> `
  --identity-token rhp_<prefix>.<secret> `
  --inbox-dir C:\ProgramData\Looplet\receipts-inbox
```

The writer validates the endpoint and token shapes, protects the env file after
writing it, refuses accidental overwrites unless `--force` is supplied, and
prints only redacted token prefixes.

The watch-folder mode is the simplest business pilot when a POS can export a
completed receipt JSON file but cannot call Looplet directly. The POS or local
adapter writes `*.json` into the inbox; the bridge moves accepted files to
`sent`, transient failures to `queued`, and permanent contract/configuration
failures to `rejected` plus a dead-letter JSONL file.
When a transient queued receipt later flushes successfully, the bridge moves its
queued archive into `sent`, so a clean status means no pending retry archive is
left behind.
If a queued receipt later receives a permanent rejection, the bridge moves the
queued archive into `rejected` and appends the rejection to the dead-letter
JSONL file.
The bridge protects raw receipt archives, retry queue files, and dead-letter
files when it creates, rewrites, or moves them. Archived and queued receipts can
retain the scanned receipt identity and itemised basket until support/audit or
retry work is complete; dead-letter rows are redacted support records.
On Windows, `--watch-once` can be run every minute from Task Scheduler, using a
protected env file for the Looplet API key and optional fallback receipt identity
token. The Windows installer protects that file automatically and reapplies the
ACL if the installer is run again.
When `--env-file` is supplied to bridge/readiness/go-live commands, that file is
the source of truth. Inherited stale `LOOPLET_*` shell variables are overridden
so a pilot does not accidentally use an old endpoint, API key, or organization.

For CSV/file-export pilots, one CSV file should represent exactly one receipt
with one row per line item. Receipt-level fields must stay identical across all
rows: merchant, receipt number, POS event id, purchase time, tender status,
payment reference, totals, original-sale references, and sync targets. Refund
and void CSV exports must include `original_receipt_number` or
`original_external_event_id` so Looplet can link them back to the sale. The
adapter rejects mixed metadata instead of building a receipt from ambiguous
export rows.

The bridge also waits for inbox files to settle before reading them. Keep
`LOOPLET_BRIDGE_MIN_FILE_AGE_MS=1000` unless the POS/export job writes to a
temporary name and atomically renames the completed `*.json` file into the
inbox. This prevents partially written receipts from being dead-lettered as bad
JSON.

If a local retry queue file is damaged, the bridge quarantines the malformed
JSONL row into the dead-letter file and continues flushing valid queued
receipts. The quarantine summary is redacted so Looplet keys and receipt
identity tokens are not printed into support evidence. Queue and dead-letter
parent directories are created automatically, so installs can point those files
at a protected operations folder such as `C:\ProgramData\Looplet`.

During pilot support, run the bridge status report:

```powershell
node C:\ProgramData\Looplet\pos-bridge\status.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env
```

It does not send a receipt and it redacts payloads/secrets. It reports pending
inbox files, stuck processing files, queued and rejected watch-folder files,
retry-queue rows, dead-letter rows, JSONL parse errors, last-error summaries,
and the latest scheduled-task log written by `run-watch-once.ps1` so the
business can tell whether receipts are flowing or require operator action. A
non-zero exit means the bridge has queued, rejected, dead-lettered, damaged
queue/dead-letter, or stuck work, a failed last run, or a stale/missing
scheduled-task log.
For `bridge_watch_folder` and `bridge_csv_export` go-live evidence, the verifier
also requires that scheduled-task log check to be configured and healthy, and
the status evidence must prove the protected env file plus local
log/state/archive files are not readable by broad local users. Direct POS
webhooks do not need a local scheduler log.

Before sending a real receipt, probe the POS API key and `write:receipts` scope:

```powershell
node C:\ProgramData\Looplet\pos-bridge\credential-probe.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env
```

This intentionally uses an invalid receipt identity. Success is a `400`
identity rejection, which proves the endpoint, API key, and receipt write scope
worked far enough to reject the identity before any receipt is persisted.

For watch-folder and CSV bridge pilots, run the non-sending retry drill from the
installed bridge before go-live:

```powershell
node C:\ProgramData\Looplet\pos-bridge\bridge-retry-drill.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env --sample C:\ProgramData\Looplet\field-sale.json
```

The drill temporarily points the installed bridge at a local endpoint that
returns `503` before recovering. It proves transient failures retry, queue,
flush after recovery, do not dead-letter the receipt, and do not leak Looplet
secrets. It does not send a receipt to Looplet.

For a non-sending support preflight, run:

```powershell
node C:\ProgramData\Looplet\pos-bridge\pilot-evidence.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env --output C:\ProgramData\Looplet\pos-pilot-evidence.json
```

That command is diagnostic only and non-receipt-sending by default: it runs readiness, status, a
non-persistent credential/scope probe, and sample contract validation. The
credential probe intentionally uses an invalid receipt identity; a correctly
provisioned `write:receipts` key reaches the webhook and gets rejected before
any receipt is stored. It is not go-live approval.

For a real business pilot, do not use only the bundled samples. Copy
`pilot-site.example.json` to a business-specific site manifest, export or
convert one real POS sale, refund, and void payload, then run:

The merchant ZIP also includes `PILOT_CHECKLIST.md`; use it as the operator
checklist for fit check, install, field sample capture, acceptance, verifier,
and handover.
The site manifest must record `merchant_name`, `identity_capture_method`,
`receipt_trigger`, `receipt_source_format`, and
`field_sample_capture_method`. Those values document the rewards-style path:
which POS merchant/trading name appears on field payloads, how the Looplet
identity is captured, which completed POS event triggers the send, which
receipt data source the connector consumes, and how the real sale/refund/void
field files were captured. An EFTPOS-only feed is not enough unless the
connector also matches it back to the POS basket and receipt lines. The
verifier also checks that `connector_mode`, `receipt_source_format`, and
`field_sample_capture_method` are compatible, so a direct webhook cannot claim
CSV-export input and a CSV bridge cannot claim direct webhook capture.

```powershell
node C:\ProgramData\Looplet\pos-bridge\go-live.mjs `
  --env-file C:\ProgramData\Looplet\pos-bridge.env `
  --site-file C:\ProgramData\Looplet\pos-pilot-site.json `
  --fit-profile C:\ProgramData\Looplet\pos-integration-profile.json `
  --sale C:\ProgramData\Looplet\field-sale.json `
  --refund C:\ProgramData\Looplet\field-refund.json `
  --void C:\ProgramData\Looplet\field-void.json `
  --output C:\ProgramData\Looplet\pos-pilot-evidence.json
```

That records the business/POS/install context, validates the actual POS payload
shape, uses those same field samples for the acceptance send, then immediately
runs the strict verifier against the same local files. The bundled
`sample-receipt.json`, `sample-refund.json`, and `sample-void.json` are local
contract examples only and are rejected as go-live field samples. They are also
rejected by content fingerprint, so copying a bundled sample to a field-looking
filename does not satisfy go-live evidence.
The verifier also rejects missing or invalid `merchant_name`,
`identity_capture_method`, `receipt_trigger`, `receipt_source_format`, and
`field_sample_capture_method`, so the evidence has to prove a named POS checkout
trigger with a captured Looplet identity rather than a loose payment-terminal
amount or hand-built JSON. It also rejects incompatible connector/source/capture
pairings.
The go-live runner checks field sample POS `merchant.name`, refund/void original
references, and `purchase_at` timestamps against the site manifest and sale
sample before sending acceptance receipts. It skips acceptance if the site
manifest or field samples fail preflight validation.
For watch-folder and CSV bridge pilots, `status.mjs` must also report
`local_file_protection.ok: true`, proving the business env file, scheduled-task
log, retry/dead-letter state, and raw receipt archives are filesystem-protected.

For support/debug when an evidence file already exists, verify that it is strong
enough for go-live:

```powershell
node C:\ProgramData\Looplet\pos-bridge\verify-pilot-evidence.mjs C:\ProgramData\Looplet\pos-pilot-evidence.json --sale C:\ProgramData\Looplet\field-sale.json --refund C:\ProgramData\Looplet\field-refund.json --void C:\ProgramData\Looplet\field-void.json
```

The verifier rejects preflight-only evidence, acceptance without persistence
readback, leaked Looplet secrets, missing credential/scope proof, missing
duplicate/refund/void checks, missing refund/void duplicate retry checks, and
missing negative-control checks. It also requires receipt-webhook API request
log proof for accepted calls and validation rejections. For watch-folder and
CSV bridge pilots it requires readiness to verify the installed
`MANIFEST.json`, so a tampered or incomplete installed bridge cannot pass
go-live evidence. It also requires the non-sending retry drill to prove outage
queueing and recovery flush, plus local file-protection proof from `status.mjs`.
It rejects go-live evidence without the site manifest, with placeholder site values, with a placeholder organization id,
without contract-valid field sale/refund/void POS samples, without a declared
merchant name / identity capture method / completed receipt trigger / source
format / field capture method, when a field sample's POS `merchant.name` does
not match the site manifest `merchant_name`, when refund/void field samples do
not point back to the sale field sample, or when a field sample's POS
`purchase_at` falls outside the site manifest pilot window.
Running without `--sale`, `--refund`, and `--void` field files fails by default;
`--evidence-only` is diagnostic-only and is not go-live approval.

After verification passes, generate a redacted support report:

```powershell
node C:\ProgramData\Looplet\pos-bridge\pilot-report.mjs C:\ProgramData\Looplet\pos-pilot-evidence.json --output C:\ProgramData\Looplet\pos-pilot-report.json --markdown C:\ProgramData\Looplet\pos-pilot-report.md
```

The report summarizes the merchant/site, connector mode, field capture method,
safe field-sample fingerprints, acceptance controls, persistence/API-log proof,
and local bridge health. It fails preflight-only evidence and evidence files
that contain unredacted Looplet API keys or receipt identity tokens.

Then verify the complete handover bundle:

```powershell
node C:\ProgramData\Looplet\pos-bridge\pilot-bundle.mjs `
  --evidence C:\ProgramData\Looplet\pos-pilot-evidence.json `
  --site C:\ProgramData\Looplet\pos-pilot-site.json `
  --fit C:\ProgramData\Looplet\pos-integration-profile.json `
  --sale C:\ProgramData\Looplet\field-sale.json `
  --refund C:\ProgramData\Looplet\field-refund.json `
  --void C:\ProgramData\Looplet\field-void.json `
  --report-json C:\ProgramData\Looplet\pos-pilot-report.json `
  --report-markdown C:\ProgramData\Looplet\pos-pilot-report.md `
  --output C:\ProgramData\Looplet\pos-pilot-bundle.json
```

This reruns strict verification with the field files, checks the archived site
manifest and integration fit profile match the evidence/report, and rejects
leaked support-report secrets.

The final completion audit makes the local/prod boundary explicit. Generate the
local proof artifact with:

```powershell
npm run pos:full-trial:artifact
```

Archive `.claude\scratch\pos-full-trial.json` as `pos-full-trial.json`;
without a real merchant pilot bundle, the audit should only report local
readiness:

```powershell
node C:\ProgramData\Looplet\pos-bridge\completion-audit.mjs `
  --local-json C:\ProgramData\Looplet\pos-full-trial.json
```

Expected result before the field pilot: `ok: true`, `local_ready: true`, and
`production_ready: false`. Before merchant handover, require production:

```powershell
node C:\ProgramData\Looplet\pos-bridge\completion-audit.mjs `
  --require-production `
  --local-json C:\ProgramData\Looplet\pos-full-trial.json `
  --evidence C:\ProgramData\Looplet\pos-pilot-evidence.json `
  --site C:\ProgramData\Looplet\pos-pilot-site.json `
  --fit C:\ProgramData\Looplet\pos-integration-profile.json `
  --sale C:\ProgramData\Looplet\field-sale.json `
  --refund C:\ProgramData\Looplet\field-refund.json `
  --void C:\ProgramData\Looplet\field-void.json `
  --report-json C:\ProgramData\Looplet\pos-pilot-report.json `
  --report-markdown C:\ProgramData\Looplet\pos-pilot-report.md `
  --output C:\ProgramData\Looplet\completion-audit.json
```

Expected result for handover: `ok: true`, `local_ready: true`,
`production_ready: true`.

## Acceptance Checklist

Before go-live for a merchant:

- Run `npm run pos:validate`, `npm run pos:trial`, and
  `npm run pos:watch-trial` against the connector build.
- Run `npm run pos:csv-trial` if the merchant pilot uses POS CSV/file export
  rather than direct webhooks; this proves the CSV adapter rejects mismatched
  totals and emits Looplet-shaped JSON for the bridge.
- Run `npm run pos:pilot-kit-trial` to prove the pilot-kit generator imports the
  same integration-fit logic, writes a site-manifest template and runbook, and
  rejects an EFTPOS-only profile before any pilot artifacts are generated.
- Run `npm run pos:pilot-bundle-trial` to prove the final archive verifier
  accepts a complete go-live bundle and rejects mismatched site manifests or
  leaked support-report secrets.
- Run `npm run pos:completion-audit-trial` to prove the final completion audit
  reports local readiness without overstating production readiness, rejects
  `--require-production` without real pilot evidence, and fails weak local
  proof.
- Run `npm run pos:readiness-trial` to prove the readiness checker, then run
  `npm run pos:readiness -- --env-file <business-env-file>` at the business or
  pilot environment to confirm Node.js, installed operator-tool completeness
  including the CSV adapter, config shape, inbox write access, sample contract
  validity, and outbound webhook reachability without sending a receipt.
  If the env file omits `LOOPLET_RECEIPT_IDENTITY_TOKEN`, pass `--sample` with a
  field receipt/export that includes the scanned per-receipt `identity_token`.
- Optionally run `node pilot-evidence.mjs --env-file <business-env-file> --output <evidence.json>`
  to collect readiness, bridge status, the non-persistent credential/scope
  probe, and sample contract validation in one redacted diagnostic artifact.
  This does not approve go-live.
- Copy `pilot-site.example.json`, fill in the business, POS merchant/trading
  name, connector mode, identity capture method, completed receipt trigger,
  receipt source format, install machine, operator, pilot window, and Looplet
  organization id.
- Export or convert one real POS sale, refund, and void JSON payload from the
  business pilot. For CSV/file-export pilots, run `csv-adapter.mjs` first and
  use the generated JSON files as `--sale`, `--refund`, and `--void`.
  The field sample POS `merchant.name` values must match the site manifest
  `merchant_name`; refund/void original references must point to the sale field
  sample; and `purchase_at` timestamps must fall inside the pilot window
  declared in the site manifest.
- Run `npm run pos:acceptance-trial` to prove the acceptance runner itself.
- Run `npm run pos:pilot-go-live-trial` to prove the full local evidence flow:
  readiness, local file-protection proof, credential probe, acceptance,
  persistence readback, and verifier.
- Run `npm run pos:receipt-hub-visual-smoke` for browser proof of the
  authenticated Receipt Hub surface. The smoke harness renders the real
  `ReceiptHubPage` with mocked authenticated org/receipt state, clicks
  `Generate config` and `Generate pass`, checks for browser console/page
  errors, verifies keyboard reachability for the main POS controls, checks
  desktop/mobile horizontal overflow, and writes desktop and mobile screenshots under
  `.claude/scratch/receipt-hub-visual-smoke/`.
  `npm run pos:full-trial` includes this visual smoke.
- Run `npm run pos:receipt-hub-cross-browser-smoke` when Chromium and Firefox
  Playwright browsers are installed. It runs the same authenticated desktop and
  mobile smoke in both engines. WebKit is not part of the default command
  because Windows agents often do not have that browser binary installed.
- Run `go-live.mjs` against the staging or pilot Looplet endpoint with
  `LOOPLET_ACCEPTANCE_CONFIRM_LIVE=1`, `--site-file`, `--fit-profile`,
  `--sale`, `--refund`, `--void`, and `--output`; archive the generated
  evidence JSON.
  The runner collects acceptance evidence, then immediately runs the strict
  verifier against the same local field files. The acceptance step proves sale,
  duplicate sale retry, refund link, duplicate refund
  retry, void link, duplicate void retry, changed-payload idempotency-key
  rejection, changed GST/subtotal idempotency-key rejection, changed
  purchase-at idempotency-key rejection, conflicting
  idempotency header/body rejection, missing merchant
  rejection, missing payment reference rejection, full-card payment_last4 rejection,
  missing purchase-at rejection, bad purchase-at rejection, missing GST rejection,
  missing subtotal rejection, bad GST-subtotal rejection, pending-tender rejection,
  missing original-sale rejection, bad-line-total rejection, bad-line-GST
  rejection, invalid API-key rejection, and the non-local safety guard. With `LOOPLET_ACCEPTANCE_SERVICE_ROLE_KEY`
  set for a staging or pilot project, it also reads back persisted receipt
  events, line items, audit packages, sync jobs, API request logs, and confirms
  rejected negative controls did not persist.
  When the field sale/refund/void samples include the scanned `identity_token`,
  the go-live acceptance stage does not require `LOOPLET_RECEIPT_IDENTITY_TOKEN`
  in the env file; that env token is only a fallback for samples without a
  per-receipt identity.
- For support/debug, run `node verify-pilot-evidence.mjs <evidence.json> --sale <field-sale.json>
  --refund <field-refund.json> --void <field-void.json>` and require
  `ok: true` before treating an existing evidence bundle as go-live ready.
  The verifier summary includes redacted SHA-256 fingerprints for the sale,
  refund, and void field samples, so support can match the evidence to the
  merchant payload files without exposing receipt identity tokens.
  Recompute a local file fingerprint with
  `node sample-fingerprint.mjs <field-sale.json> --expected <sale-fingerprint>`.
  The verifier reconciles the whole evidence bundle against all local field
  files. The standalone `reconcile-pilot-evidence.mjs` command is available for
  support/debug sessions. Reconciliation checks both the redacted full-sample
  fingerprint and the identity-stripped content fingerprint, so a missing or
  altered content fingerprint cannot bypass the bundled-sample/content check.
  `--evidence-only` is a diagnostic mode, not a go-live verifier run.
- Generate and archive the redacted report with
  `node pilot-report.mjs <evidence.json> --output <report.json> --markdown <report.md>`
  after verifier success.
- Send one valid receipt and confirm `ok: true`, `duplicate: false`.
- Send the same receipt again and confirm `ok: true`, `duplicate: true` with the
  same `receipt_event_id`.
- Send receipts with bad line totals and bad line GST totals and confirm `400`
  responses.
- Send with an invalid API key and confirm a `401` response.
- Confirm the receipt appears in Receipt Hub for the right organization only.
- Confirm the generated bill, line items, audit package, and sync job match the
  POS receipt.
- Confirm bridge retry/dead-letter behavior by temporarily blocking the network.
