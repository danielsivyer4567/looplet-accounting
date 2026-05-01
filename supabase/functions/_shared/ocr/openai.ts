/**
 * OpenAI vision OCR. Port of Loopletnumero `services/ocr/openai.ts`.
 * Default model: gpt-4o. Highest accuracy, paid per token.
 */

import { EXTRACT_PROMPT, parseExtractedJson, type ExtractedBill } from './prompt.ts';

export async function extractBillDataOpenAI(
  imageBytes: Uint8Array,
  mimeType: string,
): Promise<{ data: ExtractedBill; raw: string }> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const model = Deno.env.get('OPENAI_VISION_MODEL') ?? 'gpt-4o';
  const baseUrl = Deno.env.get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1';

  const base64 = btoa(String.fromCharCode(...imageBytes));
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
