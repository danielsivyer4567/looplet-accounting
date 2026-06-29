#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { assessIntegrationFit } from './integration-fit.mjs';

const rootDir = join('.claude', 'scratch', 'pos-pilot-kit-trial');
const profileFile = join(rootDir, 'profile.json');
const badProfileFile = join(rootDir, 'eftpos-only-profile.json');
const outputDir = join(rootDir, 'kit');

async function main() {
  await rm(rootDir, { recursive: true, force: true });
  await mkdir(rootDir, { recursive: true });

  const profile = {
    business_name: 'Pilot Trade Pty Ltd',
    merchant_name: 'Pilot Trade',
    pos_vendor: 'Acme POS',
    pos_product: 'Acme Back Office',
    pos_version: '2026.6',
    capabilities: {
      identity_capture_methods: ['barcode_scan'],
      receipt_triggers: ['pos_completed_tender'],
      custom_webhooks: false,
      custom_headers: false,
      json_body_mapping: false,
      json_export: true,
      csv_export: false,
      pos_plugin_sdk: false,
      vendor_cloud_events: false,
      vendor_api_polling: false,
      custom_middleware_available: false,
      middleware_can_store_secrets: false,
      middleware_outbound_https: false,
      itemised_lines: true,
      gst_breakdown: true,
      integer_cents: true,
      stable_event_id: true,
      payment_reference: true,
      refund_void_events: true,
      refund_void_original_reference: true,
      eftpos_only: false,
      bridge_machine: {
        available: true,
        node20_or_plugin_runtime: true,
        outbound_https: true,
        protected_secret_store: true,
      },
    },
  };
  await writeFile(profileFile, `${JSON.stringify(profile, null, 2)}\n`);

  const importedFit = assessIntegrationFit(profile);
  assert(importedFit.ok === true, 'import-safe integration-fit should return ok without executing CLI');

  const kitRun = await runNode([
    'examples/pos-bridge/pilot-kit.mjs',
    profileFile,
    '--output-dir',
    outputDir,
    '--pilot-id',
    'pilot-real-pos-001',
    '--pilot-window-start',
    '2026-06-28T13:00:00+10:00',
    '--pilot-window-end',
    '2026-06-28T13:40:00+10:00',
    '--looplet-organization-id',
    '11111111-1111-4111-8111-111111111111',
    '--install-machine-id',
    'BACKOFFICE-01',
    '--operator-name',
    'Installer Name',
    '--operator-role',
    'Store manager',
  ], 0);

  const kit = JSON.parse(kitRun.stdout);
  assert(kit.ok === true, 'pilot kit should pass');
  assert(kit.connector_mode === 'bridge_watch_folder', 'pilot kit should recommend bridge watch folder');
  assert(kit.field_sample_capture_method === 'pos_native_json_export', 'pilot kit should include field sample capture method');

  const profileOut = JSON.parse(await readFile(join(outputDir, 'pos-integration-profile.json'), 'utf8'));
  const fit = JSON.parse(await readFile(join(outputDir, 'pos-integration-fit.json'), 'utf8'));
  const site = JSON.parse(await readFile(join(outputDir, 'pos-pilot-site.template.json'), 'utf8'));
  const runbook = await readFile(join(outputDir, 'PILOT_RUNBOOK.md'), 'utf8');
  const command = await readFile(join(outputDir, 'go-live-command.ps1'), 'utf8');

  assert(profileOut.capabilities?.json_export === true, 'pilot kit should archive the original integration profile');
  assert(fit.ok === true, 'written integration-fit result should be ok');
  assert(site.business_name === 'Pilot Trade Pty Ltd', 'site template should use profile business name');
  assert(site.merchant_name === 'Pilot Trade', 'site template should use profile merchant name');
  assert(site.connector_mode === 'bridge_watch_folder', 'site template should carry connector mode');
  assert(site.receipt_trigger === 'pos_completed_tender', 'site template should carry receipt trigger');
  assert(site.receipt_source_format === 'pos_json_export', 'site template should carry source format');
  assert(site.field_sample_capture_method === 'pos_native_json_export', 'site template should carry field capture method');
  assert(site.looplet_organization_id === '11111111-1111-4111-8111-111111111111', 'site template should carry organization id when supplied');
  assert(runbook.includes('EFTPOS-only data is not enough'), 'runbook should explain EFTPOS-only limitation');
  assert(runbook.includes('go-live-command.ps1'), 'runbook should point to generated command');
  assert(runbook.includes('pos-pilot-report.md'), 'runbook should require redacted report archive');
  assert(runbook.includes('pos-integration-profile.json'), 'runbook should archive the source integration profile');
  assert(command.includes('go-live.mjs'), 'go-live command should call go-live');
  assert(command.includes('field-sample-capture.mjs'), 'go-live command should stage raw POS field samples first');
  assert(command.includes('$RawSale'), 'go-live command should require raw sale input');
  assert(command.includes('$RawRefund'), 'go-live command should require raw refund input');
  assert(command.includes('$RawVoid'), 'go-live command should require raw void input');
  assert(command.includes('field-sample-capture.json'), 'go-live command should save field-sample capture manifest');
  assert(command.includes('--preflight-only'), 'go-live command should run non-sending preflight first');
  assert(command.includes('pilot-report.mjs'), 'go-live command should generate pilot report');
  assert(command.includes('pilot-bundle.mjs'), 'go-live command should verify the final bundle');
  assert(command.includes('completion-audit.mjs'), 'go-live command should run the final completion audit');
  assert(command.includes('--require-production'), 'go-live command should require production audit evidence');
  assert(command.includes('pos-pilot-bundle.json'), 'go-live command should save bundle verification output');
  assert(command.includes('completion-audit.json'), 'go-live command should save completion audit output');
  assert(command.includes('pos-pilot-preflight.json'), 'go-live command should save preflight output');
  assert(command.includes('$LocalFullTrial'), 'go-live command should require the local full-trial artifact');
  assert(command.includes('Required go-live input is missing'), 'go-live command should fail clearly when an input is missing');
  assert(command.includes('pos-integration-profile.json'), 'go-live command should use the original integration profile');
  assert(!command.includes('pos-integration-fit.json'), 'go-live command should not feed the computed fit result back into integration-fit');
  assert(!/llp_[^\s]+|rhp_[^\s]+/.test(`${kitRun.stdout}\n${runbook}\n${command}`), 'pilot kit should not emit secrets');

  const badProfile = {
    ...profile,
    capabilities: {
      ...profile.capabilities,
      eftpos_only: true,
      itemised_lines: false,
      gst_breakdown: false,
    },
  };
  await writeFile(badProfileFile, `${JSON.stringify(badProfile, null, 2)}\n`);
  const badRun = await runNode(['examples/pos-bridge/pilot-kit.mjs', badProfileFile, '--output-dir', join(rootDir, 'bad-kit')], 1);
  const badResult = JSON.parse(badRun.stderr || badRun.stdout);
  assert(badResult.ok === false, 'EFTPOS-only profile should be rejected');
  assert(badResult.blockers.some((blocker) => blocker.includes('EFTPOS-only')), 'EFTPOS-only rejection should be explicit');

  console.log(JSON.stringify({
    ok: true,
    kit_generated: true,
    import_safe_integration_fit: importedFit.ok === true,
    profile_archived: profileOut.capabilities?.json_export === true,
    site_template_has_connector_recommendation: site.connector_mode === 'bridge_watch_folder',
    runbook_requires_real_pos_samples: runbook.includes('Capture these from the real POS path'),
    command_generates_report: command.includes('pilot-report.mjs'),
    command_stages_raw_field_samples: command.includes('field-sample-capture.mjs'),
    command_runs_non_sending_preflight: command.includes('--preflight-only'),
    command_verifies_bundle: command.includes('pilot-bundle.mjs'),
    command_runs_completion_audit: command.includes('completion-audit.mjs'),
    command_saves_bundle_output: command.includes('pos-pilot-bundle.json'),
    command_saves_completion_audit_output: command.includes('completion-audit.json'),
    command_saves_preflight_output: command.includes('pos-pilot-preflight.json'),
    command_preflights_local_full_trial: command.includes('$LocalFullTrial'),
    eftpos_only_rejected: badResult.ok === false,
    secrets_redacted: !/llp_[^\s]+|rhp_[^\s]+/.test(`${kitRun.stdout}\n${runbook}\n${command}`),
  }, null, 2));
}

async function runNode(args, expectedCode) {
  const result = await run(process.execPath, args);
  if (result.code !== expectedCode) {
    throw new Error(`node ${args.join(' ')} exited ${result.code}, expected ${expectedCode}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return result;
}

function run(command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
