export interface LegalSourceFetchRow {
  name: string;
  kind: string;
  canonical_url: string;
  check_method: string;
}

export interface LegalSourceFetchResult {
  text: string;
  citation_url: string;
  effective_from: string | null;
  version_ref: string | null;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const USER_AGENT = 'looplet-legal-sync';
const DATE_RE = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/;
const MONTHS: Record<string, string> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};

async function getText(
  fetchFn: FetchLike,
  url: string,
): Promise<{ url: string; contentType: string; text: string }> {
  const res = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return {
    url: res.url || url,
    contentType: res.headers.get('Content-Type') ?? res.headers.get('content-type') ?? '',
    text: await res.text(),
  };
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    rsquo: "'",
    lsquo: "'",
    rdquo: '"',
    ldquo: '"',
    ndash: '-',
    mdash: '—',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (whole, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
    if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
    return named[key] ?? whole;
  });
}

function stripElement(html: string, tag: string): string {
  return html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), '\n');
}

export function htmlToPlainLegalText(html: string): string {
  let out = html;
  out = out.replace(/<!--[\s\S]*?-->/g, '\n');
  for (const tag of ['script', 'style', 'head', 'noscript', 'template', 'svg']) {
    out = stripElement(out, tag);
  }

  // FRL tables of provisions duplicate every section heading before the real
  // operative text, which would otherwise collide during versioned upsert.
  out = out.replace(/<p\b[^>]*class=["'][^"']*TofSects[^"']*["'][^>]*>[\s\S]*?<\/p>/gi, '\n');
  out = out.replace(/<img\b[^>]*\balt=["']([^"']+)["'][^>]*>/gi, '\n$1\n');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/(?:p|div|section|article|li|tr|h[1-6]|table)>/gi, '\n');
  out = out.replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, '\t');
  out = out.replace(/<[^>]+>/g, '');
  out = decodeHtml(out)
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2010\u2011\u2012\u2013]/g, '-')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\r\n?|\f/g, '\n');

  const lines = out
    .split('\n')
    .map((line) =>
      line
        .replace(/[ \t]{3,}/g, '  ')
        .replace(/[ \t]+$/g, '')
        .trimStart(),
    )
    .filter((line, index, all) => line !== '' || all[index - 1] !== '');
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseAuDate(value: string | null): string | null {
  if (!value) return null;
  const match = DATE_RE.exec(value.trim());
  if (!match) return null;
  const month = MONTHS[(match[2] ?? '').toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${month}-${(match[1] ?? '').padStart(2, '0')}`;
}

function firstMatch(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return htmlToPlainLegalText(match[1]);
  }
  return null;
}

function extractFrlMetadata(html: string): {
  effective_from: string | null;
  version_ref: string | null;
} {
  const effectiveText =
    firstMatch(html, [
      /<span\b[^>]*class=["'][^"']*date-effective-start[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
      /<o:StartDate\b[^>]*>([\s\S]*?)<\/o:StartDate>/i,
    ]) ??
    firstMatch(html, [/Compilation date:\s*<\/span>[\s\S]*?<span\b[^>]*>([\s\S]*?)<\/span>/i]);

  const itemId = firstMatch(html, [
    /<span\b[^>]*class=["'][^"']*item-id[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
  ]);
  const compilationNumber = firstMatch(html, [
    /<o:CompilationNumber\b[^>]*>([\s\S]*?)<\/o:CompilationNumber>/i,
  ]);
  const version_ref = itemId ?? (compilationNumber ? `Compilation ${compilationNumber}` : null);
  return { effective_from: parseAuDate(effectiveText), version_ref };
}

function frlSeriesId(url: string): string | null {
  const parsed = new URL(url);
  if (!/legislation\.gov\.au$/i.test(parsed.hostname)) return null;
  const match = /^\/(?:Series\/)?([A-Z]\d{4}[A-Z]\d{5})(?:\/|$)/i.exec(parsed.pathname);
  return match?.[1]?.toUpperCase() ?? null;
}

function hrefs(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = decodeHtml(match[1] ?? '');
    try {
      const url = new URL(href, baseUrl);
      url.hash = '';
      out.push(url.href);
    } catch {
      // Ignore malformed page links.
    }
  }
  return out;
}

function frlDocumentOrder(url: string): number {
  const match = /\/document_(\d+)\//i.exec(url);
  return match?.[1] ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

async function fetchFrlSource(
  source: LegalSourceFetchRow,
  fetchFn: FetchLike,
): Promise<LegalSourceFetchResult> {
  const seriesId = frlSeriesId(source.canonical_url);
  if (!seriesId) throw new Error(`not an FRL source URL: ${source.canonical_url}`);

  const origin = new URL(source.canonical_url).origin;
  const textPageUrl = `${origin}/${seriesId}/latest/text`;
  const textPage = await getText(fetchFn, textPageUrl);
  const metadata = extractFrlMetadata(textPage.text);

  const docUrls = Array.from(
    new Set(
      hrefs(textPage.text, textPage.url).filter((url) =>
        /\/text\/original\/epub\/OEBPS\/document_\d+\/document_\d+\.html$/i.test(url),
      ),
    ),
  ).sort((a, b) => frlDocumentOrder(a) - frlDocumentOrder(b) || a.localeCompare(b));

  if (docUrls.length === 0) {
    const text = htmlToPlainLegalText(textPage.text);
    if (!text) throw new Error(`FRL text page had no extractable text: ${textPageUrl}`);
    return { text, citation_url: textPageUrl, ...metadata };
  }

  const docs = await Promise.all(docUrls.map((url) => getText(fetchFn, url)));
  const text = docs
    .map((doc) => htmlToPlainLegalText(doc.text))
    .filter(Boolean)
    .join('\n\n');
  if (!text) throw new Error(`FRL EPUB documents had no extractable text: ${textPageUrl}`);
  return { text, citation_url: textPageUrl, ...metadata };
}

function isGenericAtoLanding(url: string): boolean {
  const parsed = new URL(url);
  if (!/ato\.gov\.au$/i.test(parsed.hostname)) return false;
  const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
  return path === '/law' || path === '/single-page-applications/legaldatabase';
}

async function fetchHtmlSource(
  source: LegalSourceFetchRow,
  fetchFn: FetchLike,
): Promise<LegalSourceFetchResult> {
  if (isGenericAtoLanding(source.canonical_url)) {
    throw new Error(
      'ATO Legal Database landing page is a search surface, not a source document; provide a specific ATO document URL or text',
    );
  }
  const fetched = await getText(fetchFn, source.canonical_url);
  const text = /html/i.test(fetched.contentType)
    ? htmlToPlainLegalText(fetched.text)
    : fetched.text.trim();
  if (!text) throw new Error(`source had no extractable text: ${source.canonical_url}`);
  return { text, citation_url: fetched.url, effective_from: null, version_ref: null };
}

export async function fetchLegalSourceText(
  source: LegalSourceFetchRow,
  fetchFn: FetchLike = fetch,
): Promise<LegalSourceFetchResult> {
  if (source.check_method === 'frl_api' || frlSeriesId(source.canonical_url)) {
    return await fetchFrlSource(source, fetchFn);
  }
  return await fetchHtmlSource(source, fetchFn);
}
