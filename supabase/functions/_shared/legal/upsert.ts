// upsert.ts — shared versioned-upsert core for the legal corpus.
//
// The SINGLE copy of the append-only version-bump logic, reused by both the
// initial ingest (SC-LC.C.02) and the auto-updater sync (SC-LC.E.03) — the sync
// must NOT re-implement this (ledger altitude flag). Given a doc's freshly-chunked
// sections, it diffs each by content_hash against the current live version and
// writes append-only:
//   insert  — a section not seen before                  → new live row
//   unchanged — same content_hash                        → no-op (idempotent)
//   replace — changed text, SAME effective_from          → UPDATE the row in place
//   version — changed text, LATER effective_from         → close prior + insert new
//   backdated — older than the live version              → skip (don't corrupt time)
// Old versions are never overwritten/deleted (old-FY citations must keep resolving).
//
// Returns the per-section `changes` (so the sync can emit legal_change_events,
// E.02) and the pre-upsert `current` live map (so the sync can detect repeals —
// sections that vanished from the new text). Embeds only the to-write chunks
// (OpenAI text-embedding-3-small, 1536d). Throws on a DB error; the calling edge
// fn wraps it and returns the HTTP error.

import { sha256Hex } from '../apiKeys.ts';
import { type LegalChunk } from './chunk.ts';
import { loadCurrentVersions, type CurrentVersion } from './currentVersions.ts';
import { embedTexts, EMBEDDING_MODEL } from '../ocr/openai.ts';

interface SupabaseClient {
  from(table: string): any;
}

export interface UpsertParams {
  doc_ref: string;
  source: string;
  citation_url: string | null;
  effective_from: string; // 'YYYY-MM-DD'
  chunks: LegalChunk[];
}

export type WriteAction = 'insert' | 'replace' | 'version';

export interface CorpusChange {
  section_ref: string;
  action: WriteAction;
  old_chunk_id: string | null; // the superseded row (null for a brand-new section)
  new_chunk_id: string; // the row now in force (== old for an in-place replace)
  effective_from: string;
}

export interface UpsertStats {
  chunks: number;
  inserted: number;
  replaced: number;
  versioned: number;
  unchanged: number;
  skipped_backdated: number;
}

export interface UpsertResult {
  stats: UpsertStats;
  changes: CorpusChange[];
  current: Map<string, CurrentVersion>; // live versions BEFORE this upsert (for repeal detection)
}

type PlanAction = WriteAction | 'unchanged' | 'backdated';
interface Plan {
  chunk: LegalChunk;
  hash: string;
  action: PlanAction;
  cur: CurrentVersion | null;
  emb: string | null;
}

/** A JS number[] as the pgvector text literal PostgREST casts into vector(1536). */
function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

export async function upsertVersionedChunks(
  admin: SupabaseClient,
  params: UpsertParams,
): Promise<UpsertResult> {
  const { doc_ref, source, citation_url, effective_from, chunks } = params;
  const stats: UpsertStats = {
    chunks: chunks.length,
    inserted: 0,
    replaced: 0,
    versioned: 0,
    unchanged: 0,
    skipped_backdated: 0,
  };
  const changes: CorpusChange[] = [];

  // Current live version of every section of this doc, keyed by pinpoint.
  // PostgREST caps un-ranged reads, so page explicitly for large Acts.
  const current = await loadCurrentVersions(admin, doc_ref);

  if (chunks.length === 0) return { stats, changes, current };

  // Hash all chunk texts up front (independent → parallel), then classify each
  // against the current live version. 'YYYY-MM-DD' compares lexically.
  const hashes = await Promise.all(chunks.map((c) => sha256Hex(c.text)));
  const plans: Plan[] = chunks.map((chunk, i) => {
    const hash = hashes[i] ?? '';
    const cur = current.get(chunk.section_ref) ?? null;
    let action: PlanAction;
    if (!cur) action = 'insert';
    else if (cur.content_hash === hash) action = 'unchanged';
    else if (effective_from === cur.effective_from) action = 'replace';
    else if (effective_from > cur.effective_from) action = 'version';
    else action = 'backdated';
    return { chunk, hash, action, cur, emb: null };
  });

  // Embed ONLY the chunks that will be written (skip no-ops), in one batched call.
  const toWrite = plans.filter(
    (p) => p.action === 'insert' || p.action === 'replace' || p.action === 'version',
  );
  const vectors = await embedTexts(toWrite.map((p) => p.chunk.text));
  toWrite.forEach((p, i) => {
    const v = vectors[i];
    if (!v) throw new Error(`missing embedding for ${p.chunk.section_ref}`);
    p.emb = vectorLiteral(v);
  });

  for (const p of plans) {
    if (p.action === 'unchanged') {
      stats.unchanged += 1;
      continue;
    }
    if (p.action === 'backdated') {
      stats.skipped_backdated += 1;
      continue;
    }

    // Mutable content shared by INSERT (a fresh row) and REPLACE (update in place).
    const content = {
      heading: p.chunk.heading || null,
      text: p.chunk.text,
      embedding: p.emb,
      embedding_model: EMBEDDING_MODEL,
      content_hash: p.hash,
      citation_url,
      citation_anchor: p.chunk.section_ref,
    };
    const newRow = {
      source,
      doc_ref,
      section_ref: p.chunk.section_ref,
      ...content,
      effective_from,
      effective_to: null,
    };

    if (p.action === 'insert') {
      const { data, error } = await admin.from('legal_corpus').insert(newRow).select('id').single();
      if (error || !data) throw new Error(`insert ${p.chunk.section_ref}: ${error?.message}`);
      stats.inserted += 1;
      changes.push({
        section_ref: p.chunk.section_ref,
        action: 'insert',
        old_chunk_id: null,
        new_chunk_id: data.id as string,
        effective_from,
      });
      continue;
    }

    const cur = p.cur;
    if (!cur) continue; // unreachable: replace/version only set when cur exists

    if (p.action === 'replace') {
      const { error } = await admin.from('legal_corpus').update(content).eq('id', cur.id);
      if (error) throw new Error(`replace ${p.chunk.section_ref}: ${error.message}`);
      stats.replaced += 1;
      changes.push({
        section_ref: p.chunk.section_ref,
        action: 'replace',
        old_chunk_id: cur.id,
        new_chunk_id: cur.id, // updated in place — same row
        effective_from,
      });
      continue;
    }

    // version: close the prior version, then insert the new one. The new row's
    // effective_from differs from the (still live) old row, so the partial-unique
    // (doc_ref, section_ref, effective_from) is not violated.
    const { error: closeErr } = await admin
      .from('legal_corpus')
      .update({ effective_to: effective_from })
      .eq('id', cur.id);
    if (closeErr) throw new Error(`close prior ${p.chunk.section_ref}: ${closeErr.message}`);
    const { data: ins, error: insErr } = await admin
      .from('legal_corpus')
      .insert(newRow)
      .select('id')
      .single();
    if (insErr || !ins) throw new Error(`new version ${p.chunk.section_ref}: ${insErr?.message}`);
    stats.versioned += 1;
    changes.push({
      section_ref: p.chunk.section_ref,
      action: 'version',
      old_chunk_id: cur.id,
      new_chunk_id: ins.id as string,
      effective_from,
    });
  }

  return { stats, changes, current };
}
