// Edge function: legal-corpus-ingest  (SC-LC.C.02)
//
// Ingest one AU tax instrument into the versioned RAG corpus. Given the raw text
// of an instrument, it section-chunks via the shared parser (SC-LC.C.01) and
// upserts into legal_corpus (SC-LC.A.01) through the SHARED versioned-upsert core
// (_shared/legal/upsert.ts) — the same append-only version-bump logic the sync
// (SC-LC.E.03) reuses, so there is one copy:
//   new section → INSERT; unchanged → no-op (content_hash); changed same-date →
//   REPLACE in place; changed later-date → close prior + INSERT new version.
// Old versions are never overwritten (match_legal_corpus FY-scopes on the range).
//
// AUTH: this writes GLOBAL reference data (the law is the same for every tenant),
// so it is operator/back-end only — NO user-JWT path. Accepts a service-role
// bearer OR ?secret=<LEGAL_INGEST_SECRET> (both constant-time compared); anything
// else fails CLOSED with 401. Writes use the service-role admin client.
//
// Request body:
//   { doc_ref: string,         // the instrument, e.g. 'ITAA 1997' (required)
//     text: string,            // the raw instrument text (required)
//     effective_from: string,  // 'YYYY-MM-DD' — this version's commencement (required)
//     source?: string,         // registry source name (legal_sources, E.01); default = doc_ref
//     citation_url?: string }   // deep link to the instrument (FRL / ATO)
//
// SEED OP (operational, not a slice gate): upload the user's NotebookLM .txt files
// and call this fn per file with each file's effective date — see ledger SEED/DEPLOY.
//
// DEPLOY PREREQUISITES (migration-history drift — see ledger SC-LC.C.02):
//   - migration 0108 applied live (pgvector + legal_corpus)
//   - secret OPENAI_API_KEY set (already used by OCR) — required to embed
//   - secret LEGAL_INGEST_SECRET set if driving via ?secret= (else service-role only)
//   - deploy with config.toml verify_jwt=false so the ?secret= seed path reaches
//     this function's own fail-closed auth gate.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { requireEnv } from '../_shared/env.ts';
import { chunkLegalText } from '../_shared/legal/chunk.ts';
import { upsertVersionedChunks } from '../_shared/legal/upsert.ts';

interface RequestBody {
  doc_ref?: string;
  text?: string;
  effective_from?: string;
  source?: string;
  citation_url?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** Constant-time string compare; false on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    const supabaseUrl = requireEnv('SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    const adminSecret = Deno.env.get('LEGAL_INGEST_SECRET');

    // Auth gate: service-role bearer OR ?secret= (operator). Global-write fn, so
    // there is deliberately no authenticated-user path — fail closed.
    const url = new URL(req.url);
    const urlSecret = url.searchParams.get('secret');
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    const isServiceRole = safeEqual(bearer, serviceKey);
    const secretOk = !!adminSecret && safeEqual(urlSecret ?? '', adminSecret);
    if (!isServiceRole && !secretOk) return json({ ok: false, error: 'Unauthorized' }, 401);

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const doc_ref = (body.doc_ref ?? '').trim();
    const rawText = body.text ?? '';
    const effective_from = (body.effective_from ?? '').trim();
    const source = (body.source ?? '').trim() || doc_ref;
    const citation_url = (body.citation_url ?? '').trim() || null;

    if (!doc_ref) return json({ ok: false, error: 'doc_ref is required' }, 400);
    if (!rawText.trim()) return json({ ok: false, error: 'text is required' }, 400);
    if (!DATE_RE.test(effective_from)) {
      return json({ ok: false, error: 'effective_from must be YYYY-MM-DD' }, 400);
    }

    const chunks = chunkLegalText(rawText, { doc_ref });
    if (chunks.length === 0) {
      return json({
        ok: true,
        doc_ref,
        effective_from,
        stats: {
          chunks: 0,
          inserted: 0,
          replaced: 0,
          versioned: 0,
          unchanged: 0,
          skipped_backdated: 0,
        },
      });
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { stats } = await upsertVersionedChunks(admin, {
      doc_ref,
      source,
      citation_url,
      effective_from,
      chunks,
    });

    return json({ ok: true, doc_ref, effective_from, stats });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});
