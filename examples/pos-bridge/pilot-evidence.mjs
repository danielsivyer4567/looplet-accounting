#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import {
  receiptEventType,
  receiptSource,
  stableIdempotencyKey,
  validateReceiptContract,
} from './contract.mjs';

const defaultSamples = ['sample-receipt.json', 'sample-refund.json', 'sample-void.json'];
const bundledSampleContentFingerprints = new Set([
  'c1f7ec8c3aa665899639046306ef3b78c7fa603e8751f5bf58d27a739978cc6c',
  '1f91db564f57ff0c7e756e48510b3aa72ef3bd6d5bcfc2f565eba40d40ed35fe',
  '1ded54d83ce273447eb15f7b1c91e6862cbb1ed43703a393d15e0ab66aab4195',
]);
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
const allowedReceiptSourceFormats = new Set([
  'direct_json_webhook',
  'pos_json_export',
  'pos_csv_export',
  'vendor_api_poll',
  'custom_middleware',
]);
const allowedFieldSampleCaptureMethods = new Set([
  'pos_webhook_capture',
  'pos_native_json_export',
  'pos_native_csv_export',
  'pos_vendor_api_pull',
  'middleware_capture',
]);
const sourceFormatsByConnectorMode = {
  direct_webhook: new Set(['direct_json_webhook']),
  bridge_watch_folder: new Set(['pos_json_export']),
  bridge_csv_export: new Set(['pos_csv_export']),
  custom_middleware: new Set(['vendor_api_poll', 'custom_middleware', 'direct_json_webhook']),
};
const captureMethodsBySourceFormat = {
  direct_json_webhook: new Set(['pos_webhook_capture']),
  pos_json_export: new Set(['pos_native_json_export']),
  pos_csv_export: new Set(['pos_native_csv_export']),
  vendor_api_poll: new Set(['pos_vendor_api_pull']),
  custom_middleware: new Set(['middleware_capture']),
};

async function main() {
  const args = process.argv.slice(2);
  const envFileOption = readOption(args, '--env-file');
  const envFile = envFileOption ? resolve(envFileOption) : null;
  if (envFile) await loadEnvFile(envFile);
  const outputFile = readOption(args, '--output') ?? process.env.LOOPLET_PILOT_EVIDENCE_FILE ?? null;
  const siteFile = readOption(args, '--site-file');
  const fitProfile = readOption(args, '--fit-profile');
  const fieldSamplePaths = {
    sale: readOption(args, '--sale'),
    refund: readOption(args, '--refund'),
    void: readOption(args, '--void'),
  };
  const includeAcceptance = args.includes('--acceptance');
  removeFlag(args, '--acceptance');
  const skipNetwork = args.includes('--skip-network') || process.env.LOOPLET_READINESS_SKIP_NETWORK === '1';
  removeFlag(args, '--skip-network');
  const skipCredentialProbe = args.includes('--skip-credential-probe') || skipNetwork;
  removeFlag(args, '--skip-credential-probe');

  if (args.length > 0) throw new Error(`unsupported arguments: ${args.join(' ')}`);

  const envArgs = envFile ? ['--env-file', envFile] : [];
  const site = siteFile ? await loadSiteFile(siteFile) : {
    provided: false,
    ok: false,
    reason: 'no site manifest supplied; pass --site-file for go-live evidence',
  };
  const integrationFit = fitProfile
    ? {
        provided: true,
        profile_file: basename(fitProfile),
        ...(await runJsonCommand('integration_fit', ['integration-fit.mjs', resolve(fitProfile)], { allowFailure: true })),
      }
    : {
        provided: false,
        ok: false,
        reason: 'no integration fit profile supplied; pass --fit-profile for go-live evidence',
      };
  const fieldSamples = await validateFieldSamples(fieldSamplePaths, site);
  const acceptanceSampleArgs = acceptanceArgs(fieldSamplePaths);
  const readiness = await runJsonCommand('readiness', [
    'readiness.mjs',
    ...envArgs,
    ...(skipNetwork ? ['--skip-network'] : []),
  ], { allowFailure: false });
  const status = await runJsonCommand('status', ['status.mjs', ...envArgs], { allowFailure: true });
  const credentialProbe = skipCredentialProbe
    ? {
        skipped: true,
        reason: skipNetwork
          ? 'network check skipped'
          : 'credential probe not requested',
      }
    : await runJsonCommand('credential_probe', ['credential-probe.mjs', ...envArgs], {
        allowFailure: false,
      });
  const bridgeRetryDrill = requiresLocalBridgeRetryDrill(site)
    ? fieldSamplePaths.sale
      ? await runJsonCommand('bridge_retry_drill', [
          'bridge-retry-drill.mjs',
          ...envArgs,
          '--sample',
          resolve(fieldSamplePaths.sale),
        ], { allowFailure: false })
      : {
          ok: false,
          skipped: false,
          error: 'local bridge retry drill requires a --sale field sample',
        }
    : {
        skipped: true,
      reason: 'not required for this connector mode',
    };
  const samples = await validateSamples();
  const sitePreflightOk = site.provided !== true || site.ok === true;
  const integrationFitPreflightOk = integrationFit.provided !== true || integrationFit.ok === true;
  const fieldSamplesPreflightOk = fieldSamples.provided !== true || fieldSamples.ok === true;
  const acceptancePreflightOk = site.ok === true && fieldSamples.ok === true && integrationFit.ok === true;
  const acceptance = includeAcceptance
    ? acceptancePreflightOk
      ? await runJsonCommand('acceptance', ['acceptance.mjs', ...envArgs, ...acceptanceSampleArgs], {
          allowFailure: false,
        })
      : {
          skipped: true,
          ok: false,
          reason: 'acceptance skipped because the site manifest, integration fit, or field POS samples failed preflight validation',
        }
    : { skipped: true, reason: 'acceptance not requested; run with --acceptance during staging/pilot' };

  const evidence = redactDeep({
    ok: readiness.ok === true &&
      status.ok === true &&
      sitePreflightOk &&
      integrationFitPreflightOk &&
      fieldSamplesPreflightOk &&
      (credentialProbe.skipped === true || credentialProbe.ok === true) &&
      (bridgeRetryDrill.skipped === true || bridgeRetryDrill.ok === true) &&
      samples.every((sample) => sample.ok === true) &&
      (acceptance.skipped === true || acceptance.ok === true) &&
      (!includeAcceptance || (site.ok === true && integrationFit.ok === true && fieldSamples.ok === true)),
    collected_at: new Date().toISOString(),
    node_version: process.version,
    env_file_used: Boolean(envFile),
    non_sending: includeAcceptance !== true,
    credential_probe_non_persistent: credentialProbe.skipped !== true,
    site,
    integration_fit: integrationFit,
    readiness,
    status,
    credential_probe: credentialProbe,
    bridge_retry_drill: bridgeRetryDrill,
    samples,
    field_samples: fieldSamples,
    acceptance,
  });

  if (outputFile) {
    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.ok) process.exit(1);
}

async function validateSamples() {
  const rows = [];
  for (const samplePath of defaultSamples) {
    const receipt = JSON.parse(await readFile(resolveLocal(samplePath), 'utf8'));
    const payload = receipt.payload ?? receipt;
    const errors = validateReceiptContract(receipt);
    if (errors.length > 0) {
      rows.push({ file: samplePath, ok: false, errors });
      continue;
    }

    const eventType = receiptEventType(receipt, payload);
    rows.push({
      file: samplePath,
      ok: true,
      source_channel: receiptSource(receipt.source_channel ?? 'pos'),
      event_type: eventType,
      idempotency_key: stableIdempotencyKey(receipt, payload, eventType),
      receipt_number: payload.receipt?.number ?? null,
      total_inc_gst_cents: payload.receipt?.total_inc_gst_cents ?? null,
      line_count: Array.isArray(payload.line_items) ? payload.line_items.length : 0,
    });
  }
  return rows;
}

async function loadSiteFile(file) {
  const site = JSON.parse(await readFile(resolve(file), 'utf8'));
  const errors = validateSiteManifestPreflight(site);
  return {
    provided: true,
    file: basename(file),
    ...site,
    ok: errors.length === 0,
    errors,
  };
}

function validateSiteManifestPreflight(site) {
  const errors = [];
  const requiredText = [
    'business_name',
    'merchant_name',
    'pilot_id',
    'pilot_window_start',
    'pilot_window_end',
    'pos_vendor',
    'connector_mode',
    'identity_capture_method',
    'receipt_trigger',
    'receipt_source_format',
    'field_sample_capture_method',
    'integration_owner',
    'install_machine_id',
    'operator_name',
    'operator_role',
    'looplet_organization_id',
  ];

  for (const field of requiredText) {
    if (typeof site?.[field] !== 'string' || site[field].trim().length < 2) {
      errors.push(`site manifest ${field} is required`);
    }
  }
  for (const field of ['business_name', 'merchant_name', 'pos_vendor', 'operator_name', 'pilot_id']) {
    if (looksLikePlaceholder(site?.[field])) errors.push(`site manifest ${field} must not be a placeholder`);
  }
  if (!isUuid(site?.looplet_organization_id)) {
    errors.push('site manifest looplet_organization_id must be a UUID');
  } else if (site.looplet_organization_id === '00000000-0000-0000-0000-000000000000') {
    errors.push('site manifest looplet_organization_id must not be the placeholder UUID');
  }
  if (!isIsoLikeDate(site?.pilot_window_start)) errors.push('site manifest pilot_window_start must be a parseable date/time');
  if (!isIsoLikeDate(site?.pilot_window_end)) errors.push('site manifest pilot_window_end must be a parseable date/time');
  if (isIsoLikeDate(site?.pilot_window_start) && isIsoLikeDate(site?.pilot_window_end)) {
    const windowStart = new Date(site.pilot_window_start).getTime();
    const windowEnd = new Date(site.pilot_window_end).getTime();
    if (windowEnd <= windowStart) errors.push('site manifest pilot_window_end must be after pilot_window_start');
  }
  if (!['direct_webhook', 'bridge_watch_folder', 'bridge_csv_export', 'custom_middleware'].includes(site?.connector_mode)) {
    errors.push('site manifest connector_mode must be direct_webhook, bridge_watch_folder, bridge_csv_export, or custom_middleware');
  }
  if (!allowedIdentityCaptureMethods.has(site?.identity_capture_method)) {
    errors.push('site manifest identity_capture_method must be barcode_scan, qr_scan, nfc_pass, pos_customer_account, middleware_mapping, or manual_pilot_scan');
  }
  if (!allowedReceiptTriggers.has(site?.receipt_trigger)) {
    errors.push('site manifest receipt_trigger must be pos_completed_tender, pos_receipt_finalized, pos_export_completed, or middleware_completed_tender');
  }
  if (!allowedReceiptSourceFormats.has(site?.receipt_source_format)) {
    errors.push('site manifest receipt_source_format must be direct_json_webhook, pos_json_export, pos_csv_export, vendor_api_poll, or custom_middleware');
  }
  if (!allowedFieldSampleCaptureMethods.has(site?.field_sample_capture_method)) {
    errors.push('site manifest field_sample_capture_method must be pos_webhook_capture, pos_native_json_export, pos_native_csv_export, pos_vendor_api_pull, or middleware_capture');
  }
  const sourceFormats = sourceFormatsByConnectorMode[site?.connector_mode];
  if (sourceFormats && !sourceFormats.has(site?.receipt_source_format)) {
    errors.push(`site manifest connector_mode ${site.connector_mode} is not compatible with receipt_source_format ${site?.receipt_source_format ?? '<missing>'}`);
  }
  const captureMethods = captureMethodsBySourceFormat[site?.receipt_source_format];
  if (captureMethods && !captureMethods.has(site?.field_sample_capture_method)) {
    errors.push(`site manifest receipt_source_format ${site.receipt_source_format} is not compatible with field_sample_capture_method ${site?.field_sample_capture_method ?? '<missing>'}`);
  }

  return errors;
}

async function validateFieldSamples(paths, site) {
  const provided = Object.values(paths).some(Boolean);
  if (!provided) {
    return {
      provided: false,
      ok: false,
      reason: 'no field POS payload samples supplied; pass --sale, --refund and --void for go-live evidence',
      samples: [],
    };
  }

  const samples = [];
  const pilotWindow = pilotWindowBounds(site);
  for (const eventType of ['sale', 'refund', 'void']) {
    const path = paths[eventType];
    if (!path) {
      samples.push({
        event_type: eventType,
        ok: false,
        errors: [`missing --${eventType} field sample`],
      });
      continue;
    }

    const receipt = JSON.parse(await readFile(resolve(path), 'utf8'));
    const payload = receipt.payload ?? receipt;
    const errors = validateReceiptContract(receipt);
    const fileName = basename(path);
    let actualEventType = eventType;
    try {
      actualEventType = receiptEventType(receipt, payload);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    let sourceChannel = null;
    try {
      sourceChannel = receiptSource(receipt.source_channel ?? 'pos');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (actualEventType !== eventType) {
      errors.push(`expected ${eventType} sample, got ${actualEventType}`);
    }
    const identityTokenSource = receiptIdentityTokenSource(receipt, payload);
    if (!identityTokenSource) {
      errors.push('field POS sample must include the scanned customer identity_token');
    }
    const sampleFingerprint = redactedSampleSha256(receipt);
    const contentFingerprint = sampleContentSha256WithoutIdentity(receipt);
    const bundledSample = defaultSamples.includes(fileName) ||
      bundledSampleContentFingerprints.has(contentFingerprint);
    const purchaseAt = normalizeDateTime(payload.receipt?.purchase_at);
    const withinPilotWindow = pilotWindow
      ? purchaseAt != null && isWithinPilotWindow(purchaseAt, pilotWindow)
      : null;
    const merchantName = payload.merchant?.name ?? null;
    const merchantNameMatchesSite = hasText(site?.merchant_name)
      ? sameText(merchantName, site.merchant_name)
      : null;
    if (pilotWindow && withinPilotWindow !== true) {
      errors.push(`field POS ${eventType} sample purchase_at must fall within the pilot window`);
    }
    if (merchantNameMatchesSite === false) {
      errors.push(`field POS ${eventType} sample merchant.name must match the site manifest merchant_name`);
    }

    samples.push({
      file: fileName,
      ok: errors.length === 0,
      errors,
      bundled_sample: bundledSample,
      bundled_sample_reason: bundledSample
        ? defaultSamples.includes(fileName)
          ? 'bundled sample filename'
          : 'bundled sample content fingerprint'
        : null,
      source_channel: sourceChannel,
      event_type: actualEventType,
      identity_token_source: identityTokenSource,
      redacted_sample_sha256: sampleFingerprint,
      content_sha256_without_identity: contentFingerprint,
      idempotency_key: errors.length === 0 ? stableIdempotencyKey(receipt, payload, actualEventType) : null,
      merchant_name: merchantName,
      merchant_name_matches_site: merchantNameMatchesSite,
      receipt_number: payload.receipt?.number ?? null,
      external_event_id: payload.receipt?.external_event_id ?? null,
      original_receipt_number: payload.receipt?.original_receipt_number ?? null,
      original_external_event_id: payload.receipt?.original_external_event_id ?? null,
      original_reference_matches_sale: actualEventType === 'sale' ? null : false,
      purchase_at: purchaseAt,
      pilot_window_checked: pilotWindow != null,
      within_pilot_window: withinPilotWindow,
      total_inc_gst_cents: payload.receipt?.total_inc_gst_cents ?? null,
      line_count: Array.isArray(payload.line_items) ? payload.line_items.length : 0,
    });
  }

  validateFieldSampleRelationships(samples);
  for (const sample of samples) {
    if (Array.isArray(sample.errors)) sample.ok = sample.errors.length === 0;
  }

  return {
    provided: true,
    ok: samples.every((sample) => sample.ok === true && sample.bundled_sample !== true),
    samples,
  };
}

function validateFieldSampleRelationships(samples) {
  const sale = samples.find((sample) => sample.event_type === 'sale');
  if (!sale?.receipt_number && !sale?.external_event_id) return;

  for (const eventType of ['refund', 'void']) {
    const sample = samples.find((row) => row.event_type === eventType);
    if (!sample || !Array.isArray(sample.errors)) continue;
    const receiptMatches = hasText(sample.original_receipt_number) &&
      hasText(sale.receipt_number) &&
      normalizeText(sample.original_receipt_number) === normalizeText(sale.receipt_number);
    const externalEventMatches = hasText(sample.original_external_event_id) &&
      hasText(sale.external_event_id) &&
      normalizeText(sample.original_external_event_id) === normalizeText(sale.external_event_id);
    sample.original_reference_matches_sale = receiptMatches || externalEventMatches;
    if (sample.original_reference_matches_sale !== true) {
      sample.errors.push(`field POS ${eventType} sample original reference must match the sale field sample`);
    }
  }
}

function redactedSampleSha256(receipt) {
  return createHash('sha256')
    .update(JSON.stringify(redactDeep(receipt)))
    .digest('hex');
}

function sampleContentSha256WithoutIdentity(receipt) {
  return createHash('sha256')
    .update(JSON.stringify(stripReceiptIdentities(receipt)))
    .digest('hex');
}

function stripReceiptIdentities(value) {
  const cloned = JSON.parse(JSON.stringify(value));
  delete cloned.identity_token;
  if (cloned.payload?.receipt && typeof cloned.payload.receipt === 'object') {
    delete cloned.payload.receipt.identity_token;
  }
  if (cloned.payload?.customer && typeof cloned.payload.customer === 'object') {
    delete cloned.payload.customer.looplet_identity_token;
  }
  return redactDeep(cloned);
}

function receiptIdentityTokenSource(receipt, payload) {
  if (looksLikeReceiptIdentityToken(receipt.identity_token)) return 'receipt';
  if (looksLikeReceiptIdentityToken(payload.receipt?.identity_token)) return 'payload.receipt';
  if (looksLikeReceiptIdentityToken(payload.customer?.looplet_identity_token)) return 'payload.customer';
  return null;
}

function looksLikeReceiptIdentityToken(value) {
  return typeof value === 'string' && /^rhp_[^.]+\..+/.test(value.trim());
}

function normalizeDateTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pilotWindowBounds(site) {
  const start = dateTimeMs(site?.pilot_window_start);
  const end = dateTimeMs(site?.pilot_window_end);
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

function dateTimeMs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function isWithinPilotWindow(value, pilotWindow) {
  const time = dateTimeMs(value);
  return time != null && time >= pilotWindow.start && time <= pilotWindow.end;
}

function isIsoLikeDate(value) {
  return typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(new Date(value).getTime());
}

function isUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function looksLikePlaceholder(value) {
  if (typeof value !== 'string') return true;
  const normal = value.trim().toLowerCase();
  return !normal ||
    normal.includes('example') ||
    normal.includes('installer name') ||
    normal === 'todo' ||
    normal === 'tbd' ||
    normal === '<replace>';
}

function sameText(left, right) {
  return hasText(left) && hasText(right) && normalizeText(left) === normalizeText(right);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeText(value) {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function acceptanceArgs(paths) {
  const result = [];
  for (const eventType of ['sale', 'refund', 'void']) {
    if (paths[eventType]) result.push(`--${eventType}`, paths[eventType]);
  }
  return result;
}

function requiresLocalBridgeRetryDrill(site) {
  return ['bridge_watch_folder', 'bridge_csv_export'].includes(site?.connector_mode);
}

async function runJsonCommand(name, commandArgs, options) {
  const child = spawn(process.execPath, commandArgs.map(resolveLocal), {
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
  const parsed = parseJsonOutput(stdout);
  if (code !== 0 && !options.allowFailure) {
    return {
      ok: false,
      command: name,
      exit_code: code,
      error: parsed?.error ?? redactSecrets(stderr.trim() || stdout.trim() || `${name} failed`),
    };
  }
  return {
    command: name,
    exit_code: code,
    ...(parsed ?? { ok: false, error: redactSecrets(stderr.trim() || stdout.trim() || `${name} did not emit JSON`) }),
  };
}

function parseJsonOutput(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function removeFlag(args, name) {
  const index = args.indexOf(name);
  if (index !== -1) args.splice(index, 1);
}

async function loadEnvFile(file) {
  const content = await readFile(file, 'utf8');
  for (const [lineNumber, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equalsAt = line.indexOf('=');
    if (equalsAt <= 0) throw new Error(`${file}:${lineNumber + 1} must be KEY=value`);
    const key = line.slice(0, equalsAt).trim();
    const value = unquoteEnvValue(line.slice(equalsAt + 1).trim());
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`${file}:${lineNumber + 1} has invalid env key ${key}`);
    process.env[key] = value;
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function redactDeep(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)]));
  }
  return value;
}

function redactSecrets(value) {
  return value
    .replace(/llp_[^\s"',}]+/g, 'llp_[redacted]')
    .replace(/rhp_[^\s"',}]+/g, 'rhp_[redacted]');
}

function resolveLocal(value) {
  if (value.startsWith('--')) return value;
  if (value.endsWith('.mjs') || defaultSamples.includes(value)) return join(scriptDir(), value);
  return value;
}

function scriptDir() {
  return new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:\/)/, '$1');
}

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? redactSecrets(error.message) : redactSecrets(String(error)),
  }, null, 2));
  process.exit(1);
});
