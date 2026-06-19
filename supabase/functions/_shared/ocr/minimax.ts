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
  imageBytes: Uint8Array,
  mimeType: string,
): Promise<{ data: ExtractedBill; raw: string }> {
  const apiKey = Deno.env.get('MINIMAX_API_KEY');
  if (!apiKey) throw new Error('MINIMAX_API_KEY is not set');

  const model = Deno.env.get('MINIMAX_VISION_MODEL') ?? 'MiniMax-M3';
  const baseUrl = Deno.env.get('MINIMAX_BASE_URL') ?? 'https://api.minimax.io/v1';

  const mediaType = mimeType.startsWith('image/') ? mimeType : 'image/png';
  const dataUrl = `data:${mediaType};base64,${toBase64(imageBytes)}`;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: EXTRACT_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MiniMax API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const body = await res.json();
  const text = body.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('MiniMax returned empty response');
  return { data: parseExtractedJson(text), raw: text };
}
