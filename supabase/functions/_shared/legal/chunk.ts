/**
 * chunk.ts — pure, deterministic section-chunker for AU tax-law text (SC-LC.C.01).
 *
 * Splits a plain-text export (NotebookLM `.txt`) of an Australian tax instrument
 * — ITAA 1936/1997, the GST Act, TAA, FBTAA, the SIS Act, ATO rulings, cases —
 * into ordered, citation-anchored chunks. A chunk is normally ONE operative
 * section (or a structural division that carries its own guide text), which is
 * the natural pinpoint a citation links to ("click to the line"). Very large
 * sections are split into deterministic part anchors (`s 136 [1]`, `s 136 [2]`)
 * so every embedding input stays under the model limit. Every chunk gets a
 * normalised `section_ref` in AGLC-ish pinpoint form (`s 8-1`, `div 7A`) that
 * the auto-updater (SC-LC.E.03) re-derives identically — so a re-ingested
 * compilation diffs section-by-section by `content_hash` instead of wholesale.
 *
 * Pure: no I/O, no DB, no embeddings, no Deno/Node globals — testable in
 * isolation and reused verbatim by both the initial ingest (SC-LC.C.02) and the
 * sync re-ingest (SC-LC.E.03). Same input → same chunks (deterministic).
 *
 * Detection is shape-based, tuned to the Federal Register of Legislation (FRL)
 * compilation layout: a section/division heading is a pinpoint at the start of a
 * line, set off from its title by a TAB or 2+ spaces (the FRL "number-gap-title"
 * shape). That gap is what separates a real heading from a date or cross-
 * reference that merely begins with a number, so single-space-collapsed exports
 * fall through to the paragraph fallback rather than mis-detecting headings.
 */

export interface LegalChunk {
  /** The instrument, verbatim from the caller, e.g. 'ITAA 1997'. */
  doc_ref: string;
  /** Normalised citation pinpoint within the doc, e.g. 's 8-1', 'div 7A'. */
  section_ref: string;
  /** The section/division title, e.g. 'General deductions' ('' when none). */
  heading: string;
  /** The verbatim block for this anchor: header line through to the next. */
  text: string;
}

export interface ChunkOptions {
  doc_ref: string;
}

// The FRL heading gap: a tab, or 2+ spaces. A single space does NOT qualify —
// that is what keeps "23 May 2020" or "section 8-1 of the Act applies" (which
// begin with a number but are prose) from being mistaken for a heading.
const GAP = String.raw`(?:\t+| {2,})`;

// "Division 7A—Distributions...", "Subdivision 328-D—...", "Part III—...". The
// id is number+letters (7A, 328, 328-D) or roman numerals (III); the title is
// set off by an em/en dash or a space-padded hyphen, so the hyphen inside
// "328-D" is never mistaken for the title separator.
const STRUCT_RE =
  /^(Chapter|Part|Division|Subdivision)\s+(\d+[A-Z]*(?:-[A-Z0-9]+)*|[IVXLCDM]+|[A-Z])(?:\s*[—–]\s*|\s+-\s+)(\S.*?)\s*$/i;

// "8-1  General deductions" (ITAA 1997 / GST hyphenated numbering). An optional
// leading "s "/"section " prefix is tolerated and dropped.
const HYPHEN_SEC_RE = new RegExp(
  String.raw`^(?:s |section )?(\d+[A-Z]*-\d+[A-Z]*)${GAP}(\S.*?)\s*$`,
  'i',
);

// "99B   Receipt of trust income..." (ITAA 1936 / FBTAA / SIS plain numbering).
const PLAIN_SEC_RE = new RegExp(String.raw`^(\d+[A-Z]{0,3})${GAP}([A-Z].*?)\s*$`);

// FRL compilation page-break artefacts that interrupt a section mid-flow. They
// are dropped (not merged into a chunk) so a section's text reads continuously
// across a page break instead of splitting a sentence.
const NOISE_RE: RegExp[] = [
  /^Authorised Version\b/i,
  /^Compilation No\.?\b/i,
  /^Registered:/i,
  /^Prepared by the Office of (?:the )?Parliamentary Counsel\b/i,
  /^\d{1,4}$/, // a bare page number on its own line
];

// A title beginning with a full month name + a number is a stray date, never a
// section heading (guards the plain-number path against "5  June 2021" rows).
const DATE_TITLE_RE =
  /^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d/;

const KIND_ABBR: Record<string, string> = {
  chapter: 'ch',
  part: 'pt',
  division: 'div',
  subdivision: 'subdiv',
};

function isNoise(line: string): boolean {
  return NOISE_RE.some((re) => re.test(line));
}

function isPlausibleTitle(title: string): boolean {
  // Length bounds are heuristic guards against scan artefacts (1–2 char
  // fragments) and whole paragraphs mis-read as a title — not FRL grammar.
  if (title.length < 3 || title.length > 200) return false;
  if (!/^[A-Z]/.test(title)) return false; // headings are capitalised
  if (!/[a-z]/.test(title)) return false; // reject ALL-CAPS banners / page headers
  if (/\.$/.test(title)) return false; // headings are titles, not sentences
  if (DATE_TITLE_RE.test(title)) return false;
  return true;
}

interface Header {
  section_ref: string;
  heading: string;
}

// The hyphenated (8-1) and plain (99B) forms share a shape — number in group 1,
// title in group 2 — so both run through one path. Returns null on no match or
// an implausible title, letting the caller fall through to the next form.
function parseSection(match: RegExpExecArray | null): Header | null {
  if (!match) return null;
  const title = (match[2] ?? '').trim();
  if (!isPlausibleTitle(title)) return null;
  return { section_ref: `s ${(match[1] ?? '').toUpperCase()}`, heading: title };
}

function detectHeader(line: string): Header | null {
  const structM = STRUCT_RE.exec(line);
  if (structM) {
    const kind = (structM[1] ?? '').toLowerCase();
    const id = (structM[2] ?? '').toUpperCase();
    const abbr = KIND_ABBR[kind] ?? kind;
    return { section_ref: `${abbr} ${id}`, heading: (structM[3] ?? '').trim() };
  }
  return parseSection(HYPHEN_SEC_RE.exec(line)) ?? parseSection(PLAIN_SEC_RE.exec(line));
}

/** Join body lines, squeeze runs of blank lines to one, and trim the ends. */
function bodyToText(body: string[]): string {
  return body
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Section_refs that are pure structural containers (a Part/Division/etc. line
// with no body of its own). A bare container is dropped; one that carries guide
// text is kept.
const CONTAINER_RE = /^(?:ch|pt|div|subdiv) /;
const MAX_EMBED_CHARS = 6000;

function splitLongBlock(block: string): string[] {
  const parts: string[] = [];
  let rest = block.trim();
  while (rest.length > MAX_EMBED_CHARS) {
    let cut = rest.lastIndexOf('\n', MAX_EMBED_CHARS);
    if (cut < MAX_EMBED_CHARS * 0.6) cut = rest.lastIndexOf(' ', MAX_EMBED_CHARS);
    if (cut < MAX_EMBED_CHARS * 0.6) cut = MAX_EMBED_CHARS;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function splitForEmbedding(text: string): string[] {
  if (text.length <= MAX_EMBED_CHARS) return [text];

  const parts: string[] = [];
  let buf: string[] = [];
  let size = 0;
  const flush = (): void => {
    if (buf.length === 0) return;
    parts.push(buf.join('\n\n').trim());
    buf = [];
    size = 0;
  };

  for (const block of text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)) {
    if (block.length > MAX_EMBED_CHARS) {
      flush();
      parts.push(...splitLongBlock(block));
      continue;
    }

    const nextSize = size === 0 ? block.length : size + 2 + block.length;
    if (nextSize > MAX_EMBED_CHARS) flush();
    buf.push(block);
    size = size === 0 ? block.length : size + 2 + block.length;
  }
  flush();
  return parts;
}

function boundChunkForEmbedding(chunk: LegalChunk): LegalChunk[] {
  const parts = splitForEmbedding(chunk.text);
  if (parts.length <= 1) return [chunk];
  return parts.map((text, index) => ({
    ...chunk,
    section_ref: `${chunk.section_ref} [${index + 1}]`,
    heading: chunk.heading ? `${chunk.heading} (part ${index + 1})` : `Part ${index + 1}`,
    text,
  }));
}

function uniqueSectionRef(sectionRef: string, seen: Map<string, number>): string {
  const count = (seen.get(sectionRef) ?? 0) + 1;
  seen.set(sectionRef, count);
  return count === 1 ? sectionRef : `${sectionRef} #${count}`;
}

/**
 * Fallback for header-less docs (cases, rulings without numbered headings):
 * group blank-line-delimited paragraphs into reasonably-sized, sequentially
 * anchored chunks rather than emitting one un-retrievable mega-chunk.
 */
function fallbackChunks(text: string, doc_ref: string): LegalChunk[] {
  const FLUSH_AT = 1200; // chars — keeps chunks well under the embed token limit
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const out: LegalChunk[] = [];
  let buf: string[] = [];
  let size = 0;
  let n = 0;
  const flush = (): void => {
    if (buf.length === 0) return;
    n += 1;
    out.push({ doc_ref, section_ref: `[${n}]`, heading: '', text: buf.join('\n\n') });
    buf = [];
    size = 0;
  };

  for (const block of blocks) {
    // A single paragraph larger than the embed limit must be split, or it becomes an
    // over-limit embed input (the fallback path does not run through boundChunkForEmbedding).
    if (block.length > MAX_EMBED_CHARS) {
      flush();
      for (const part of splitLongBlock(block)) {
        n += 1;
        out.push({ doc_ref, section_ref: `[${n}]`, heading: '', text: part });
      }
      continue;
    }
    buf.push(block);
    size += block.length;
    if (size >= FLUSH_AT) flush();
  }
  flush();
  return out;
}

interface Section {
  section_ref: string;
  heading: string;
  body: string[]; // includes the header line as body[0]
}

export function chunkLegalText(raw: string, opts: ChunkOptions): LegalChunk[] {
  const { doc_ref } = opts;
  const lines = raw.replace(/\r\n?|\f/g, '\n').split('\n');

  const sections: Section[] = [];
  const preamble: string[] = [];
  let current: Section | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, ''); // strip trailing whitespace
    const trimmed = line.trim();
    if (trimmed !== '' && isNoise(trimmed)) continue; // drop page-break artefacts

    const header = trimmed === '' ? null : detectHeader(trimmed);
    if (header) {
      current = { section_ref: header.section_ref, heading: header.heading, body: [line] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }

  const preambleText = bodyToText(preamble);

  // No headings anywhere → the whole doc is unstructured (a case / ruling).
  if (sections.length === 0) {
    return preambleText ? fallbackChunks(preambleText, doc_ref) : [];
  }

  const result: LegalChunk[] = [];
  const seenRefs = new Map<string, number>();
  const pushChunk = (chunk: LegalChunk): void => {
    result.push(
      ...boundChunkForEmbedding({
        ...chunk,
        section_ref: uniqueSectionRef(chunk.section_ref, seenRefs),
      }),
    );
  };

  if (preambleText) {
    pushChunk({ doc_ref, section_ref: 'preamble', heading: '', text: preambleText });
  }
  for (const section of sections) {
    // Drop a structural container (Part/Division/…) with no body of its own; one
    // that carries guide text is kept. Only containers pay for the body-minus-
    // header pass, so the common operative-section path skips it.
    if (CONTAINER_RE.test(section.section_ref) && bodyToText(section.body.slice(1)) === '') {
      continue;
    }
    pushChunk({
      doc_ref,
      section_ref: section.section_ref,
      heading: section.heading,
      text: bodyToText(section.body),
    });
  }
  return result;
}
