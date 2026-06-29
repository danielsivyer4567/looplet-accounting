# Looplet POS Receipt Integration Design

This design is the handover sheet for a merchant, POS vendor, or business IT
owner. The system works like a supermarket rewards card flow: the customer
identifies themselves at checkout with a Looplet Receipt Pass, and the completed
POS receipt event sends the itemised basket to Looplet.

EFTPOS terminal events alone are not enough. A card terminal usually has the
amount, tender result, and payment reference, but not the receipt lines, GST
split, merchant receipt number, refund/void original-sale reference, or
customer-scanned Looplet receipt identity. EFTPOS data is usable only when the
connector can match the payment back to the completed POS basket.

## Target Flow

1. Customer scans/taps a Looplet Receipt Pass, barcode, QR code, NFC pass, tag,
   or POS customer account mapping before payment.
2. POS finalises the sale, refund, or void after completed tender.
3. POS, plugin, middleware, or the Looplet bridge builds a receipt payload with
   `identity_token`, merchant, receipt number, `purchase_at`, payment reference,
   subtotal/GST/total cents, and line items.
4. Connector sends the payload to Looplet with a stable `Idempotency-Key`.
5. Looplet validates the receipt, rejects bad or duplicate-changed payloads,
   creates the receipt event/bill/audit package, and queues accounting sync.

## Supported Connector Modes

### Direct POS Webhook/API

Use this when the POS can send custom HTTPS calls with custom headers and a JSON
body mapping.

- Configure endpoint:
  `https://<supabase-project>.supabase.co/functions/v1/receipt-webhook`
- Configure headers:
  - `Authorization: Bearer llp_<prefix>.<secret>`
  - `Idempotency-Key: <stable POS receipt/payment event id>`
  - `Content-Type: application/json`
- Store the Looplet API key in the POS/vendor secret store.
- No Looplet bridge install is required, but the pilot still needs the operator
  tools to run readiness, go-live evidence, report, bundle, and completion audit.

### Looplet Bridge Watch Folder

Use this when the POS can export completed JSON receipt files but cannot call
Looplet directly.

- Install the Looplet bridge package on a back-office PC/server.
- Required runtime: Node.js 20+, PowerShell, Windows Task Scheduler, outbound
  HTTPS to the Supabase project.
- Configure the POS export job to write completed receipt JSON into the bridge
  inbox.
- Protect `C:\ProgramData\Looplet\pos-bridge.env`; it contains the Looplet API
  key and optional fallback/readiness receipt token.
- The scheduled task scans the inbox, retries transient failures, queues outage
  receipts, and moves permanent failures to rejected/dead-letter files.

### Looplet CSV Bridge

Use this when the POS exports completed CSV rows. One receipt is represented by
one CSV file with one row per line item.

- Same runtime/install requirements as the watch-folder bridge.
- Run `csv-adapter.mjs` to convert sale/refund/void CSV exports to Looplet JSON
  before the bridge sends them.
- CSV exports must include a stable event id, receipt number, payment reference,
  subtotal/GST/total cents, line items, and refund/void original-sale reference.

### Custom Middleware Or POS Plugin

Use this when a vendor plugin SDK, cloud event stream, API poller, Zapier/Make
style connector, or custom service sits between the POS and Looplet.

- Store the Looplet API key in the middleware/plugin secret store.
- Send only completed/final sale, refund, and void events.
- Preserve a stable idempotency key across retries.
- Include the scanned/mapped Looplet identity in every receipt payload.

## Required Payload Evidence

Every production pilot must capture one real business POS field sample for each
event type:

- completed sale
- completed refund
- completed void/cancellation

Each sample must include:

- customer-scanned `identity_token`
- stable `idempotency_key`
- `event_type`
- merchant name matching `pos-pilot-site.json`
- receipt number
- completed tender timestamp as `purchase_at`
- completed/final tender status
- integer cents for subtotal, GST, and total
- itemised lines whose totals reconcile to the receipt
- payment reference or POS event id
- original sale receipt number or original POS event id for refund/void

The bundled sample files are for local trials only. Go-live evidence rejects
renamed bundled samples and requires real field-sample fingerprints.

## Business-Side Installation Matrix

| POS capability | Business install |
| --- | --- |
| Custom webhook/API with headers and JSON mapping | Configure POS endpoint, headers, payload mapping, and secret store |
| JSON export only | Install Looplet bridge package and point POS export to bridge inbox |
| CSV export only | Install Looplet bridge package and run CSV adapter before sending |
| Plugin SDK/vendor cloud/API polling | Deploy middleware/plugin and configure Looplet endpoint/key |
| EFTPOS-only amount feed | Not sufficient unless joined back to the POS basket and receipt lines |

## Pilot Proof Gates

Before claiming the receipt system is ready, run:

1. `integration-fit.mjs` against the business POS capabilities.
2. `pilot-kit.mjs` to generate the site manifest/runbook/commands.
3. `readiness.mjs`, `credential-probe.mjs`, and for bridge installs
   `status.mjs` plus `bridge-retry-drill.mjs`.
4. `go-live.mjs --preflight-only` against the exact real sale/refund/void field
   samples, site manifest, and fit profile. This must be non-sending and pass
   before acceptance.
5. `go-live.mjs` without `--preflight-only` against a staging or pilot Looplet
   project.
6. `pilot-report.mjs` and `pilot-bundle.mjs`.
7. `completion-audit.mjs --require-production` with Looplet's archived
   `pos-full-trial.json` plus the real merchant pilot bundle.

The final completion audit must report `ok: true`, `local_ready: true`, and
`production_ready: true`. Without real merchant sale/refund/void evidence, it
must fail.
