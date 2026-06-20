/**
 * MiniMax vision OCR. The default v2 provider.
 *
 * MiniMax exposes an OpenAI-compatible Chat Completions endpoint, so this
 * mirrors openai.ts: a single multimodal user turn (image + prompt) → JSON.
 * MiniMax-M3 is the multimodal model; images ride `image_url` data URLs.
 *
 *   Base URL : https://api.minimax.io/v1   (MINIMAX_BASE_URL)
 *   Model    : MiniMax-M3                  (MINIMAX_VISION_MODEL)
 *   Auth     : Authorization: Bearer <MINIMAX_API_KEY>
 *
 * NOTE: MiniMax vision takes images only (JPEG/PNG/GIF/WEBP, <=10MB) — there is
 * no native PDF document input. PDFs are handled upstream by the born-digital
 * text-layer path; image-based PDFs fall back to the manual-entry stub in
 * index.ts (set OCR_PROVIDER=anthropic if you need PDFs OCR'd).
 */

import { EXTRACT_PROMPT, parseExtractedJson, type ExtractedBill } from './prompt.ts';

/** Chunked base64 — String.fromCharCode(...bytes) blows the call stack ~125k bytes. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function extractBillDataMiniMax(
  imageBytes: Uint8Array | Uint8Array[],
  mimeType: string,
): Promise<{ data: ExtractedBill; raw: string }> {
  const apiKey = Deno.env.get('MINIMAX_API_KEY');
  if (!apiKey) throw new Error('MINIMAX_API_KEY is not set');

  const model = Deno.env.get('MINIMAX_VISION_MODEL') ?? 'MiniMax-M3';
  const baseUrl = Deno.env.get('MINIMAX_BASE_URL') ?? 'https://api.minimax.io/v1';

  const mediaType = mimeType.startsWith('image/') ? mimeType : 'image/png';
  // Accept multiple images (multi-page PDFs → one PNG per page). Supplier
  // identity is usually on page 1, totals/GST on the last page, so all pages
  // go into the single request.
  const pages = Array.isArray(imageBytes) ? imageBytes : [imageBytes];
  const imageBlocks = pages.map((p) => ({
    type: 'image_url',
    image_url: { url: `data:${mediaType};base64,${toBase64(p)}` },
  }));

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      // MiniMax-M3 is a reasoning model — it spends output tokens on a
      // <think>…</think> block before the answer, so the budget must cover
      // both the reasoning and the JSON or the JSON gets truncated away.
      max_tokens: 16000,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: EXTRACT_PROMPT }, ...imageBlocks],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MiniMax API ${res.status}: ${errText.slice(0, 300)}`);
  }

  // MiniMax-M3 can emit raw (unescaped) control characters inside the response
  // content string, which breaks the envelope JSON itself — so parse the body
  // text defensively, stripping control chars only if the direct parse fails.
  const bodyText = await res.text();
  let body: { choices?: Array<{ message?: { content?: string } }> };
  try {
    body = JSON.parse(bodyText);
  } catch {
    let clean = '';
    for (let k = 0; k < bodyText.length; k++) {
      const c = bodyText.charCodeAt(k);
      clean += c < 32 ? ' ' : bodyText[k];
    }
    body = JSON.parse(clean);
  }
  const rawText = body.choices?.[0]?.message?.content ?? '';
  if (!rawText) throw new Error('MiniMax returned empty response');

  // Strip the model's <think>…</think> reasoning before locating the JSON.
  // A response that still begins with <think> after stripping means the
  // reasoning was truncated (no closing tag) — surface that as an error.
  const text = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (/^<think>/i.test(text) || !text.includes('{')) {
    throw new Error('MiniMax response truncated before JSON (reasoning overran token budget)');
  }
  return { data: parseExtractedJson(text), raw: rawText };
}
