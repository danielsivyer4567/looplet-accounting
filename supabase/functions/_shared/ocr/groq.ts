/**
 * Groq vision OCR. Port of Loopletnumero `services/ocr/groq.ts`.
 * Default model: Llama 4 Scout — proven on real Paul Finch invoices,
 * ~3s extraction latency, sufficient for v1.
 */

import { EXTRACT_PROMPT, ocrTimeoutSignal, parseExtractedJson, type ExtractedBill } from './prompt.ts';

export async function extractBillDataGroq(
  imageBytes: Uint8Array,
  mimeType: string,
): Promise<{ data: ExtractedBill; raw: string }> {
  const apiKey = Deno.env.get('GROQ_API_KEY');
  if (!apiKey) throw new Error('GROQ_API_KEY is not set');

  const model = Deno.env.get('GROQ_VISION_MODEL') ?? 'meta-llama/llama-4-scout-17b-16e-instruct';
  const baseUrl = Deno.env.get('GROQ_BASE_URL') ?? 'https://api.groq.com/openai/v1';

  // Chunked base64 encoding — `String.fromCharCode(...bytes)` blows the call
  // stack at ~125k bytes due to argument-spread limits. Process 32k at a time.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < imageBytes.length; i += CHUNK) {
    binary += String.fromCharCode(...imageBytes.subarray(i, i + CHUNK));
  }
  const base64 = btoa(binary);
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
    signal: ocrTimeoutSignal(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const body = await res.json();
  const text = body.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('Groq returned empty response');
  return { data: parseExtractedJson(text), raw: text };
}
