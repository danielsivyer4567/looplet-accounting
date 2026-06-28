#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const rootDir = '.claude/scratch/pos-integration-fit-trial';

await rm(rootDir, { recursive: true, force: true });
await mkdir(rootDir, { recursive: true });

const baseCapabilities = {
  identity_capture_methods: ['barcode_scan'],
  receipt_triggers: ['pos_completed_tender'],
  itemised_lines: true,
  gst_breakdown: true,
  integer_cents: true,
  stable_event_id: true,
  payment_reference: true,
  refund_void_events: true,
  refund_void_original_reference: true,
  eftpos_only: false,
};

const cases = [
  {
    name: 'direct-webhook',
    expectOk: true,
    expectMode: 'direct_webhook',
    profile: {
      business_name: 'Direct Fit Pty Ltd',
      pos_vendor: 'Direct POS',
      capabilities: {
        ...baseCapabilities,
        custom_webhooks: true,
        custom_headers: true,
        json_body_mapping: true,
      },
    },
  },
  {
    name: 'json-bridge',
    expectOk: true,
    expectMode: 'bridge_watch_folder',
    profile: {
      business_name: 'Bridge Fit Pty Ltd',
      pos_vendor: 'Export POS',
      capabilities: {
        ...baseCapabilities,
        json_export: true,
        bridge_machine: bridgeMachine(),
      },
    },
  },
  {
    name: 'csv-bridge',
    expectOk: true,
    expectMode: 'bridge_csv_export',
    profile: {
      business_name: 'CSV Fit Pty Ltd',
      pos_vendor: 'CSV POS',
      capabilities: {
        ...baseCapabilities,
        csv_export: true,
        bridge_machine: bridgeMachine(),
      },
    },
  },
  {
    name: 'custom-middleware',
    expectOk: true,
    expectMode: 'custom_middleware',
    profile: {
      business_name: 'Middleware Fit Pty Ltd',
      pos_vendor: 'Cloud POS',
      capabilities: {
        ...baseCapabilities,
        vendor_cloud_events: true,
        middleware_can_store_secrets: true,
        middleware_outbound_https: true,
      },
    },
  },
  {
    name: 'eftpos-only-rejected',
    expectOk: false,
    expectBlocker: 'EFTPOS-only data is not enough',
    profile: {
      business_name: 'Payment Only Pty Ltd',
      pos_vendor: 'Payment Terminal',
      capabilities: {
        ...baseCapabilities,
        eftpos_only: true,
        itemised_lines: false,
        gst_breakdown: false,
        custom_webhooks: false,
      },
    },
  },
  {
    name: 'webhook-without-headers-rejected',
    expectOk: false,
    expectBlocker: 'No supported connector path',
    expectWarning: 'custom headers',
    profile: {
      business_name: 'Weak Webhook Pty Ltd',
      pos_vendor: 'Partial POS',
      capabilities: {
        ...baseCapabilities,
        custom_webhooks: true,
        custom_headers: false,
        json_body_mapping: true,
      },
    },
  },
];

const results = [];
for (const testCase of cases) {
  const profilePath = join(rootDir, `${testCase.name}.json`);
  await writeFile(profilePath, `${JSON.stringify(testCase.profile, null, 2)}\n`);
  const run = await runNode(['examples/pos-bridge/integration-fit.mjs', profilePath], testCase.expectOk ? 0 : 1);
  const result = JSON.parse(run.stdout);
  assert(result.ok === testCase.expectOk, `${testCase.name}: ok mismatch`);
  if (testCase.expectMode) {
    assert(result.recommendation?.connector_mode === testCase.expectMode, `${testCase.name}: connector mode mismatch`);
    assert(
      typeof result.recommendation?.field_sample_capture_method === 'string' &&
        result.recommendation.field_sample_capture_method.length > 0,
      `${testCase.name}: missing field sample capture method`,
    );
    assert(result.webhook_config?.headers?.Authorization === 'Bearer llp_<prefix>.<secret>', `${testCase.name}: missing webhook header template`);
    assert(result.next_steps.some((step) => step.includes('go-live.mjs')), `${testCase.name}: missing go-live next step`);
    assert(result.next_steps.some((step) => step.includes('--fit-profile')), `${testCase.name}: missing fit-profile go-live next step`);
  }
  if (testCase.expectBlocker) {
    assert(result.blockers.some((blocker) => blocker.includes(testCase.expectBlocker)), `${testCase.name}: missing blocker`);
  }
  if (testCase.expectWarning) {
    assert(result.warnings.some((warning) => warning.includes(testCase.expectWarning)), `${testCase.name}: missing warning`);
  }
  results.push({
    name: testCase.name,
    ok: result.ok,
    connector_mode: result.recommendation?.connector_mode ?? null,
    blockers: result.blockers.length,
    warnings: result.warnings.length,
  });
}

console.log(JSON.stringify({
  ok: true,
  cases: results,
}, null, 2));

function bridgeMachine() {
  return {
    available: true,
    node20_or_plugin_runtime: true,
    outbound_https: true,
    protected_secret_store: true,
  };
}

async function runNode(args, expectedCode) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const code = await new Promise((resolve) => child.on('exit', resolve));
  if (code !== expectedCode) {
    throw new Error(`${args.join(' ')} exited ${code}, expected ${expectedCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return { stdout, stderr };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
