// Deno tests for the OCR provider fallback chain (index.ts).
// Run: deno test --allow-all supabase/functions/_shared/ocr/index.test.ts
//
// Verifies the cross-provider fallback the "a fallback for every method" hardening
// added: a single-provider failure falls through to the next configured provider,
// all-fail surfaces one aggregated error, and no configured provider degrades to a
// manual-entry stub rather than throwing.

import { assertEquals, assertRejects, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { extractBillData, getActiveProvider } from './index.ts';

const VALID_BILL_JSON = JSON.stringify({
  supplier_name: 'Test Supplier',
  supplier_abn: null,
  invoice_number: 'INV-1',
  invoice_date: '2026-06-30',
  due_date: null,
  subtotal_ex_gst: null,
  gst_amount: null,
  total_inc_gst: 100,
  currency: 'AUD',
  line_items: [],
  job_reference: null,
  document_kind: 'invoice',
  confidence: 'high',
  notes: '',
});

function anthropicOk(): Response {
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text: VALID_BILL_JSON }] }),
    { status: 200 },
  );
}

async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  const originalFetch = globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(vars)) {
      const p = prior[k];
      if (p === undefined) Deno.env.delete(k);
      else Deno.env.set(k, p);
    }
  }
}

// Isolate the candidate set to exactly [minimax, anthropic] regardless of the host env.
const TWO_PROVIDER_ENV = {
  OCR_PROVIDER: 'minimax',
  MINIMAX_API_KEY: 'mm',
  ANTHROPIC_API_KEY: 'an',
  OPENAI_API_KEY: '',
  GROQ_API_KEY: '',
};

Deno.test('extractBillData falls through to the next provider when the first fails', async () => {
  await withEnv(TWO_PROVIDER_ENV, async () => {
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('minimax')) return Promise.resolve(new Response('upstream error', { status: 500 }));
      if (url.includes('anthropic')) return Promise.resolve(anthropicOk());
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;

    const result = await extractBillData(new Uint8Array([1, 2, 3]), 'image/png');
    assertEquals(result.provider, 'anthropic');
    assertEquals(result.data.supplier_name, 'Test Supplier');
  });
});

Deno.test('getActiveProvider prefers MiniMax over legacy Groq when both are configured', async () => {
  await withEnv(
    {
      OCR_PROVIDER: '',
      MINIMAX_API_KEY: 'mm',
      ANTHROPIC_API_KEY: 'an',
      OPENAI_API_KEY: 'op',
      GROQ_API_KEY: 'gr',
    },
    async () => {
      assertEquals(getActiveProvider(), 'minimax');
    },
  );
});

Deno.test('extractBillData sends PDFs to Anthropic as native document blocks when selected', async () => {
  await withEnv(
    {
      OCR_PROVIDER: 'anthropic',
      MINIMAX_API_KEY: '',
      ANTHROPIC_API_KEY: 'an',
      OPENAI_API_KEY: '',
      GROQ_API_KEY: '',
    },
    async () => {
      let capturedBody: Record<string, unknown> | null = null;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes('anthropic')) {
          return Promise.resolve(new Response('not found', { status: 404 }));
        }
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Promise.resolve(anthropicOk());
      }) as typeof fetch;

      const result = await extractBillData(new Uint8Array([37, 80, 68, 70]), 'application/pdf');
      assertEquals(result.provider, 'anthropic');
      assertEquals(result.data.supplier_name, 'Test Supplier');

      const messages = (capturedBody?.['messages'] ?? []) as unknown as {
        content: { type: string; source?: { media_type?: string } }[];
      }[];
      assertEquals(messages[0]?.content[0]?.type, 'document');
      assertEquals(messages[0]?.content[0]?.source?.media_type, 'application/pdf');
    },
  );
});

Deno.test('extractBillData aggregates errors when every provider fails', async () => {
  await withEnv(TWO_PROVIDER_ENV, async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('upstream error', { status: 500 }))) as typeof fetch;

    await assertRejects(
      () => extractBillData(new Uint8Array([1, 2, 3]), 'image/png'),
      Error,
      'all OCR providers failed',
    );
  });
});

Deno.test('extractBillData returns a manual-entry stub when no provider is configured', async () => {
  await withEnv(
    { OCR_PROVIDER: '', MINIMAX_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GROQ_API_KEY: '' },
    async () => {
      // No network call should happen; make fetch loud if it does.
      globalThis.fetch = (() => {
        throw new Error('fetch should not be called when no provider is configured');
      }) as typeof fetch;

      const result = await extractBillData(new Uint8Array([1, 2, 3]), 'image/png');
      assertEquals(result.data.confidence, 'low');
      assertStringIncludes(result.data.notes, 'No OCR provider configured');
    },
  );
});
