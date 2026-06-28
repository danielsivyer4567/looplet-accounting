#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { assessIntegrationFit } from './integration-fit.mjs';

const defaultOutputDir = 'pos-pilot-kit';

async function main() {
  const args = process.argv.slice(2);
  const profilePath = args.shift();
  if (!profilePath) throw new Error(usage());

  const options = parseOptions(args);
  const outputDir = options.outputDir ?? defaultOutputDir;
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  const fit = assessIntegrationFit(profile);
  if (!fit.ok || !fit.recommendation) {
    console.error(JSON.stringify({
      ok: false,
      error: 'POS integration profile is not ready for a pilot kit',
      blockers: fit.blockers,
      warnings: fit.warnings,
      next_steps: fit.next_steps,
    }, null, 2));
    process.exit(1);
  }

  const site = buildSiteTemplate(profile, fit.recommendation, options);
  const runbook = buildRunbook({ profile, fit, site });
  const commands = buildGoLiveCommand(site);

  await mkdir(outputDir, { recursive: true });
  const profileFile = join(outputDir, 'pos-integration-profile.json');
  const fitFile = join(outputDir, 'pos-integration-fit.json');
  const siteFile = join(outputDir, 'pos-pilot-site.template.json');
  const runbookFile = join(outputDir, 'PILOT_RUNBOOK.md');
  const commandFile = join(outputDir, 'go-live-command.ps1');

  await writeFile(profileFile, `${JSON.stringify(profile, null, 2)}\n`);
  await writeFile(fitFile, `${JSON.stringify(fit, null, 2)}\n`);
  await writeFile(siteFile, `${JSON.stringify(site, null, 2)}\n`);
  await writeFile(runbookFile, runbook);
  await writeFile(commandFile, commands);

  console.log(JSON.stringify({
    ok: true,
    output_dir: outputDir,
    connector_mode: fit.recommendation.connector_mode,
    identity_capture_method: fit.recommendation.identity_capture_method,
    receipt_trigger: fit.recommendation.receipt_trigger,
    receipt_source_format: fit.recommendation.receipt_source_format,
    field_sample_capture_method: fit.recommendation.field_sample_capture_method,
    files: {
      integration_profile: profileFile,
      integration_fit_result: fitFile,
      site_template: siteFile,
      runbook: runbookFile,
      go_live_command: commandFile,
    },
    next_steps: [
      'Copy pos-integration-profile.json, pos-integration-fit.json, and pos-pilot-site.json into the pilot archive/location.',
      'Fill pos-pilot-site.template.json placeholders and save it as pos-pilot-site.json.',
      'Capture real POS sale/refund/void field samples from the business path.',
      'Run the generated go-live-command.ps1 from the installed bridge machine.',
      'Archive pos-pilot-evidence.json, pos-pilot-report.json, and pos-pilot-report.md.',
    ],
  }, null, 2));
}

function buildSiteTemplate(profile, recommendation, options) {
  const businessName = options.businessName ?? text(profile.business_name) ?? 'TODO legal business name';
  const merchantName = options.merchantName ?? text(profile.merchant_name) ?? text(profile.business_name) ?? 'TODO POS merchant name';
  const pilotId = options.pilotId ?? `pilot-${new Date().toISOString().slice(0, 10)}-${slug(merchantName)}`;

  return {
    business_name: businessName,
    merchant_name: merchantName,
    pilot_id: pilotId,
    pilot_window_start: options.pilotWindowStart ?? 'TODO ISO timestamp when field sale starts',
    pilot_window_end: options.pilotWindowEnd ?? 'TODO ISO timestamp after void/refund proof ends',
    pos_vendor: text(profile.pos_vendor) ?? 'TODO POS vendor',
    pos_product: text(profile.pos_product) ?? 'TODO POS product',
    pos_version: text(profile.pos_version) ?? 'TODO POS version',
    connector_mode: recommendation.connector_mode,
    identity_capture_method: recommendation.identity_capture_method,
    receipt_trigger: recommendation.receipt_trigger,
    receipt_source_format: recommendation.receipt_source_format,
    field_sample_capture_method: recommendation.field_sample_capture_method,
    integration_owner: options.integrationOwner ?? 'Looplet / business IT / POS vendor',
    install_machine_id: options.installMachineId ?? 'TODO POS/back-office machine id',
    operator_name: options.operatorName ?? 'TODO installer/operator name',
    operator_role: options.operatorRole ?? 'TODO operator role',
    looplet_organization_id: options.loopletOrganizationId ?? 'TODO Looplet organization UUID',
    notes: [
      'merchant_name must match payload.merchant.name in the sale/refund/void field samples.',
      'pilot_window_start/end must bracket the real POS sale/refund/void purchase_at timestamps.',
      'Do not use bundled sample-receipt/sample-refund/sample-void files for go-live evidence.',
    ].join(' '),
  };
}

function buildRunbook({ profile, fit, site }) {
  const connectorMode = fit.recommendation.connector_mode;
  const bridgeMode = connectorMode === 'bridge_watch_folder' || connectorMode === 'bridge_csv_export';
  const fieldFiles = connectorMode === 'bridge_csv_export'
    ? [
        'field-sale.csv, converted to field-sale.json with csv-adapter.mjs',
        'field-refund.csv, converted to field-refund.json with csv-adapter.mjs',
        'field-void.csv, converted to field-void.json with csv-adapter.mjs',
      ]
    : [
        'field-sale.json',
        'field-refund.json',
        'field-void.json',
      ];

  return `# Looplet POS Pilot Runbook

Business: ${site.business_name}
POS: ${site.pos_vendor} ${site.pos_product}
Recommended connector: ${connectorMode}
Identity capture: ${fit.recommendation.identity_capture_method}
Receipt trigger: ${fit.recommendation.receipt_trigger}
Receipt source format: ${fit.recommendation.receipt_source_format}
Field sample capture: ${fit.recommendation.field_sample_capture_method}

## 1. Confirm Fit

- Keep \`pos-integration-profile.json\` and \`pos-integration-fit.json\` with the pilot evidence.
- Current result: \`ok: ${fit.ok}\`.
- Reason: ${fit.recommendation.reason}.
- This is not go-live evidence. It only proves the POS path is worth piloting.

## 2. Prepare Site Manifest

1. Copy \`pos-pilot-site.template.json\` to \`pos-pilot-site.json\`.
2. Replace every \`TODO\` value with real business, POS, operator, machine, organization, and pilot-window details.
3. Confirm \`merchant_name\` exactly matches the POS payload merchant name in all three field samples.

## 3. Business Install

${bridgeMode
  ? `- Install Node.js 20+ or equivalent runtime on the POS/back-office machine.
- Install the Looplet bridge package and protect \`C:\\ProgramData\\Looplet\\pos-bridge.env\`.
- Confirm outbound HTTPS to the Looplet Supabase receipt-webhook endpoint.
- Run \`readiness.mjs\`, \`credential-probe.mjs\`, \`status.mjs\`, and \`bridge-retry-drill.mjs\` before acceptance.`
  : `- Configure the POS/vendor connector secret store with the scoped Looplet POS API key.
- Configure the webhook endpoint, Authorization header, Idempotency-Key header, and JSON mapping.
- Run readiness and credential proof for the endpoint before acceptance.`}

## 4. Capture Field Samples

Capture these from the real POS path after the cashier scans the Looplet pilot pass:

${fieldFiles.map((file) => `- ${file}`).join('\n')}

Each sample must include itemised lines, subtotal/GST/total cents, payment reference, completed purchase_at, terminal/store where available, and the scanned Looplet identity token or middleware identity mapping. Refund and void samples must reference the original sale receipt number or original POS event id.

EFTPOS-only data is not enough unless it is matched back to the POS basket, receipt number, GST split, line items, and scanned customer identity.

## 5. Go-Live Evidence

Run \`go-live-command.ps1\` from the installed bridge machine after filling the site manifest and placing the real raw POS sale/refund/void samples beside it. The command first stages those raw captures into standard \`field-*.json\` files, then runs a non-sending \`go-live.mjs --preflight-only\` pass with the same inputs, then runs the real acceptance send only if that preflight succeeds.

Go-live requires:

- \`field-sample-capture.json\` with \`ok: true\` and no bundled samples
- \`pos-pilot-preflight.json\` with \`ok: true\` and \`non_sending: true\`
- \`pos-pilot-evidence.json\` with \`ok: true\`
- strict verifier pass with field-file reconciliation
- duplicate sale/refund/void idempotency controls
- negative controls for bad payment reference, card last4, purchase_at, GST/subtotal, and original-sale links
- API request-log proof for the accepted receipt-webhook calls
- redacted \`pos-pilot-report.json\` and \`pos-pilot-report.md\`
- final \`completion-audit.mjs --require-production\` pass using Looplet's archived \`pos-full-trial.json\`

## 6. Archive

Archive these files together:

- \`pos-integration-fit.json\`
- \`pos-integration-profile.json\`
- \`pos-pilot-site.json\`
- real field sale/refund/void source files
- \`pos-pilot-evidence.json\`
- \`pos-pilot-report.json\`
- \`pos-pilot-report.md\`
- \`pos-full-trial.json\`
- the \`pilot-bundle.mjs\` and \`completion-audit.mjs --require-production\` outputs

Profile source: ${text(profile.business_name) ?? 'unknown business'} / ${text(profile.pos_vendor) ?? 'unknown POS'}
`;
}

function buildGoLiveCommand(site) {
  return `Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$BridgeRoot = 'C:\\ProgramData\\Looplet\\pos-bridge'
$EnvFile = 'C:\\ProgramData\\Looplet\\pos-bridge.env'
$SiteFile = 'C:\\ProgramData\\Looplet\\pos-pilot-site.json'
$FitProfile = 'C:\\ProgramData\\Looplet\\pos-integration-profile.json'
$RawSale = 'C:\\ProgramData\\Looplet\\raw-sale.json'
$RawRefund = 'C:\\ProgramData\\Looplet\\raw-refund.json'
$RawVoid = 'C:\\ProgramData\\Looplet\\raw-void.json'
$Sale = 'C:\\ProgramData\\Looplet\\field-sale.json'
$Refund = 'C:\\ProgramData\\Looplet\\field-refund.json'
$Void = 'C:\\ProgramData\\Looplet\\field-void.json'
$CaptureManifest = 'C:\\ProgramData\\Looplet\\field-sample-capture.json'
$PreflightEvidence = 'C:\\ProgramData\\Looplet\\pos-pilot-preflight.json'
$Evidence = 'C:\\ProgramData\\Looplet\\pos-pilot-evidence.json'
$ReportJson = 'C:\\ProgramData\\Looplet\\pos-pilot-report.json'
$ReportMarkdown = 'C:\\ProgramData\\Looplet\\pos-pilot-report.md'
$BundleJson = 'C:\\ProgramData\\Looplet\\pos-pilot-bundle.json'
$CompletionAuditJson = 'C:\\ProgramData\\Looplet\\completion-audit.json'
$LocalFullTrial = 'C:\\ProgramData\\Looplet\\pos-full-trial.json'

# Site defaults generated for ${site.business_name}; replace TODOs in $SiteFile before running.
$RequiredInputs = @(
  $EnvFile,
  $SiteFile,
  $FitProfile,
  $RawSale,
  $RawRefund,
  $RawVoid,
  $LocalFullTrial
)
foreach ($Path in $RequiredInputs) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Required go-live input is missing: $Path"
  }
}

node "$BridgeRoot\\field-sample-capture.mjs" \`
  --site-file $SiteFile \`
  --sale $RawSale \`
  --refund $RawRefund \`
  --void $RawVoid \`
  --output-dir 'C:\\ProgramData\\Looplet' \`
  --manifest $CaptureManifest

node "$BridgeRoot\\go-live.mjs" \`
  --preflight-only \`
  --env-file $EnvFile \`
  --site-file $SiteFile \`
  --fit-profile $FitProfile \`
  --sale $Sale \`
  --refund $Refund \`
  --void $Void \`
  --output $PreflightEvidence

node "$BridgeRoot\\go-live.mjs" \`
  --env-file $EnvFile \`
  --site-file $SiteFile \`
  --fit-profile $FitProfile \`
  --sale $Sale \`
  --refund $Refund \`
  --void $Void \`
  --output $Evidence

node "$BridgeRoot\\pilot-report.mjs" $Evidence --output $ReportJson --markdown $ReportMarkdown

node "$BridgeRoot\\pilot-bundle.mjs" \`
  --evidence $Evidence \`
  --site $SiteFile \`
  --fit $FitProfile \`
  --sale $Sale \`
  --refund $Refund \`
  --void $Void \`
  --report-json $ReportJson \`
  --report-markdown $ReportMarkdown \`
  --output $BundleJson

node "$BridgeRoot\\completion-audit.mjs" \`
  --require-production \`
  --local-json $LocalFullTrial \`
  --evidence $Evidence \`
  --site $SiteFile \`
  --fit $FitProfile \`
  --sale $Sale \`
  --refund $Refund \`
  --void $Void \`
  --report-json $ReportJson \`
  --report-markdown $ReportMarkdown \`
  --output $CompletionAuditJson
`;
}

function parseOptions(args) {
  const options = {};
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (!flag || !flag.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(usage());
    switch (flag) {
      case '--output-dir':
        options.outputDir = value;
        break;
      case '--business-name':
        options.businessName = value;
        break;
      case '--merchant-name':
        options.merchantName = value;
        break;
      case '--pilot-id':
        options.pilotId = value;
        break;
      case '--pilot-window-start':
        options.pilotWindowStart = value;
        break;
      case '--pilot-window-end':
        options.pilotWindowEnd = value;
        break;
      case '--looplet-organization-id':
        options.loopletOrganizationId = value;
        break;
      case '--install-machine-id':
        options.installMachineId = value;
        break;
      case '--operator-name':
        options.operatorName = value;
        break;
      case '--operator-role':
        options.operatorRole = value;
        break;
      case '--integration-owner':
        options.integrationOwner = value;
        break;
      default:
        throw new Error(usage());
    }
  }
  return options;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'pos-pilot';
}

function usage() {
  return [
    'usage: node pilot-kit.mjs <pos-integration-profile.json> [--output-dir dir]',
    '       [--business-name name] [--merchant-name name] [--pilot-id id]',
    '       [--pilot-window-start iso] [--pilot-window-end iso]',
    '       [--looplet-organization-id uuid] [--install-machine-id machine]',
    '       [--operator-name name] [--operator-role role] [--integration-owner owner]',
  ].join('\n');
}

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
