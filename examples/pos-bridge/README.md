# Looplet POS Bridge Example

This is a dependency-free Node 20 bridge for POS systems that cannot call
Looplet directly. It reads a Looplet-shaped receipt JSON file, sends it to
`/functions/v1/receipt-webhook`, retries transient failures, and writes failed
events to a local JSONL queue. It also includes a small CSV adapter for POS
systems that can export completed receipt rows but cannot emit Looplet-shaped
JSON directly.

Use this as a reference adapter, not as a vendor-complete POS connector. Real
deployments still need a POS-specific reader that maps the vendor checkout event
into the payload shape shown in `sample-receipt.json`.

The intended trigger is the completed POS sale after the customer has scanned or
tapped a Looplet receipt identity. Do not rely on EFTPOS-only data unless the
bridge can also match the payment back to the POS basket and receipt lines.

## Business install

Required on the business side:

- Node.js 20+ on a back-office PC/server, or an equivalent plugin/cloud runtime.
- Outbound HTTPS access to `https://<supabase-project>.supabase.co`.
- A Looplet API key with `write:receipts`.
- A Looplet receipt identity token in each POS receipt/export, captured from the
  customer's scanned Looplet pass/tag. `LOOPLET_RECEIPT_IDENTITY_TOKEN` is only
  a fallback/readiness token.
- A stable POS receipt/payment event id for `Idempotency-Key`.
- Access to completed POS sale data, including itemised receipt lines and GST.

No inbound firewall rule is required.

Before installing, run the POS capability fit check against the business/POS
profile:

```powershell
node integration-fit.mjs integration-fit.example.json
```

Replace the example with the business's POS capabilities. The fit check
recommends `direct_webhook`, `bridge_watch_folder`, `bridge_csv_export`, or
`custom_middleware`, emits the matching `receipt_source_format` and
`field_sample_capture_method` for `pos-pilot-site.json`, and fails if the path
is EFTPOS-only or missing identity capture, final tender trigger, itemised
lines, GST, stable idempotency, payment reference, or refund/void original-sale
references. It is a pre-install decision aid only; go-live still requires real
sale/refund/void field samples and `go-live.mjs`.

After the fit check returns `ok: true`, generate a business-specific pilot kit
so the site manifest and go-live commands inherit the same connector decision:

```powershell
node pilot-kit.mjs integration-fit.example.json --output-dir C:\ProgramData\Looplet\pilot-kit
```

The kit writes `pos-integration-profile.json`, `pos-integration-fit.json`,
`pos-pilot-site.template.json`, `PILOT_RUNBOOK.md`, and `go-live-command.ps1`.
Use the profile file for go-live commands; keep the fit result for archive
readback. Fill the template placeholders with real business/POS/operator
values before capturing field samples.

For the high-level merchant/POS vendor design, read
`MERCHANT_INTEGRATION_DESIGN.md`. It explains the direct webhook, local bridge,
CSV bridge, middleware, and EFTPOS/rewards-style identity flows in one handover
sheet.

Build a merchant-facing ZIP package from this folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\package-windows-bridge.ps1 -OutputDir .\dist
```

The ZIP contains the bridge runtime, installer, pilot-kit generator, samples,
acceptance runner, README, merchant integration design, env template, and
`MANIFEST.json` with file hashes. It intentionally excludes local-only trial
harnesses.
The Windows installer preserves `MANIFEST.json`, so `readiness.mjs` can verify
the installed files as well as the expanded ZIP and fail if operator tooling is
missing or modified after install.

For Windows back-office machines, install the bridge as a scheduled task:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows-task.ps1
```

That first command is a dry run. It prints the exact install root, env file,
inbox, and scheduled-task command without changing the machine. Apply it only
after reviewing the plan:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows-task.ps1 -Apply
```

The installer copies the bridge to `C:\ProgramData\Looplet\pos-bridge`, creates
`C:\ProgramData\Looplet\pos-bridge.env` if missing, hardens that env file so
only the installing Windows account, Administrators, and SYSTEM can read it,
creates the receipt inbox, copies the CSV adapter plus
readiness/status/pilot-evidence/acceptance/verifier tools, and registers a
once-per-minute scheduled task that runs the logging wrapper:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\Looplet\pos-bridge\run-watch-once.ps1
```

Use `-NoRegister` for test installs where you want the files and readiness
check but do not want to create a Windows scheduled task.
Scheduled task logs are written to `C:\ProgramData\Looplet\pos-bridge\logs`;
the runner redacts Looplet secrets and protects each daily log file.

## Configure

Copy `.env.example` to a protected local path, such as
`C:\ProgramData\Looplet\pos-bridge.env`, and set:

```text
LOOPLET_RECEIPT_WEBHOOK_URL=https://<supabase-project>.supabase.co/functions/v1/receipt-webhook
LOOPLET_POS_API_KEY=llp_<prefix>.<secret>
# fallback/readiness only; live receipt JSON/CSV should include identity_token
LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_<prefix>.<secret>
LOOPLET_SYNC_TARGETS=xero,myob
LOOPLET_BRIDGE_QUEUE_FILE=.looplet-pos-queue.jsonl
LOOPLET_BRIDGE_DEAD_LETTER_FILE=.looplet-pos-dead.jsonl
LOOPLET_BRIDGE_INBOX_DIR=receipts-inbox
LOOPLET_BRIDGE_MIN_FILE_AGE_MS=1000
LOOPLET_READINESS_SAMPLE=examples/pos-bridge/sample-receipt.json
LOOPLET_READINESS_SKIP_NETWORK=0
LOOPLET_ACCEPTANCE_CONFIRM_LIVE=0
LOOPLET_ACCEPTANCE_EVIDENCE_FILE=C:\ProgramData\Looplet\pos-acceptance-evidence.json
LOOPLET_ACCEPTANCE_SUPABASE_URL=https://<supabase-project>.supabase.co
LOOPLET_ACCEPTANCE_SERVICE_ROLE_KEY=<service-role-key-for-staging-or-pilot-only>
LOOPLET_ACCEPTANCE_ORG_ID=<pilot-organization-id>
```

Or generate the env file from the one-time API key and fallback/readiness receipt
identity token:

```powershell
node C:\ProgramData\Looplet\pos-bridge\configure-env.mjs `
  --output C:\ProgramData\Looplet\pos-bridge.env `
  --webhook-url https://<supabase-project>.supabase.co/functions/v1/receipt-webhook `
  --api-key llp_<prefix>.<secret> `
  --identity-token rhp_<prefix>.<secret> `
  --inbox-dir C:\ProgramData\Looplet\receipts-inbox
```

The command validates the endpoint, key shape, identity-token shape, queue/dead
letter paths, protects the env file after writing it, and prints only redacted
token shapes. It refuses to overwrite an existing env file unless `--force` is
supplied.

Use the env file with any bridge command:

```bash
node bridge.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env --watch-once C:\ProgramData\Looplet\receipts-inbox
```

When `--env-file` is passed, values in that file are authoritative for the
bridge/readiness/go-live command. Stale `LOOPLET_*` variables inherited from the
operator shell do not override the protected business env file.

Keep the env file locked down to the Windows account that runs the bridge
because it contains the Looplet API key and may contain a fallback receipt
identity token. The Windows installer applies this ACL automatically and
reapplies it on later installer runs.
For rewards-style use, receipt files must include the customer's scanned
`identity_token`; the env identity token is not a substitute for scanning the
customer/pass identity at checkout.

All amount fields are integer cents. Send `36000` for $360.00; do not send
`360.00`, rounded dollar values, or fractional cents.

Create a printable pilot pass for a cashier/scanner test:

```powershell
node C:\ProgramData\Looplet\pos-bridge\pilot-pass.mjs `
  --env-file C:\ProgramData\Looplet\pos-bridge.env `
  --output C:\ProgramData\Looplet\looplet-pilot-pass.html `
  --business-name "Pilot Trade Pty Ltd" `
  --pilot-id "pilot-001"
```

The generated HTML contains the scannable Code 128 receipt identity and is the
only output that should expose the `rhp_...` token. Command output stays
redacted. Print it or open it on a device and scan it into the POS before
payment; the POS/export must carry that scanned value as `identity_token` on the
final itemised receipt.

## Run

Send the sample receipt:

```bash
node bridge.mjs sample-receipt.json
```

Send a refund event:

```bash
node bridge.mjs sample-refund.json
```

Send a void event:

```bash
node bridge.mjs sample-void.json
```

Validate POS payloads before enabling live sends:

```bash
node validate.mjs sample-receipt.json sample-refund.json sample-void.json
```

Convert a simple POS CSV export to Looplet JSON:

```bash
node csv-adapter.mjs sample-pos-export.csv --out receipts-inbox/POS-CSV-2026-0001.json
```

The CSV adapter expects one receipt per CSV file and one row per line item. It
validates tender status, idempotency, GST/subtotal/total cents, item totals, and
required payment reference before writing JSON for the bridge. Refund and void
CSV exports must include `original_receipt_number` or
`original_external_event_id` so Looplet can link them back to the sale.
Receipt-level fields such as merchant, idempotency key, purchase time, tender
status, payment reference, totals, original-sale references, and sync targets
must be identical on every line row; mixed metadata is rejected instead of
silently trusting the first row.

Run a non-destructive business-side readiness check:

```powershell
node readiness.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env
```

The readiness check verifies Node.js version, installed operator-tool
completeness including the CSV adapter, webhook URL shape, API key/token shape
without printing secrets, inbox write access, sample receipt contract, and
outbound HTTPS reachability using an `OPTIONS` probe. It does not send or store
a receipt.
For rewards-style pilots without a fallback env identity token, point readiness
at a sample receipt/export that includes the scanned `identity_token`:

```powershell
node readiness.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env --sample C:\ProgramData\Looplet\field-sale.json
```

If you installed with `install-windows-task.ps1`, run the installed copy:

```powershell
node C:\ProgramData\Looplet\pos-bridge\readiness.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env
```

Probe the POS API key and `write:receipts` scope without storing a receipt:

```powershell
node C:\ProgramData\Looplet\pos-bridge\credential-probe.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env
```

The probe sends a valid receipt-shaped request with a deliberately invalid
receipt identity. A correctly provisioned API key reaches the webhook and gets a
`400` identity rejection before persistence; `401` means the key is wrong, and
`403` means it lacks `write:receipts`.

Run a non-sending outage/retry drill from the installed bridge:

```powershell
node C:\ProgramData\Looplet\pos-bridge\bridge-retry-drill.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env --sample C:\ProgramData\Looplet\field-sale.json
```

The drill points the installed bridge at a temporary local endpoint that returns
`503` first and `200` after recovery. It proves transient failures are retried,
queued, flushed after recovery, not dead-lettered, and that the output does not
leak Looplet API keys or receipt identity tokens. It does not send a receipt to
Looplet.

Run a non-destructive health report after the scheduled task is live:

```powershell
node C:\ProgramData\Looplet\pos-bridge\status.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env
```

The status report does not send a receipt and does not print secrets or receipt
payloads. It counts pending inbox files, stuck `processing` files, `queued` and
`rejected` watch-folder files, retry-queue rows, dead-letter rows, JSONL parse
errors, and the last error status/message summary. When
`LOOPLET_BRIDGE_LOG_DIR` is configured, it also checks the latest `bridge-*.log`
written by `run-watch-once.ps1` and fails if the scheduled task has never
completed, last exited non-zero, or is older than
`LOOPLET_BRIDGE_STALE_AFTER_MINUTES`. It exits non-zero when queued,
rejected, dead-lettered, stale, failed, damaged queue/dead-letter, or stuck
processing files need operator attention.
For `bridge_watch_folder` and `bridge_csv_export` go-live evidence, the verifier
requires this scheduled-task log check to be configured and healthy, and the
status evidence must prove the protected env file plus local log/state/archive
files are not readable by broad local users. Direct POS webhook pilots do not
need a local scheduler log.

Collect a redacted diagnostic evidence file without sending receipts:

```powershell
node C:\ProgramData\Looplet\pos-bridge\pilot-evidence.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env --output C:\ProgramData\Looplet\pos-pilot-evidence.json
```

This runs readiness, status, a non-persistent credential/scope probe, and
sample contract validation, then writes one JSON evidence file. The credential
probe uses a deliberately invalid receipt identity so a good `write:receipts`
key reaches the webhook and is rejected before persistence. It skips live
acceptance by default. It is diagnostic only and is not go-live approval.

For go-live evidence, copy `pilot-site.example.json` to a business-specific
site manifest and point the go-live run at real POS-export/webhook payloads
from that business. The files can be JSON emitted by the POS directly or JSON
created by `csv-adapter.mjs` from the POS CSV export:

Use `PILOT_CHECKLIST.md` as the operator checklist for the business-side pilot.
It is included in the ZIP package and installed beside the bridge runtime.
The site manifest must record the POS payload merchant/trading name, how the
Looplet identity is captured, which completed POS event triggers the send, and
which receipt source format the connector consumes. These are closed values so
go-live evidence cannot gloss over an EFTPOS-only feed that lacks POS basket and
receipt-line data. The verifier also checks that the connector mode and receipt
source format are compatible.

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

The verifier requires the site manifest, contract-valid field sale/refund/void
samples, the live acceptance run, duplicate retry checks, persistence readback,
and negative controls before it reports `ok: true`. It also checks that each
field sample's POS `merchant.name` matches the site manifest `merchant_name`,
and each field sample's POS `purchase_at` falls within the site manifest pilot
window. Refund and void samples must also point back to the sale field sample by
`original_receipt_number` or `original_external_event_id`. `go-live.mjs` applies
those field-sample checks before the acceptance send and skips acceptance when
the site manifest or field samples fail preflight validation.
For watch-folder and CSV bridge pilots, the status evidence must also report
`local_file_protection.ok: true`, proving the business env file, scheduled-task
log, retry/dead-letter state, and raw receipt archives are filesystem-protected.
The packaged examples are rejected by filename and by content fingerprint, so a
renamed copy of `sample-receipt.json`, `sample-refund.json`, or
`sample-void.json` is not go-live evidence.
The verifier also requires `identity_capture_method`, `receipt_trigger`, and
`receipt_source_format`, plus `field_sample_capture_method`, so a business must
prove the receipt path starts from the POS checkout flow with a captured Looplet
identity and final tender, not from an unlinked payment amount or hand-built
JSON. It rejects impossible pairings such as a direct POS webhook claiming
CSV-export input, or POS JSON export evidence claiming CSV/webhook field capture.
The packaged
`sample-receipt.json`, `sample-refund.json`, and `sample-void.json` are
accepted for local trials only; go-live evidence rejects those filenames as
field samples.

Before the sending acceptance run, use the same one-command runner in non-sending
preflight mode:

```powershell
node C:\ProgramData\Looplet\pos-bridge\go-live.mjs --preflight-only `
  --env-file C:\ProgramData\Looplet\pos-bridge.env `
  --site-file C:\ProgramData\Looplet\pos-pilot-site.json `
  --fit-profile C:\ProgramData\Looplet\pos-integration-profile.json `
  --sale C:\ProgramData\Looplet\field-sale.json `
  --refund C:\ProgramData\Looplet\field-refund.json `
  --void C:\ProgramData\Looplet\field-void.json `
  --output C:\ProgramData\Looplet\pos-pilot-preflight.json
```

Expected preflight result: `ok: true`, `preflight_only: true`,
`summary.non_sending: true`, and `summary.acceptance_skipped: true`.

The one-command go-live runner verifies the evidence immediately after
acceptance. To verify an existing evidence file directly:

```powershell
node C:\ProgramData\Looplet\pos-bridge\verify-pilot-evidence.mjs C:\ProgramData\Looplet\pos-pilot-evidence.json --sale C:\ProgramData\Looplet\field-sale.json --refund C:\ProgramData\Looplet\field-refund.json --void C:\ProgramData\Looplet\field-void.json
```

The verifier is intentionally strict. It fails preflight-only evidence,
acceptance without persistence readback, leaked Looplet secrets, missing
credential probe proof, missing duplicate/refund/void checks, and missing
negative controls. It also requires receipt-webhook API request log proof for
accepted calls and validation rejections. For watch-folder and CSV bridge
pilots it also requires readiness to verify the installed `MANIFEST.json` and
the bridge retry drill to prove outage queueing plus recovery flush. It also
requires local file-protection proof from `status.mjs`; evidence without that
proof fails. Duplicate proof covers sale, refund, and void retries. Passing
`--sale`, `--refund`, and
`--void` makes the verifier recompute the redacted full-sample SHA-256 and the
identity-stripped content SHA-256 from the local POS field files before it can
report `ok: true`. Running without those field files fails by default;
`--evidence-only` is only for diagnostics and is not go-live approval.

After verification passes, generate a redacted support report for business
handover:

```powershell
node C:\ProgramData\Looplet\pos-bridge\pilot-report.mjs C:\ProgramData\Looplet\pos-pilot-evidence.json --output C:\ProgramData\Looplet\pos-pilot-report.json --markdown C:\ProgramData\Looplet\pos-pilot-report.md
```

The report fails diagnostic/non-sending evidence, skipped acceptance, missing
field samples, missing API request log proof, missing local bridge protections,
or unredacted Looplet secrets. It only includes safe fingerprints and status
summaries.

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

The bundle verifier reruns strict verification with the field files, checks the
archived site manifest and integration fit match the evidence/report, and fails
if a support report contains unredacted Looplet secrets.

Final readiness is split into two gates: local system proof and real merchant
pilot proof. Looplet should generate and archive the local proof artifact:

```powershell
npm run pos:full-trial:artifact
```

This writes `.claude\scratch\pos-full-trial.json`. Copy that file into the
pilot archive as `pos-full-trial.json`, then run:

```powershell
node C:\ProgramData\Looplet\pos-bridge\completion-audit.mjs `
  --local-json C:\ProgramData\Looplet\pos-full-trial.json
```

Expected local result: `ok: true`, `local_ready: true`, and
`production_ready: false`. It must not be treated as production-ready until the
same command passes with `--require-production` and the real pilot bundle files:

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

Flush queued failures:

```bash
node bridge.mjs --flush
```

If the retry queue contains a malformed JSONL row, `--flush` quarantines that
row to the dead-letter file and continues retrying the valid queued receipts.
The dead-letter summary redacts Looplet API keys and receipt identity tokens.
Parent directories for the queue and dead-letter paths are created
automatically, which is useful when those files live under `C:\ProgramData`.

Watch a POS export folder:

```bash
node bridge.mjs --watch receipts-inbox
```

Run one folder pass, suitable for a scheduled task:

```bash
node bridge.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env --watch-once C:\ProgramData\Looplet\receipts-inbox
```

Example Windows scheduled-task command:

```powershell
schtasks /Create /TN "Looplet POS Receipt Bridge" /SC MINUTE /MO 1 /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\Looplet\pos-bridge\run-watch-once.ps1"
```

In watch mode, completed `*.json` files in the inbox are moved into:

- `sent` after Looplet accepts them.
- `queued` after a transient outage; the retry queue is flushed on every pass.
  When a queued receipt later flushes successfully, its queued archive is moved
  into `sent`. If the retry later receives a permanent rejection, its queued
  archive is moved into `rejected` and the rejection is appended to the
  dead-letter JSONL file.
- `rejected` after invalid JSON, bad contract data, invalid credentials, or
  another permanent error. A copy of the error is appended to the dead-letter
  JSONL file with Looplet API keys and receipt identity tokens redacted.

The bridge protects raw receipt archives, retry queue files, and dead-letter
files when it creates, rewrites, or moves them. That matters because archived
and queued receipts can retain the scanned receipt identity and itemised basket
needed for audit/retry. Dead-letter records are for support triage and should
not contain unredacted `llp_...` or `rhp_...` secrets.

The bridge waits until a `*.json` inbox file is at least
`LOOPLET_BRIDGE_MIN_FILE_AGE_MS` old before processing it. Keep the default
`1000` ms guard unless the POS/export job writes to a temporary file and then
atomically renames the completed file into the inbox.

Run the offline bridge trial:

```bash
node trial.mjs
```

Run the env writer self-test:

```bash
node configure-env-trial.mjs
```

Run the CSV adapter trial:

```bash
node csv-adapter-trial.mjs
```

Run the watch-folder bridge trial:

```bash
node watch-trial.mjs
```

Run the readiness self-test:

```bash
node readiness-trial.mjs
```

Run the credential probe self-test:

```bash
node credential-probe-trial.mjs
```

Run the bridge status self-test:

```bash
node status-trial.mjs
```

Run the pilot evidence self-test:

```bash
node pilot-evidence-trial.mjs
```

Run the printable pilot pass self-test:

```bash
node pilot-pass-trial.mjs
```

Run the pilot evidence verifier self-test:

```bash
node verify-pilot-evidence-trial.mjs
```

Run the full local go-live evidence flow. This starts a fake local webhook/REST
readback endpoint, runs `go-live.mjs`, then verifies the result with the strict
field-file verifier:

```bash
node pilot-go-live-trial.mjs
```

Run the final archive bundle verifier self-test:

```bash
node pilot-bundle-trial.mjs
```

Run the Windows installer self-test. It creates a scratch install, does not
register a scheduled task, and runs readiness against the installed copy:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install-windows-task-trial.ps1
```

Run the package self-test. It builds the merchant ZIP, expands it, verifies
manifest hashes, excludes local-only trials, and runs readiness/status from the
expanded copy:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File package-windows-bridge-trial.ps1
```

Run the acceptance-runner self-test:

```bash
node acceptance-trial.mjs
```

Run the one-command go-live evidence flow against a real staging/pilot Looplet endpoint:

```powershell
set LOOPLET_ACCEPTANCE_CONFIRM_LIVE=1
set LOOPLET_ACCEPTANCE_RUN_ID=pilot-001
node go-live.mjs --preflight-only --env-file C:\ProgramData\Looplet\pos-bridge.env --site-file C:\ProgramData\Looplet\pos-pilot-site.json --fit-profile C:\ProgramData\Looplet\pos-integration-profile.json --sale C:\ProgramData\Looplet\field-sale.json --refund C:\ProgramData\Looplet\field-refund.json --void C:\ProgramData\Looplet\field-void.json --output C:\ProgramData\Looplet\pos-pilot-preflight.json
node go-live.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env --site-file C:\ProgramData\Looplet\pos-pilot-site.json --fit-profile C:\ProgramData\Looplet\pos-integration-profile.json --sale C:\ProgramData\Looplet\field-sale.json --refund C:\ProgramData\Looplet\field-refund.json --void C:\ProgramData\Looplet\field-void.json --output C:\ProgramData\Looplet\pos-pilot-evidence.json
```

The go-live runner collects acceptance evidence and immediately runs the strict
field-file verifier against the same local POS payload files. The verifier
summary lists redacted SHA-256 fingerprints for the field samples.
To confirm a local field file is the same file that produced the evidence,
recompute its fingerprint without printing receipt identity tokens:

```powershell
node sample-fingerprint.mjs C:\ProgramData\Looplet\field-sale.json --expected <sale-fingerprint-from-verifier-summary>
```

The standalone reconciler is still available for support/debug sessions when
you need to compare the evidence bundle against the local field files without
rerunning the full verifier:

```powershell
node reconcile-pilot-evidence.mjs C:\ProgramData\Looplet\pos-pilot-evidence.json --sale C:\ProgramData\Looplet\field-sale.json --refund C:\ProgramData\Looplet\field-refund.json --void C:\ProgramData\Looplet\field-void.json
```

The reconciliation step compares both the redacted full-sample SHA-256 and the
identity-stripped content SHA-256. That catches evidence bundles that omit or
alter the content fingerprint while still keeping receipt identity tokens out of
support output.
For diagnostics that intentionally inspect only the evidence JSON, run
`node verify-pilot-evidence.mjs C:\ProgramData\Looplet\pos-pilot-evidence.json --evidence-only`;
do not use that mode for go-live approval.

The acceptance runner sends a unique sale from the field sale file, repeats it to prove idempotency,
sends same-key changed-payload, same-key changed GST/subtotal, same-key changed purchase_at, and conflicting header/body idempotency negative controls that must be rejected,
sends missing merchant, missing payment reference, full-card payment_last4, missing purchase_at, invalid purchase_at, missing GST, missing subtotal, and inconsistent GST-subtotal negative controls that must be rejected,
sends a refund and void linked to the sale, repeats the refund and void to prove
retry idempotency, sends intentionally bad tenders, missing original-sale
references, and unresolved original-sale references that must be rejected, sends
bad line totals and bad line GST totals that must be rejected, and sends one invalid API-key request that must return `401`. It writes JSON evidence when
`LOOPLET_ACCEPTANCE_EVIDENCE_FILE` is set. Use a staging or pilot organization
because accepted sale/refund/void events are stored as real receipt evidence.
When `LOOPLET_ACCEPTANCE_SERVICE_ROLE_KEY` is set, it also reads back the
persisted `receipt_events`, `receipt_event_line_items`, `receipt_audit_packages`,
`receipt_sync_jobs`, and `api_request_log` rows to prove the accepted events,
webhook audit trail, and rejection controls were stored correctly.

For rewards-style pilots, the sale/refund/void field samples may carry the
scanned `identity_token` directly and `LOOPLET_RECEIPT_IDENTITY_TOKEN` may be
omitted from the env file. The acceptance runner uses the receipt identity from
the field sample first and only falls back to the env token when the sample does
not include one.

Run a local edge-function trial against a local Supabase stack:

```bash
npm run pos:local-edge-trial
```

Run the Receipt Hub browser smoke:

```bash
npm run pos:receipt-hub-visual-smoke
```

This starts a temporary Vite harness, renders the real authenticated
`ReceiptHubPage` with representative receipt/POS state, clicks `Generate
config` and `Generate pass`, checks for browser console/page errors, checks
keyboard reachability for the main POS controls, checks desktop/mobile
horizontal overflow, and saves desktop plus mobile screenshots under
`.claude/scratch/receipt-hub-visual-smoke/`.
`npm run pos:full-trial` includes this smoke.

When Chromium and Firefox Playwright browsers are installed, run:

```bash
npm run pos:receipt-hub-cross-browser-smoke
```

This runs the same authenticated desktop and mobile smoke in both engines.
WebKit is intentionally not in the default command because Windows agents often
do not have that browser binary installed.

The trial autodetects the active local Supabase DB/Kong containers when there
is only one local stack, starts a bundled Deno server for the current
`receipt-webhook` and `receipt-sync-dispatch` source files, and sends requests
to that local server. Override detection only when needed:

```bash
set LOOPLET_LOCAL_SERVICE_ROLE_KEY=<service-role-key-from-supabase-status>
set LOOPLET_LOCAL_ANON_KEY=<anon-key-from-supabase-status>
set LOOPLET_LOCAL_DB_CONTAINER=supabase_db_Looplet
npm run pos:local-edge-trial
```

Set `LOOPLET_LOCAL_FUNCTIONS_URL` only when you want to use an already-running
Supabase Edge Runtime instead of the bundled local server. The script first
verifies that `receipt-webhook` is being served and that the receipt schema is
present. It then seeds a throwaway local org, API key, and receipt identity,
calls the real local `receipt-webhook` and `receipt-sync-dispatch` endpoints
for sale, duplicate retry, refund, and negative controls, verifies persisted
rows, and deletes the seeded org before exiting.

In the local fixture, the queued Xero/MYOB jobs are expected to become
`skipped`: Xero needs a real job attachment before push, and MYOB is not
configured. This proves the dispatcher treats known setup gaps as operator
action items instead of retryable outages.

The bridge treats these as final configuration/payload errors: `400`, `401`,
and `403`. It retries `429` and `5xx` with exponential backoff, then queues the
receipt if it still cannot be delivered.

`sample-invalid-pending.json` is intentionally rejected because a POS bridge
must wait for a final tender state before sending Looplet a receipt.

## Production adapter points

- Replace the file reader with a POS webhook listener, export-file watcher,
  vendor API poller, or CSV export job that emits only completed sales.
- Keep the POS event id stable across retries.
- Send `event_type=sale` for completed sales, `refund` for completed refunds,
  and `void` for completed void/cancellation events.
- For `refund` and `void`, send the original sale receipt number or original POS
  event id. Looplet rejects unresolved refund/void references instead of storing
  unlinked evidence.
- Log the POS event id, Looplet HTTP status, `receipt_event_id`, and error body.
- Run the process under a service manager so it starts after reboot.
