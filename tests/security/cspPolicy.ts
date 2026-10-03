import { readFileSync } from 'node:fs';

// Reads the production security headers from public/_headers (Cloudflare Pages format) and answers
// "would the browser allow this URL under this directive?" following the CSP Level 3 matching rules
// for the source expressions this policy uses: 'self', 'none', scheme sources (https:, data:, blob:),
// and host sources with an optional *. subdomain wildcard, port and path. Keywords that do not name
// URLs ('unsafe-inline' and the like) never match a URL.

export const HEADERS_FILE = 'public/_headers';

/** Header name → value for the `/*` block (header names lower-cased). */
export function readHeaders(file = HEADERS_FILE): Map<string, string> {
  const headers = new Map<string, string>();
  let inAll = false;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      inAll = line.trim() === '/*';
      continue;
    }
    if (!inAll) continue;
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error(`malformed header line: ${line}`);
    const name = line.slice(0, colon).trim().toLowerCase();
    if (headers.has(name)) throw new Error(`duplicate header ${name}`);
    headers.set(name, line.slice(colon + 1).trim());
  }
  return headers;
}

export type Csp = Map<string, string[]>;

export function parseCsp(value: string): Csp {
  const csp: Csp = new Map();
  for (const part of value.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    if (csp.has(name.toLowerCase())) throw new Error(`duplicate CSP directive ${name}`);
    csp.set(name.toLowerCase(), sources);
  }
  return csp;
}

// CSP3 fallback lists for the fetch directives this app relies on.
const FALLBACK: Record<string, string[]> = {
  'frame-src': ['frame-src', 'child-src', 'default-src'],
  'worker-src': ['worker-src', 'child-src', 'script-src', 'default-src'],
  'script-src': ['script-src', 'default-src'],
  'img-src': ['img-src', 'default-src'],
  'media-src': ['media-src', 'default-src'],
  'connect-src': ['connect-src', 'default-src'],
};

/** The source list the browser uses for a fetch directive, after fallback. */
export function effectiveSources(csp: Csp, directive: string): string[] {
  for (const name of FALLBACK[directive] ?? [directive]) {
    const sources = csp.get(name);
    if (sources) return sources;
  }
  return ['*'];
}

function matchesSource(source: string, url: URL, page: URL): boolean {
  if (source === "'none'") return false;
  if (source === "'self'") {
    return (
      url.host === page.host &&
      (url.protocol === page.protocol || (page.protocol === 'http:' && url.protocol === 'https:'))
    );
  }
  if (source.startsWith("'")) return false; // nonces, hashes and keywords never match a URL
  const scheme = /^([a-z][a-z0-9+.-]*):$/i.exec(source);
  if (scheme) {
    const want = `${scheme[1]?.toLowerCase()}:`;
    return url.protocol === want || (want === 'http:' && url.protocol === 'https:');
  }
  if (source === '*') return !['data:', 'blob:', 'filesystem:'].includes(url.protocol);
  const host = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|\*\.[^/:]+|[^/:*]+)(?::(\d+|\*))?(\/.*)?$/i.exec(
    source,
  );
  if (!host) throw new Error(`unrecognised CSP source ${source}`);
  const [, srcScheme, srcHost = '', srcPort, srcPath] = host;
  if (srcScheme) {
    const want = `${srcScheme.toLowerCase()}:`;
    if (!(url.protocol === want || (want === 'http:' && url.protocol === 'https:'))) return false;
  } else if (
    !(url.protocol === page.protocol || (page.protocol === 'http:' && url.protocol === 'https:'))
  ) {
    return false;
  }
  const urlHost = url.hostname.toLowerCase();
  const wanted = srcHost.toLowerCase();
  if (wanted.startsWith('*.')) {
    if (!urlHost.endsWith(wanted.slice(1))) return false;
  } else if (wanted !== '*' && urlHost !== wanted) {
    return false;
  }
  const defaultPort = url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80';
  const urlPort = url.port || defaultPort;
  if (srcPort === '*') {
    // any port
  } else if ((srcPort ?? defaultPort) !== urlPort) {
    return false;
  }
  if (srcPath) {
    const path = decodeURIComponent(url.pathname);
    return srcPath.endsWith('/') ? path.startsWith(srcPath) : path === srcPath;
  }
  return true;
}

/** Would a page at `pageUrl` under `csp` be allowed to load `target` for `directive`? */
export function allows(
  csp: Csp,
  directive: string,
  target: string,
  pageUrl = 'https://accounting.looplet.com.au/',
): boolean {
  const url = new URL(target);
  const page = new URL(pageUrl);
  return effectiveSources(csp, directive).some((source) => matchesSource(source, url, page));
}

/** Permissions-Policy feature → allowlist tokens, e.g. microphone=(self) → ['self']. */
export function parsePermissionsPolicy(value: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of value.split(',')) {
    const match = /^\s*([a-z-]+)=(\*|\(([^)]*)\))\s*$/.exec(part);
    if (!match) throw new Error(`malformed Permissions-Policy entry: ${part}`);
    const feature = match[1] ?? '';
    if (out.has(feature)) throw new Error(`duplicate Permissions-Policy feature ${feature}`);
    out.set(feature, match[2] === '*' ? ['*'] : (match[3] ?? '').split(/\s+/).filter(Boolean));
  }
  return out;
}
