/**
 * OpenAI vision OCR. Port of Loopletnumero `services/ocr/openai.ts`.
 * Default model: gpt-4o. Highest accuracy, paid per token.
 */

import { EXTRACT_PROMPT, ocrTimeoutSignal, parseExtractedJson, type ExtractedBill } from './prompt.ts';

/** Chunked base64 — String.fromCharCode(...bytes) blows the call stack ~125k bytes. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function extractBillDataOpenAI(
  imageBytes: Uint8Array,
  mimeType: string,
): Promise<{ data: ExtractedBill; raw: string }> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const model = Deno.env.get('OPENAI_VISION_MODEL') ?? 'gpt-4o';
  const baseUrl = Deno.env.get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1';

  const base64 = toBase64(imageBytes);
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: EXTRACT_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
    }),
    signal: ocrTimeoutSignal(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const body = await res.json();
  const text = body.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('OpenAI returned empty response');
  return { data: parseExtractedJson(text), raw: text };
}

/**
 * The embedding model the legal-RAG corpus is fixed to (SC-LC.A.01):
 * text-embedding-3-small → 1536 dims, matching `legal_corpus.embedding vector(1536)`.
 * Changing this means a re-embed + an ALTER, so it is a deliberate constant.
 */
export const EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * Embed a batch of texts with OpenAI, reusing the same OPENAI_API_KEY /
 * OPENAI_BASE_URL as the vision OCR above. Inputs are sent in batches so a
 * whole-Act ingest stays under the embeddings endpoint's per-request input cap;
 * the returned vectors are in the SAME order as `texts`.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const baseUrl = Deno.env.get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1';

  const BATCH = 96; // comfortably under the endpoint's input cap
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI embeddings ${res.status}: ${errText.slice(0, 300)}`);
    }
    const body = await res.json();
    const data = (body.data ?? []) as { index: number; embedding: number[] }[];
    if (data.length !== batch.length) {
      throw new Error(`OpenAI embeddings: expected ${batch.length} vectors, got ${data.length}`);
    }
    // The endpoint tags each vector with its batch-relative `index`; place each
    // back into request order rather than trusting response order.
    const ordered: number[][] = new Array<number[]>(batch.length);
    for (const d of data) ordered[d.index] = d.embedding;
    out.push(...ordered);
  }
  return out;
}
