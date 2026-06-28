# Looplet POS Receipt Pilot Checklist

Use this checklist before claiming a merchant POS receipt integration is ready
for go-live. The pilot must use the business's real POS/export path and real
field sale, refund, and void payloads. The bundled sample files are only for
local testing.

## 1. Business Install

- Confirm the POS integration mode:
  - direct POS webhook/API
  - POS plugin/app
  - local bridge watch folder
  - local bridge CSV export
  - custom cloud middleware
- Run the POS capability fit check before choosing the connector path:

```powershell
node C:\ProgramData\Looplet\pos-bridge\integration-fit.mjs C:\ProgramData\Looplet\pos-integration-profile.json
```

  Start from `integration-fit.example.json`. Expected result before install:
  `ok: true`, a concrete `recommendation.connector_mode`, a matching
  `recommendation.receipt_source_format`, a matching
  `recommendation.field_sample_capture_method`, and no blockers. Do not proceed
  with an EFTPOS-only path unless it also matches back to the POS basket,
  receipt number, GST, and line items.
- Generate the pilot kit from the approved integration profile:

```powershell
node C:\ProgramData\Looplet\pos-bridge\pilot-kit.mjs C:\ProgramData\Looplet\pos-integration-profile.json --output-dir C:\ProgramData\Looplet\pilot-kit
```

  Copy `pos-pilot-site.template.json` to `pos-pilot-site.json`, then replace
  every placeholder with real business, POS, operator, machine, organization,
  and pilot-window details. Keep `pos-integration-profile.json`,
  `pos-integration-fit.json`, `PILOT_RUNBOOK.md`, and `go-live-command.ps1`
  with the evidence bundle.
- Confirm and record the checkout trigger in `pos-pilot-site.json`:
  - `identity_capture_method`: how the cashier/POS captures the Looplet identity
    (`barcode_scan`, `qr_scan`, `nfc_pass`, `pos_customer_account`,
    `middleware_mapping`, or `manual_pilot_scan`)
  - `receipt_trigger`: the completed POS event that causes the send
    (`pos_completed_tender`, `pos_receipt_finalized`, `pos_export_completed`, or
    `middleware_completed_tender`)
  - `receipt_source_format`: the data shape consumed by the connector
    (`direct_json_webhook`, `pos_json_export`, `pos_csv_export`,
    `vendor_api_poll`, or `custom_middleware`)
  - `field_sample_capture_method`: how the sale/refund/void field files were
    captured (`pos_webhook_capture`, `pos_native_json_export`,
    `pos_native_csv_export`, `pos_vendor_api_pull`, or `middleware_capture`)
  The verifier rejects incompatible combinations, such as `direct_webhook` with
  `pos_csv_export`, `bridge_watch_folder` with anything except
  `pos_json_export`, `bridge_csv_export` with anything except
  `pos_csv_export`, or `pos_json_export` with a CSV/webhook capture method.
  EFTPOS-only data is not enough unless the connector also matches it back to
  the POS basket and receipt lines.
- Confirm the business machine/runtime:
  - Node.js 20+ for the local bridge, or equivalent vendor/plugin runtime
  - outbound HTTPS to `https://<supabase-project>.supabase.co`
  - no inbound firewall rule required
- Install or configure the connector.
- Store secrets only in the POS connector secret store or protected env file:
  - `LOOPLET_POS_API_KEY`
  - optional fallback/readiness `LOOPLET_RECEIPT_IDENTITY_TOKEN`
- Treat the protected env file passed with `--env-file` as authoritative; stale
  inherited `LOOPLET_*` shell variables must not control the bridge or go-live
  command.
- Confirm the live POS/export captures the customer-scanned Looplet
  `identity_token` on each sale/refund/void receipt.
- Generate a cashier-scannable pilot pass from the issued receipt identity and
  test that the POS captures the scanned value before payment:

```powershell
node C:\ProgramData\Looplet\pos-bridge\pilot-pass.mjs `
  --env-file C:\ProgramData\Looplet\pos-bridge.env `
  --output C:\ProgramData\Looplet\looplet-pilot-pass.html `
  --business-name "<business name>" `
  --pilot-id "<pilot id>"
```

  The HTML pass contains the scannable `rhp_...` token. Treat it as sensitive
  pilot credential material.
- Run readiness:

```powershell
node C:\ProgramData\Looplet\pos-bridge\readiness.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env
```

Expected result: `ok: true`, Node 20+, installed operator tools complete
including the CSV adapter, inbox writable, sample contract valid, and endpoint
reachable. Do not use `--skip-network` for go-live evidence.
When installed from the merchant ZIP, readiness must also report
`checks.bridge_files.manifest.ok: true`; this proves the installed bridge files
still match the package manifest.

- Run the credential probe:

```powershell
node C:\ProgramData\Looplet\pos-bridge\credential-probe.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env
```

Expected result: the probe reports that the POS API key and `write:receipts`
scope work, and no receipt is persisted.

- For watch-folder and CSV bridge pilots, run the non-sending retry drill:

```powershell
node C:\ProgramData\Looplet\pos-bridge\bridge-retry-drill.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env --sample C:\ProgramData\Looplet\field-sale.json
```

Expected result: `ok: true`, `queued_after_outage: true`,
`queue_flushed_after_recovery: true`, and `accepted_after_recovery: true`.
The drill uses a temporary local 503-then-200 endpoint and does not send a
receipt to Looplet.

## 2. POS Field Samples

Collect one real payload from the business POS path for each event type:

- completed sale
- completed refund
- completed void/cancellation

Each payload must include:

- customer-scanned `identity_token` for the sale/refund/void receipt
- stable `idempotency_key`
- `event_type`
- merchant name
- receipt number
- original POS/EFTPOS completed tender timestamp (`purchase_at`)
- completed/final tender status
- subtotal/GST/total cents as integer cents, not dollar decimals or fractional
  cents
- itemised lines whose totals match the receipt total
- payment reference or POS event id
- for refund/void: original receipt number or original POS event id

The sale, refund, and void POS `merchant.name` values must match `merchant_name`
in `pos-pilot-site.json`, and their `purchase_at` timestamps must fall inside
the pilot window recorded in that file. Re-export the field samples or correct
the site manifest if the verifier reports a merchant mismatch or an
out-of-window sample. Refund and void samples must also reference the sale field
sample by `original_receipt_number` or `original_external_event_id`; otherwise
the go-live run stops before sending acceptance receipts.
`go-live.mjs` checks this before the acceptance send and skips acceptance when
field samples or the site manifest fail preflight validation.
The bundled sample receipts are rejected by filename and by content fingerprint;
renaming `sample-receipt.json` to `field-sale.json` is not valid go-live
evidence.
It also records a redacted SHA-256 fingerprint for each field sample so the
go-live evidence can be tied back to the merchant payloads without exposing
Looplet receipt identity tokens.
Recompute a field file fingerprint when support needs to match local files to
the verifier summary:

```powershell
node C:\ProgramData\Looplet\pos-bridge\sample-fingerprint.mjs C:\ProgramData\Looplet\field-sale.json --expected <sale-fingerprint-from-verifier-summary>
```

Stage raw sale/refund/void POS exports into the standard go-live filenames
before preflight. This writes `field-sale.json`, `field-refund.json`,
`field-void.json`, and a redacted `field-sample-capture.json` manifest:

```powershell
node C:\ProgramData\Looplet\pos-bridge\field-sample-capture.mjs --site-file C:\ProgramData\Looplet\pos-pilot-site.json --sale C:\ProgramData\Looplet\raw-sale.json --refund C:\ProgramData\Looplet\raw-refund.json --void C:\ProgramData\Looplet\raw-void.json --output-dir C:\ProgramData\Looplet
```

Expected capture result: `ok: true`, `all_identities_present: true`,
`refund_void_link_sale: true`, and `no_bundled_samples: true`.

Before go-live, run the same command in non-sending preflight mode. It validates
the install, site manifest, fit profile, and real sale/refund/void field files
without sending acceptance receipts:

```powershell
node C:\ProgramData\Looplet\pos-bridge\go-live.mjs --preflight-only --env-file C:\ProgramData\Looplet\pos-bridge.env --site-file C:\ProgramData\Looplet\pos-pilot-site.json --fit-profile C:\ProgramData\Looplet\pos-integration-profile.json --sale C:\ProgramData\Looplet\field-sale.json --refund C:\ProgramData\Looplet\field-refund.json --void C:\ProgramData\Looplet\field-void.json --output C:\ProgramData\Looplet\pos-pilot-preflight.json
```

Expected result: `ok: true`, `preflight_only: true`, `summary.non_sending:
true`, and `summary.acceptance_skipped: true`.

Then run the one-command evidence flow. It collects acceptance evidence and
immediately verifies it with all local field files so the evidence bundle is
tied back to the actual captured POS payloads:

```powershell
node C:\ProgramData\Looplet\pos-bridge\go-live.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env --site-file C:\ProgramData\Looplet\pos-pilot-site.json --fit-profile C:\ProgramData\Looplet\pos-integration-profile.json --sale C:\ProgramData\Looplet\field-sale.json --refund C:\ProgramData\Looplet\field-refund.json --void C:\ProgramData\Looplet\field-void.json --output C:\ProgramData\Looplet\pos-pilot-evidence.json
```

The field-file reconciliation compares the redacted full-sample fingerprint and the
identity-stripped content fingerprint, so support can prove the same local POS
payloads produced the evidence without exposing receipt identity tokens.
The standalone `reconcile-pilot-evidence.mjs` command is available for
support/debug checks, but go-live approval should use the go-live command above.
Running `verify-pilot-evidence.mjs` without field files fails by default.
`--evidence-only` is a diagnostic mode only and is not go-live approval.

For CSV export pilots, first convert the real POS CSV files:

```powershell
node C:\ProgramData\Looplet\pos-bridge\csv-adapter.mjs C:\ProgramData\Looplet\field-sale.csv --out C:\ProgramData\Looplet\field-sale.json
node C:\ProgramData\Looplet\pos-bridge\csv-adapter.mjs C:\ProgramData\Looplet\field-refund.csv --out C:\ProgramData\Looplet\field-refund.json
node C:\ProgramData\Looplet\pos-bridge\csv-adapter.mjs C:\ProgramData\Looplet\field-void.csv --out C:\ProgramData\Looplet\field-void.json
```

Validate the final JSON field samples:

```powershell
node C:\ProgramData\Looplet\pos-bridge\validate.mjs C:\ProgramData\Looplet\field-sale.json C:\ProgramData\Looplet\field-refund.json C:\ProgramData\Looplet\field-void.json
```

## 3. Site Manifest

Copy `pilot-site.example.json` and fill every field with real pilot details:

```powershell
copy C:\ProgramData\Looplet\pos-bridge\pilot-site.example.json C:\ProgramData\Looplet\pos-pilot-site.json
```

The go-live verifier rejects placeholder business names, placeholder POS vendor
names, placeholder pilot ids, invalid organization ids, and missing operator
details. It also rejects missing or invalid `merchant_name`,
`identity_capture_method`, `receipt_trigger`, `receipt_source_format`, and
`field_sample_capture_method` values, because the pilot must prove the receipt
came from the named POS basket after completed tender rather than an EFTPOS-only
amount feed or hand-built JSON. It also rejects field samples whose POS
`merchant.name` does not match the site manifest, whose refund/void original
references do not point to the sale field sample, or whose POS `purchase_at`
timestamps fall outside `pilot_window_start` and `pilot_window_end`.

## 4. Acceptance Run

Run the one-command go-live flow only against a staging or pilot Looplet project
and organization. It stores real receipt evidence, then immediately verifies the
evidence against the same local field files.

```powershell
set LOOPLET_ACCEPTANCE_CONFIRM_LIVE=1
node C:\ProgramData\Looplet\pos-bridge\go-live.mjs --preflight-only `
  --env-file C:\ProgramData\Looplet\pos-bridge.env `
  --site-file C:\ProgramData\Looplet\pos-pilot-site.json `
  --fit-profile C:\ProgramData\Looplet\pos-integration-profile.json `
  --sale C:\ProgramData\Looplet\field-sale.json `
  --refund C:\ProgramData\Looplet\field-refund.json `
  --void C:\ProgramData\Looplet\field-void.json `
  --output C:\ProgramData\Looplet\pos-pilot-preflight.json

node C:\ProgramData\Looplet\pos-bridge\go-live.mjs `
  --env-file C:\ProgramData\Looplet\pos-bridge.env `
  --site-file C:\ProgramData\Looplet\pos-pilot-site.json `
  --fit-profile C:\ProgramData\Looplet\pos-integration-profile.json `
  --sale C:\ProgramData\Looplet\field-sale.json `
  --refund C:\ProgramData\Looplet\field-refund.json `
  --void C:\ProgramData\Looplet\field-void.json `
  --output C:\ProgramData\Looplet\pos-pilot-evidence.json
```

The acceptance stage inside the go-live run must prove:

- first sale accepted
- duplicate sale retry returns the same `receipt_event_id`
- same idempotency key with changed receipt facts rejected
- same idempotency key with changed GST/subtotal split rejected
- same idempotency key with changed purchase timestamp rejected
- conflicting `Idempotency-Key` header/body values rejected
- missing merchant name rejected
- missing payment reference rejected
- full card number in `payment_last4` rejected
- missing purchase timestamp rejected
- invalid purchase timestamp rejected
- missing GST rejected
- missing subtotal rejected
- inconsistent GST/subtotal breakdown rejected
- refund accepted and linked to the sale
- duplicate refund retry returns the same refund `receipt_event_id`
- void accepted and linked to the sale
- duplicate void retry returns the same void `receipt_event_id`
- pending tender rejected
- missing tender rejected
- missing refund/void original references rejected
- unresolved refund/void original sale references rejected
- bad line totals rejected
- bad line GST totals rejected
- invalid API key rejected
- invalid receipt identity rejected
- accepted rows persist
- rejected negative controls do not persist
- receipt-webhook API request logs persist for accepted calls and validation
  rejections
- for watch-folder and CSV bridge pilots: installed manifest verification
  passes and the non-sending retry drill proves outage queueing plus recovery
  flush

## 5. Go-live Evidence Verification

Verify the evidence file. The preferred path is the one-command runner:

```powershell
node C:\ProgramData\Looplet\pos-bridge\go-live.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env --site-file C:\ProgramData\Looplet\pos-pilot-site.json --fit-profile C:\ProgramData\Looplet\pos-integration-profile.json --sale C:\ProgramData\Looplet\field-sale.json --refund C:\ProgramData\Looplet\field-refund.json --void C:\ProgramData\Looplet\field-void.json --output C:\ProgramData\Looplet\pos-pilot-evidence.json
```

Go-live requires `ok: true`.
If verifying an existing evidence file directly, `verify-pilot-evidence.mjs`
must be run with `--sale`, `--refund`, and `--void`;
`--evidence-only` does not count for go-live approval.

Do not approve go-live if the verifier reports any failure. Fix the POS mapping,
bridge config, Looplet credentials, field samples, or pilot environment, then
run the evidence flow again.

Generate a redacted support report after the evidence passes:

```powershell
node C:\ProgramData\Looplet\pos-bridge\pilot-report.mjs `
  C:\ProgramData\Looplet\pos-pilot-evidence.json `
  --output C:\ProgramData\Looplet\pos-pilot-report.json `
  --markdown C:\ProgramData\Looplet\pos-pilot-report.md
```

The report summarizes the site, connector mode, field capture method, safe
field-sample fingerprints, acceptance controls, API logs, and local bridge
health without printing Looplet API keys or receipt identity tokens.

Verify the complete handover bundle:

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

Expected result: `ok: true`, strict verifier pass, field-file reconciliation
pass, report pass, API request-log proof, and redacted report files.

Run the final completion audit with Looplet's archived local full-trial JSON and
the real merchant pilot bundle. Generate the local JSON first with
`npm run pos:full-trial:artifact`, then archive/copy
`.claude\scratch\pos-full-trial.json` as `C:\ProgramData\Looplet\pos-full-trial.json`
for the handover audit:

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

Expected result: `ok: true`, `local_ready: true`, and
`production_ready: true`. Without a real merchant sale/refund/void pilot bundle
this command must fail.

## 6. Operational Handover

- Confirm the scheduled task or connector is enabled.
- Confirm `status.mjs` is clean after one scheduled run.
- For watch-folder or CSV bridge pilots, confirm the scheduled-task log check is
  configured and healthy in the go-live evidence.
- Confirm logs do not contain Looplet API keys or receipt identity tokens.
- Archive `pos-pilot-report.json` / `pos-pilot-report.md` beside the evidence
  file, original field samples, site manifest, integration fit profile, and the
  `pilot-bundle.mjs` `ok: true` output.
- Confirm the business knows where queued files, rejected files, queue rows, and
  dead-letter rows are written, including that a queued receipt can later move
  to `rejected` if retry proves it is a permanent setup or contract problem.
- Confirm who monitors bridge status after go-live.
- Confirm the POS vendor/business IT owner can re-run readiness, credential
  probe, pilot evidence, and verifier commands.
