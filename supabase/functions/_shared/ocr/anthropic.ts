/**
 * Anthropic (Claude) vision OCR. The reliable v2 provider.
 *
 * Why this replaces groq as the default:
 *   - Claude reads PDFs NATIVELY via `document` content blocks (born-digital
 *     AND scanned/photographed) — no rasterization needed, so the old
 *     "image-based PDF → manual entry" stub in index.ts goes away.
 *   - Far higher extraction accuracy on the messy real-world inputs this
 *     business actually receives (phone photos, Xero/MYOB screenshots,
 *     skewed scans) where llama-4-scout was returning ~0.41 confidence and
 *     null totals on 96% of bills.
 *   - `output_config.format` (structured outputs) constrains the response to
 *     our exact JSON schema, so the field shape is guaranteed valid.
 *
 * Default model: claude-sonnet-4-6 — strong vision + native PDF at ~1/3 the
 * cost of Opus, the right balance for high-volume invoice extraction.
 * Override with ANTHROPIC_VISION_MODEL (e.g. claude-opus-4-8 for hardest
 * images, claude-haiku-4-5 for cheapest).
 */

import { EXTRACT_PROMPT, ocrTimeoutSignal, parseExtractedJson, type ExtractedBill } from './prompt.ts';

const ANTHROPIC_VERSION = '2023-06-01';

// Structured-output schema — mirrors ExtractedBill (sans internal _ fields).
// Nullable fields use ["type","null"]; additionalProperties:false is required.
const BILL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    supplier_name: { type: ['string', 'null'] },
    supplier_abn: { type: ['string', 'null'] },
    invoice_number: { type: ['string', 'null'] },
    invoice_date: { type: ['string', 'null'] },
    due_date: { type: ['string', 'null'] },
    subtotal_ex_gst: { type: ['number', 'null'] },
    gst_amount: { type: ['number', 'null'] },
    total_inc_gst: { type: ['number', 'null'] },
    currency: { type: 'string' },
    line_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string' },
          quantity: { type: 'number' },
          unit_price: { type: 'number' },
          total: { type: 'number' },
        },
        required: ['description', 'quantity', 'unit_price', 'total'],
      },
    },
    job_reference: { type: ['string', 'null'] },
    // Without this the model cannot emit document_kind (additionalProperties:false
    // forbids it), so every extraction defaulted to 'invoice' and the non-financial
    // filter (logo/photo/ui_screenshot) was dead. Enum mirrors DocumentKind in prompt.ts.
    document_kind: {
      type: 'string',
      enum: ['invoice', 'quote', 'receipt', 'statement', 'order', 'logo', 'photo', 'ui_screenshot', 'other'],
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string' },
  },
  required: [
    'supplier_name',
    'supplier_abn',
    'invoice_number',
    'invoice_date',
    'due_date',
    'subtotal_ex_gst',
    'gst_amount',
    'total_inc_gst',
    'currency',
    'line_items',
    'job_reference',
    'document_kind',
    'confidence',
    'notes',
  ],
} as const;

/** Chunked base64 — String.fromCharCode(...bytes) blows the call stack ~125k bytes. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function extractBillDataAnthropic(
  fileBytes: Uint8Array,
  mimeType: string,
): Promise<{ data: ExtractedBill; raw: string }> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const model = Deno.env.get('ANTHROPIC_VISION_MODEL') ?? 'claude-sonnet-4-6';
  const baseUrl = Deno.env.get('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com/v1';

  const base64 = toBase64(fileBytes);

  // PDFs ride a `document` block (Claude rasterizes scanned PDFs server-side);
  // images ride an `image` block. Either way the file goes BEFORE the prompt.
  const fileBlock = mimeType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType.startsWith('image/') ? mimeType : 'image/png',
        data: base64,
      },
    };

  const res = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      // structured outputs → response text is guaranteed to satisfy the schema
      output_config: { format: { type: 'json_schema', schema: BILL_JSON_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [fileBlock, { type: 'text', text: EXTRACT_PROMPT }],
        },
      ],
    }),
    signal: ocrTimeoutSignal(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 400)}`);
  }

  const body = await res.json();

  // Safety nets that don't exist on a normal text response.
  if (body.stop_reason === 'refusal') {
    throw new Error('Anthropic declined the request (refusal)');
  }

  const text = (body.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('Anthropic returned empty response');

  return { data: parseExtractedJson(text), raw: text };
}
