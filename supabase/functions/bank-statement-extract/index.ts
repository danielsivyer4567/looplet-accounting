/**
 * bank-statement-extract — extract transaction rows from a bank-statement
 * page image (rendered client-side from a PDF page) using Groq Llama-4
 * Scout vision. Used by the BankStatementImport UI.
 *
 * Input: { image_base64: string }   // PNG of one PDF page, no data: prefix
 * Output: { ok, rows: [{ posted_at: 'YYYY-MM-DD', description, amount_cents (signed), balance_cents? }] }
 *
 * The caller (frontend) renders each PDF page → calls this function once per
 * page → flattens rows → POSTs to bank-csv-import-style upsert. Keeping the
 * upload path simple so a sandbox 504 mid-statement doesn't lose data — the
 * frontend can retry per-page.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireSignedInCaller } from '../_shared/authGuards.ts';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { supabaseOrgAccessDeps } from '../_shared/orgRole.ts';

// One rendered statement page. Larger bodies are refused before any paid vision call.
export const MAX_IMAGE_BASE64_CHARS = Math.ceil((8 * 1024 * 1024 * 4) / 3); // an 8 MB image

const PROMPT = `You are extracting transaction rows from a single page of an Australian bank statement (CommBank, NAB, Westpac, ANZ, Bendigo, etc.).

Return ONLY a JSON object with this exact shape — no commentary, no markdown fences:

{
  "rows": [
    { "date": "YYYY-MM-DD", "description": "...", "amount": -123.45, "balance": 1234.56 }
  ]
}

Rules:
- "date" → ISO YYYY-MM-DD. Convert dd/mm/yyyy or "31 Dec 2025" forms.
- "amount" → signed decimal in dollars. NEGATIVE for debits/withdrawals/money out, POSITIVE for credits/deposits/money in.
  - If the page has separate Debit and Credit columns, output amount = credit - debit.
  - If the page has a single Amount column with parentheses around debits, treat them as negative.
- "balance" → optional, decimal dollars. Omit the field entirely if not visible.
- "description" → the merchant or transfer description as printed. Strip leading/trailing spaces but keep internal punctuation.
- Skip header rows ("Opening balance", "Closing balance", "Page X of Y", column headers).
- Skip rows that are clearly NOT transactions (interest accrued summaries, fee disclaimers).
- If the page has no transactions (cover page, terms & conditions), return { "rows": [] }.
- Output strictly valid JSON. No trailing commas. No explanation.`;

interface RequestBody {
  image_base64: string;
  mime_type?: string;
}

interface ExtractedRow {
  date: string;
  description: string;
  amount: number;
  balance?: number;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    // Vision extraction spends Groq credit, so only signed-in users (or backend callers) may use it. A header that is
    // merely present, such as the public anon key, is not enough.
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) return json({ ok: false, error: 'Server config missing' }, 500);
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const caller = await requireSignedInCaller(req.headers.get('Authorization'), supabaseOrgAccessDeps(admin, serviceKey));
    if (!caller.ok) return json({ ok: false, error: caller.error }, caller.status);

    const groqKey = Deno.env.get('GROQ_API_KEY');
    if (!groqKey) return json({ ok: false, error: 'GROQ_API_KEY not set' }, 500);
    const model = Deno.env.get('GROQ_VISION_MODEL') ?? 'meta-llama/llama-4-scout-17b-16e-instruct';
    const baseUrl = Deno.env.get('GROQ_BASE_URL') ?? 'https://api.groq.com/openai/v1';

    const body = (await req.json()) as RequestBody;
    if (typeof body.image_base64 !== 'string' || !body.image_base64) {
      return json({ ok: false, error: 'image_base64 required' }, 400);
    }
    if (body.image_base64.length > MAX_IMAGE_BASE64_CHARS) {
      return json({ ok: false, error: 'image_base64 is too large: send one statement page of at most 8 MB' }, 413);
    }
    const mime = body.mime_type ?? 'image/png';
    const dataUrl = `data:${mime};base64,${body.image_base64}`;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return json({ ok: false, error: `Groq ${res.status}: ${errText.slice(0, 400)}` }, 502);
    }

    const apiBody = await res.json();
    const text = apiBody.choices?.[0]?.message?.content ?? '';
    let parsed: { rows?: ExtractedRow[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      // Try to recover JSON from a fenced block
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return json({ ok: false, error: 'Groq returned non-JSON', raw: text.slice(0, 500) }, 502);
      parsed = JSON.parse(m[0]);
    }
    if (!parsed.rows || !Array.isArray(parsed.rows)) {
      return json({ ok: false, error: 'No rows array', raw: text.slice(0, 300) }, 502);
    }

    // Normalise rows to internal shape: posted_at + amount_cents
    const out = parsed.rows
      .filter((r) => r && r.date && typeof r.amount === 'number' && r.description)
      .map((r) => ({
        posted_at: normaliseDate(r.date),
        description: r.description.replace(/\s+/g, ' ').trim(),
        amount_cents: Math.round(r.amount * 100),
        balance_cents: typeof r.balance === 'number' ? Math.round(r.balance * 100) : null,
      }))
      .filter((r) => r.posted_at && Number.isFinite(r.amount_cents));

    return json({ ok: true, rows: out, dropped: parsed.rows.length - out.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

function normaliseDate(input: string): string | null {
  if (!input) return null;
  const s = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (dmy) {
    const yy = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${yy}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  // "31 Dec 2025" style
  const written = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (written) {
    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const mm = months[written[2].slice(0, 3).toLowerCase()];
    if (!mm) return null;
    return `${written[3]}-${mm}-${written[1].padStart(2, '0')}`;
  }
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
