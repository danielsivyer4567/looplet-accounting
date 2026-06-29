// Edge function: legal-corpus-sync  (SC-LC.E.03)
//
// The auto-updater. Given ONE registered source (legal_sources, E.01), re-fetch
// its current text, re-chunk it (the SAME parser the ingest used, C.01), and
// version-bump every CHANGED section in legal_corpus through the SHARED upsert
// core (_shared/legal/upsert.ts) — unchanged sections are no-ops, changed ones
// close the prior version + insert a new embedded version, append-only so old-FY
// citations keep resolving. Each change is recorded via notify_legal_change()
// (E.02); a section that VANISHED from the new text is closed + flagged 'repealed'.
// Finally the source's last_checked_at / last_version_ref cursor is stamped.
//
// CONVENTION: legal_sources.name IS the corpus doc_ref (the registry↔corpus link)
// — the seed ingest (C.02) must use the same name so re-sync targets the same rows.
//
// AUTH: writes GLOBAL reference data → operator/back-end only, NO user-JWT path.
// Service-role bearer OR ?secret=<LEGAL_SYNC_SECRET> (constant-time); else 401.
// SC-LC.E.04 makes this cron-driven (verify_jwt=false + the cron secret).
//
// Request body (sync ONE source; the "all due sources" loop is the cron's job, E.04):
//   { source_id?: uuid,        // pick the source by id …
//     source_name?: string,    // … or by name (one of the two is required)
//     text?: string,           // OPTIONAL: the already-fetched text (manual/test);
//                              //           omit to fetch source.canonical_url
//     effective_from?: string, // OPTIONAL 'YYYY-MM-DD' compilation date; default = today
//     chunk_offset?: number,   // OPTIONAL: start chunk index for resumable large sources
//     chunk_limit?: number }   // OPTIONAL: max chunks to process in this call
//
// DEPLOY PREREQUISITES (post-slice): 0108–0111 applied; OPENAI_API_KEY set (embeds);
// LEGAL_SYNC_SECRET set for the cron; deploy via Supabase MCP. Fetched FRL sources
// resolve the current /latest/text EPUB HTML and extract plain legal text +
// compilation date. Generic ATO search pages are refused rather than ingested as
// markup; pass text manually or register a specific ATO document URL.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { requireEnv } from '../_shared/env.ts';
import { sha256Hex } from '../_shared/apiKeys.ts';
import { chunkLegalText } from '../_shared/legal/chunk.ts';
import { fetchLegalSourceText } from '../_shared/legal/sourceFetch.ts';
import { upsertVersionedChunks, type WriteAction } from '../_shared/legal/upsert.ts';

interface RequestBody {
  source_id?: string;
  source_name?: string;
  text?: string;
  effective_from?: string;
  chunk_offset?: number;
  chunk_limit?: number;
}

interface SourceRow {
  id: string;
  name: string;
  kind: string;
  canonical_url: string;
  check_method: string;
  last_version_ref: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_CHUNK_LIMIT = 120;
const MAX_CHUNK_LIMIT = 200;

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

/** Map a corpus write action to a legal_change_events change_kind. */
function changeKind(action: WriteAction): string {
  return action === 'insert' ? 'new' : 'amended';
}

/** Record one section change in the event ledger (notify_legal_change, E.02). */
async function recordChange(
  admin: SupabaseClient,
  doc_ref: string,
  section_ref: string,
  change_kind: string,
  old_chunk_id: string | null,
  new_chunk_id: string | null,
  effective_from: string,
): Promise<void> {
  const { error } = await admin.rpc('notify_legal_change', {
    p_doc_ref: doc_ref,
    p_section_ref: section_ref,
    p_change_kind: change_kind,
    p_old_chunk_id: old_chunk_id,
    p_new_chunk_id: new_chunk_id,
    p_effective_from: effective_from,
  });
  if (error) throw new Error(`notify_legal_change ${section_ref}: ${error.message}`);
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    const supabaseUrl = requireEnv('SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    const cronSecret = Deno.env.get('LEGAL_SYNC_SECRET');

    // Auth: service-role bearer OR ?secret= (cron/operator). No user-JWT path.
    const url = new URL(req.url);
    const urlSecret = url.searchParams.get('secret');
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    const isServiceRole = safeEqual(bearer, serviceKey);
    const secretOk = !!cronSecret && safeEqual(urlSecret ?? '', cronSecret);
    if (!isServiceRole && !secretOk) return json({ ok: false, error: 'Unauthorized' }, 401);

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const sourceId = (body.source_id ?? '').trim();
    const sourceName = (body.source_name ?? '').trim();
    if (!sourceId && !sourceName) {
      return json({ ok: false, error: 'source_id or source_name is required' }, 400);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Resolve the (active) source row.
    let q = admin
      .from('legal_sources')
      .select('id, name, kind, canonical_url, check_method, last_version_ref')
      .is('deleted_at', null)
      .eq('is_active', true);
    q = sourceId ? q.eq('id', sourceId) : q.eq('name', sourceName);
    const { data: srcData, error: srcErr } = await q.limit(1).maybeSingle();
    if (srcErr) return json({ ok: false, error: `load source: ${srcErr.message}` }, 500);
    if (!srcData) return json({ ok: false, error: 'source not found / inactive' }, 404);
    const source = srcData as SourceRow;

    // Get the current text: provided directly (manual/test) or fetched from an
    // official source with source-specific extraction.
    const fetched = body.text?.trim()
      ? {
          text: body.text.trim(),
          citation_url: source.canonical_url,
          effective_from: null,
          version_ref: null,
        }
      : await fetchLegalSourceText(source);
    const text = fetched.text;
    const effective_from =
      body.effective_from && DATE_RE.test(body.effective_from)
        ? body.effective_from
        : (fetched.effective_from ?? new Date().toISOString().slice(0, 10));

    // Whole-source change cursor: if the content is byte-identical to last check,
    // skip the (expensive) re-chunk/re-embed and just touch last_checked_at.
    const textHash = await sha256Hex(text);
    const version_ref = fetched.version_ref ? `${fetched.version_ref}:${textHash}` : textHash;
    if (source.last_version_ref && source.last_version_ref === version_ref) {
      await admin
        .from('legal_sources')
        .update({ last_checked_at: new Date().toISOString() })
        .eq('id', source.id);
      return json({ ok: true, source: source.name, unchanged: true });
    }

    // The registry name IS the corpus doc_ref (see CONVENTION above).
    const doc_ref = source.name;
    const chunks = chunkLegalText(text, { doc_ref });
    const requestedOffset = Number.isFinite(body.chunk_offset)
      ? Math.floor(body.chunk_offset ?? 0)
      : 0;
    const chunkOffset = Math.max(0, requestedOffset);
    const requestedLimit = Number.isFinite(body.chunk_limit)
      ? Math.floor(body.chunk_limit ?? 0)
      : 0;
    const chunkLimit =
      requestedLimit > 0
        ? Math.min(requestedLimit, MAX_CHUNK_LIMIT)
        : body.chunk_offset != null
          ? DEFAULT_CHUNK_LIMIT
          : chunks.length;
    const chunkWindow = chunks.slice(chunkOffset, chunkOffset + chunkLimit);
    const nextOffset = chunkOffset + chunkWindow.length;
    const complete = nextOffset >= chunks.length;
    const { stats, changes, current } = await upsertVersionedChunks(admin, {
      doc_ref,
      source: source.name,
      citation_url: fetched.citation_url,
      effective_from,
      chunks: chunkWindow,
    });

    // Record each section change in the event ledger (E.02).
    for (const ch of changes) {
      await recordChange(
        admin,
        doc_ref,
        ch.section_ref,
        changeKind(ch.action),
        ch.old_chunk_id,
        ch.new_chunk_id,
        ch.effective_from,
      );
    }

    let repealed = 0;
    if (complete) {
      // Repeal detection only runs on the final/full window: a section live
      // BEFORE this run but ABSENT from the new text is no longer in force.
      // Earlier windows must not treat not-yet-processed chunks as repealed.
      const newRefs = new Set(chunks.map((c) => c.section_ref));
      for (const [section_ref, cur] of current) {
        if (newRefs.has(section_ref)) continue;
        const { error: closeErr } = await admin
          .from('legal_corpus')
          .update({ effective_to: effective_from })
          .eq('id', cur.id);
        if (closeErr) throw new Error(`repeal close ${section_ref}: ${closeErr.message}`);
        await recordChange(admin, doc_ref, section_ref, 'repealed', cur.id, null, effective_from);
        repealed += 1;
      }

      // Stamp the source's check cursor only after the final/full window.
      await admin
        .from('legal_sources')
        .update({ last_checked_at: new Date().toISOString(), last_version_ref: version_ref })
        .eq('id', source.id);
    }

    return json({
      ok: true,
      source: source.name,
      effective_from,
      chunk_offset: chunkOffset,
      chunk_limit: chunkLimit,
      processed_chunks: chunkWindow.length,
      total_chunks: chunks.length,
      next_offset: complete ? null : nextOffset,
      complete,
      stats: { ...stats, repealed },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});
