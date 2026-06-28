const DEFAULT_SYNC_TARGETS = ['xero', 'myob', 'quickbooks', 'generic_api'] as const;

export interface PosBridgeEnvInput {
  supabaseUrl: string;
  apiKey: string;
  receiptIdentityToken: string;
  syncTargets?: readonly string[];
  inboxDir?: string;
  queueFile?: string;
  deadLetterFile?: string;
  logDir?: string;
  readinessSample?: string;
  minFileAgeMs?: number;
}

export function receiptWebhookUrlFromSupabaseUrl(supabaseUrl: string) {
  const base = normaliseUrl(supabaseUrl, 'Supabase URL');
  return `${base}/functions/v1/receipt-webhook`;
}

export function supabaseUrlFromReceiptWebhookUrl(webhookUrl: string) {
  const url = normaliseUrl(webhookUrl, 'receipt webhook URL');
  const suffix = '/functions/v1/receipt-webhook';
  if (!url.endsWith(suffix)) {
    throw new Error('Receipt webhook URL must end with /functions/v1/receipt-webhook');
  }
  return url.slice(0, -suffix.length);
}

export function buildPosBridgeEnv(input: PosBridgeEnvInput) {
  const webhookUrl = receiptWebhookUrlFromSupabaseUrl(input.supabaseUrl);
  assertLoopletSecret(input.apiKey, 'llp_', 'POS API key');
  assertLoopletSecret(input.receiptIdentityToken, 'rhp_', 'receipt identity token');

  const syncTargets = input.syncTargets?.length ? input.syncTargets : DEFAULT_SYNC_TARGETS;
  const lines = [
    '# Looplet POS receipt bridge',
    '# Save this file on the POS bridge machine. The secrets are shown once in Looplet.',
    '# LOOPLET_RECEIPT_IDENTITY_TOKEN is a fallback/readiness token.',
    '# Production POS exports should include the scanned customer identity_token per receipt.',
    `LOOPLET_RECEIPT_WEBHOOK_URL=${webhookUrl}`,
    `LOOPLET_POS_API_KEY=${input.apiKey}`,
    `LOOPLET_RECEIPT_IDENTITY_TOKEN=${input.receiptIdentityToken}`,
    `LOOPLET_SYNC_TARGETS=${syncTargets.join(',')}`,
    `LOOPLET_ACCEPTANCE_SUPABASE_URL=${supabaseUrlFromReceiptWebhookUrl(webhookUrl)}`,
    `LOOPLET_BRIDGE_QUEUE_FILE=${
      input.queueFile ?? String.raw`C:\ProgramData\Looplet\pos-bridge-queue.jsonl`
    }`,
    `LOOPLET_BRIDGE_DEAD_LETTER_FILE=${
      input.deadLetterFile ?? String.raw`C:\ProgramData\Looplet\pos-bridge-dead-letter.jsonl`
    }`,
    `LOOPLET_BRIDGE_INBOX_DIR=${input.inboxDir ?? String.raw`C:\ProgramData\Looplet\receipts-inbox`}`,
    `LOOPLET_BRIDGE_LOG_DIR=${input.logDir ?? String.raw`C:\ProgramData\Looplet\pos-bridge\logs`}`,
    `LOOPLET_BRIDGE_MIN_FILE_AGE_MS=${input.minFileAgeMs ?? 1000}`,
    `LOOPLET_READINESS_SAMPLE=${
      input.readinessSample ?? String.raw`C:\ProgramData\Looplet\pos-bridge\sample-receipt.json`
    }`,
    '',
  ];

  return lines.join('\n');
}

export function loopletSecretPrefix(secret: string) {
  return secret.split('.')[0] ?? secret;
}

export function redactLoopletSecret(secret: string) {
  const prefix = loopletSecretPrefix(secret);
  if (!prefix || !secret.includes('.')) return '[redacted]';
  return `${prefix}.[redacted]`;
}

function normaliseUrl(value: string, label: string) {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error(`${label} is required`);
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label} must be an HTTP(S) URL`);
  }
  return trimmed;
}

function assertLoopletSecret(value: string, prefix: string, label: string) {
  if (!value.startsWith(prefix) || !value.includes('.')) {
    throw new Error(`${label} must look like ${prefix}<prefix>.<secret>`);
  }
}
