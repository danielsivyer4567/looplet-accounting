import { describe, expect, it } from 'vitest';
import {
  buildPosBridgeEnv,
  receiptWebhookUrlFromSupabaseUrl,
  redactLoopletSecret,
  supabaseUrlFromReceiptWebhookUrl,
} from '@/lib/receiptBridgeSetup';

describe('receipt bridge setup helpers', () => {
  it('derives the receipt webhook URL from the Supabase project URL', () => {
    expect(receiptWebhookUrlFromSupabaseUrl('https://looplet.supabase.co/')).toBe(
      'https://looplet.supabase.co/functions/v1/receipt-webhook',
    );
  });

  it('derives the Supabase URL from the receipt webhook URL', () => {
    expect(
      supabaseUrlFromReceiptWebhookUrl(
        'https://looplet.supabase.co/functions/v1/receipt-webhook',
      ),
    ).toBe('https://looplet.supabase.co');
  });

  it('builds the exact env file the POS bridge expects', () => {
    const env = buildPosBridgeEnv({
      supabaseUrl: 'https://looplet.supabase.co',
      apiKey: 'llp_merchant.abcdef123456',
      receiptIdentityToken: 'rhp_buyer.receiptsecret',
      syncTargets: ['xero'],
      inboxDir: String.raw`D:\Looplet\inbox`,
      queueFile: String.raw`D:\Looplet\queue.jsonl`,
      deadLetterFile: String.raw`D:\Looplet\dead-letter.jsonl`,
      logDir: String.raw`D:\Looplet\logs`,
      readinessSample: String.raw`D:\Looplet\sample-receipt.json`,
      minFileAgeMs: 1500,
    });

    expect(env).toContain(
      'LOOPLET_RECEIPT_WEBHOOK_URL=https://looplet.supabase.co/functions/v1/receipt-webhook',
    );
    expect(env).toContain('LOOPLET_POS_API_KEY=llp_merchant.abcdef123456');
    expect(env).toContain('Production POS exports should include the scanned customer identity_token per receipt.');
    expect(env).toContain('LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_buyer.receiptsecret');
    expect(env).toContain('LOOPLET_SYNC_TARGETS=xero');
    expect(env).toContain('LOOPLET_ACCEPTANCE_SUPABASE_URL=https://looplet.supabase.co');
    expect(env).toContain(String.raw`LOOPLET_BRIDGE_INBOX_DIR=D:\Looplet\inbox`);
    expect(env).toContain(String.raw`LOOPLET_BRIDGE_QUEUE_FILE=D:\Looplet\queue.jsonl`);
    expect(env).toContain(
      String.raw`LOOPLET_BRIDGE_DEAD_LETTER_FILE=D:\Looplet\dead-letter.jsonl`,
    );
    expect(env).toContain(String.raw`LOOPLET_BRIDGE_LOG_DIR=D:\Looplet\logs`);
    expect(env).toContain('LOOPLET_BRIDGE_MIN_FILE_AGE_MS=1500');
  });

  it('rejects malformed credentials before they are shown to a merchant', () => {
    expect(() =>
      buildPosBridgeEnv({
        supabaseUrl: 'https://looplet.supabase.co',
        apiKey: 'bad',
        receiptIdentityToken: 'rhp_buyer.receiptsecret',
      }),
    ).toThrow(/POS API key/);

    expect(() =>
      buildPosBridgeEnv({
        supabaseUrl: 'https://looplet.supabase.co',
        apiKey: 'llp_merchant.abcdef123456',
        receiptIdentityToken: 'bad',
      }),
    ).toThrow(/receipt identity token/);
  });

  it('redacts Looplet secrets without leaking the secret suffix', () => {
    const redacted = redactLoopletSecret('llp_merchant.abcdef123456');

    expect(redacted).toBe('llp_merchant.[redacted]');
    expect(redacted).not.toContain('abcdef123456');
  });
});
