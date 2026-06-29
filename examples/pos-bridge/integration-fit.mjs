#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const allowedIdentityCaptureMethods = new Set([
  'barcode_scan',
  'qr_scan',
  'nfc_pass',
  'pos_customer_account',
  'middleware_mapping',
  'manual_pilot_scan',
]);
const allowedReceiptTriggers = new Set([
  'pos_completed_tender',
  'pos_receipt_finalized',
  'pos_export_completed',
  'middleware_completed_tender',
]);

async function main() {
  const args = process.argv.slice(2);
  const file = args.shift();
  if (!file || args.length > 0) throw new Error(usage());

  const profile = JSON.parse(await readFile(file, 'utf8'));
  const result = assessIntegrationFit(profile);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

export function assessIntegrationFit(profile) {
  const capabilities = profile?.capabilities ?? {};
  const bridgeMachine = capabilities.bridge_machine ?? {};
  const blockers = [];
  const warnings = [];

  const identityCaptureMethod = firstAllowed(
    readList(capabilities.identity_capture_methods ?? capabilities.identity_capture_method),
    allowedIdentityCaptureMethods,
  );
  const receiptTrigger = firstAllowed(
    readList(capabilities.receipt_triggers ?? capabilities.receipt_trigger),
    allowedReceiptTriggers,
  );

  if (!profile || typeof profile !== 'object') blockers.push('profile must be a JSON object');
  if (!identityCaptureMethod) {
    blockers.push('POS path must capture a Looplet identity before payment by barcode, QR, NFC, customer account, or middleware mapping');
  }
  if (!receiptTrigger) {
    blockers.push('POS path must expose a completed receipt/tender trigger, not only a pending authorisation event');
  }
  if (isTrue(capabilities.eftpos_only)) {
    blockers.push('EFTPOS-only data is not enough unless it is matched back to the POS basket, receipt number, GST, and line items');
  }
  if (!isTrue(capabilities.itemised_lines)) blockers.push('POS path must include itemised receipt lines');
  if (!isTrue(capabilities.gst_breakdown)) blockers.push('POS path must include subtotal and GST cents');
  if (!isTrue(capabilities.integer_cents)) blockers.push('POS path must send amounts as integer cents');
  if (!isTrue(capabilities.stable_event_id)) blockers.push('POS path must supply a stable receipt/payment event id for Idempotency-Key');
  if (!isTrue(capabilities.payment_reference)) blockers.push('POS path must include a payment reference or POS tender reference');
  if (!isTrue(capabilities.refund_void_events)) blockers.push('POS path must expose completed refund and void/cancellation events');
  if (!isTrue(capabilities.refund_void_original_reference)) {
    blockers.push('Refund/void path must include the original sale receipt number or original POS event id');
  }

  const directReady = isTrue(capabilities.custom_webhooks) &&
    isTrue(capabilities.custom_headers) &&
    isTrue(capabilities.json_body_mapping);
  const bridgeRuntimeReady = isTrue(bridgeMachine.available) &&
    isTrue(bridgeMachine.node20_or_plugin_runtime) &&
    isTrue(bridgeMachine.outbound_https) &&
    isTrue(bridgeMachine.protected_secret_store);
  const bridgeJsonReady = isTrue(capabilities.json_export) && bridgeRuntimeReady;
  const bridgeCsvReady = isTrue(capabilities.csv_export) && bridgeRuntimeReady;
  const customReady = (
    isTrue(capabilities.pos_plugin_sdk) ||
    isTrue(capabilities.vendor_cloud_events) ||
    isTrue(capabilities.vendor_api_polling) ||
    isTrue(capabilities.custom_middleware_available)
  ) && isTrue(capabilities.middleware_can_store_secrets) && isTrue(capabilities.middleware_outbound_https);

  if (isTrue(capabilities.custom_webhooks) && !directReady) {
    warnings.push('POS has webhooks, but direct mode still needs custom headers and JSON body mapping');
  }
  if ((isTrue(capabilities.json_export) || isTrue(capabilities.csv_export)) && !bridgeRuntimeReady) {
    warnings.push('POS export is available, but a bridge needs Node.js 20+ or equivalent runtime, outbound HTTPS, and protected secret storage');
  }

  const recommendation = pickRecommendation({
    directReady,
    bridgeJsonReady,
    bridgeCsvReady,
    customReady,
    identityCaptureMethod,
    receiptTrigger,
  });

  if (!recommendation) {
    blockers.push('No supported connector path is ready: enable direct webhooks, a POS plugin/cloud middleware, or a local JSON/CSV bridge export');
  }

  const ok = blockers.length === 0 && Boolean(recommendation);
  if (ok) {
    warnings.push('This fit check is not go-live evidence; still run go-live.mjs with real POS sale/refund/void field samples');
  }

  return {
    ok,
    checked_at: new Date().toISOString(),
    business_name: textOrNull(profile?.business_name),
    pos_vendor: textOrNull(profile?.pos_vendor),
    pos_product: textOrNull(profile?.pos_product),
    recommendation,
    blockers,
    warnings,
    required_business_install: recommendation ? installRequirements(recommendation.connector_mode) : [],
    next_steps: ok
      ? nextSteps(recommendation.connector_mode)
      : [
          'Fix every blocker above before creating go-live field evidence.',
          'If the source is EFTPOS-only, connect the POS basket/receipt export or vendor API before sending receipts to Looplet.',
        ],
    webhook_config: recommendation ? {
      endpoint: 'https://<supabase-project>.supabase.co/functions/v1/receipt-webhook',
      headers: {
        Authorization: 'Bearer llp_<prefix>.<secret>',
        'Idempotency-Key': '<stable POS receipt/payment event id>',
        'Content-Type': 'application/json',
      },
    } : null,
  };
}

function pickRecommendation(options) {
  const common = {
    identity_capture_method: options.identityCaptureMethod,
    receipt_trigger: options.receiptTrigger,
  };
  if (options.directReady) {
    return {
      ...common,
      connector_mode: 'direct_webhook',
      receipt_source_format: 'direct_json_webhook',
      field_sample_capture_method: 'pos_webhook_capture',
      reason: 'POS can send authenticated custom JSON webhooks with stable retry keys',
    };
  }
  if (options.bridgeJsonReady) {
    return {
      ...common,
      connector_mode: 'bridge_watch_folder',
      receipt_source_format: 'pos_json_export',
      field_sample_capture_method: 'pos_native_json_export',
      reason: 'POS can export completed JSON receipts and the business can run the Looplet bridge',
    };
  }
  if (options.bridgeCsvReady) {
    return {
      ...common,
      connector_mode: 'bridge_csv_export',
      receipt_source_format: 'pos_csv_export',
      field_sample_capture_method: 'pos_native_csv_export',
      reason: 'POS can export completed CSV receipts and the business can run the Looplet CSV bridge',
    };
  }
  if (options.customReady) {
    return {
      ...common,
      connector_mode: 'custom_middleware',
      receipt_source_format: 'custom_middleware',
      field_sample_capture_method: 'middleware_capture',
      reason: 'A plugin, cloud event stream, vendor API poller, or custom middleware can map completed receipts to Looplet',
    };
  }
  return null;
}

function installRequirements(connectorMode) {
  if (connectorMode === 'direct_webhook') {
    return [
      'Configure the POS webhook URL, bearer API key, Idempotency-Key header, and JSON payload mapping.',
      'Store the Looplet API key in the POS/vendor secret store.',
      'Capture the customer Looplet identity at checkout and include it on each receipt payload.',
    ];
  }
  if (connectorMode === 'bridge_watch_folder' || connectorMode === 'bridge_csv_export') {
    return [
      'Install the Looplet POS bridge package on a back-office PC/server or equivalent runtime.',
      'Install Node.js 20+ or use an equivalent POS plugin runtime.',
      'Allow outbound HTTPS to the Supabase project; no inbound firewall rule is required.',
      'Protect C:\\ProgramData\\Looplet\\pos-bridge.env because it contains the Looplet API key.',
      'Configure the POS export job to write completed receipts into the bridge inbox.',
    ];
  }
  return [
    'Deploy the vendor plugin, cloud connector, API poller, or custom middleware.',
    'Store the Looplet API key in that runtime secret store.',
    'Map only final completed sale/refund/void events to the Looplet receipt payload.',
  ];
}

function nextSteps(connectorMode) {
  const steps = [
    'Fill pos-pilot-site.json with the POS merchant_name plus the recommended connector_mode, identity_capture_method, receipt_trigger, receipt_source_format, and field_sample_capture_method.',
    'Capture real POS sale, refund, and void field samples from the business path.',
    'Run go-live.mjs with --site-file, --fit-profile, --sale, --refund, --void, and --output.',
  ];
  if (connectorMode === 'bridge_watch_folder' || connectorMode === 'bridge_csv_export') {
    steps.unshift('Run readiness.mjs, credential-probe.mjs, status.mjs, and bridge-retry-drill.mjs from the installed bridge.');
  } else {
    steps.unshift('Run readiness/credential proof for the endpoint and API key before sending live acceptance receipts.');
  }
  return steps;
}

function readList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  return [];
}

function firstAllowed(values, allowed) {
  return values.find((value) => allowed.has(value)) ?? null;
}

function isTrue(value) {
  return value === true;
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function usage() {
  return 'usage: node integration-fit.mjs <pos-integration-profile.json>';
}

if (isCliEntrypoint()) {
  await main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exit(1);
  });
}

function isCliEntrypoint() {
  return process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}
