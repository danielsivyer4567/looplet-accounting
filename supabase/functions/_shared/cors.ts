// CORS for all Looplet Accounting edge functions.
//
// Browsers may call these functions only from an allow-listed origin. Auth (a Supabase JWT or a signed
// secret) is still the security boundary; the allow-list stops other sites from driving the API from a
// signed-in user's browser and replaces the old `*` default.
//
// Allowed origins:
//   - the app: https://accounting.looplet.com.au
//   - this Cloudflare Pages project and its preview deployments (only our Cloudflare account can
//     publish there): https://looplet-accounting.pages.dev, https://<preview>.looplet-accounting.pages.dev
//   - local development: Vite dev (4000, vite.config.ts), Vite preview (4173) and Vite's default
//     port (5173) on localhost and 127.0.0.1
//   - anything listed in CORS_ALLOWED_ORIGINS (comma- or space-separated full origins, e.g.
//     "https://staging.example.com, https://other.example.com"), plus the older single-origin
//     CORS_ALLOWED_ORIGIN. A "*" entry is ignored: the list never becomes a wildcard.
//
// Do NOT derive this from the email SITE_URL/APP_ORIGIN: pinning to one domain once blocked every
// other app domain and surfaced as "Failed to fetch" in the UI.
//
// Most functions build every response from the static `corsHeaders` below. A static header can name
// only one origin, so this module also wraps Deno.serve (every function imports this module before it
// calls Deno.serve): when a response carries CORS headers, the wrapper sets Access-Control-Allow-Origin
// to the request's own Origin if it is allowed, and removes it if not. Requests without an Origin
// (servers, cron, webhooks) are left alone. New code can call corsHeadersFor(req) or withCors(req, res)
// directly. The same wrapper keeps raw error text out of 5xx bodies (errors.ts).
import { redactServerError, serverError } from './errors.ts';

export const APP_ORIGIN = 'https://accounting.looplet.com.au';

export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  APP_ORIGIN,
  'https://looplet-accounting.pages.dev',
  ...[4000, 4173, 5173].flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]),
];

const PAGES_PREVIEW = /^https:\/\/[a-z0-9-]+\.looplet-accounting\.pages\.dev$/;

type EnvReader = Pick<typeof Deno.env, 'get'>;

/** A configured entry is kept only if it is exactly an http(s) origin (no path, no wildcard). */
function normaliseOrigin(entry: string): string | null {
  const value = entry.trim().replace(/\/$/, '');
  if (!value || value.includes('*')) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin === value.toLowerCase() ? url.origin : null;
  } catch {
    return null;
  }
}

/** The configured allow-list: defaults plus CORS_ALLOWED_ORIGINS and CORS_ALLOWED_ORIGIN. */
export function allowedOrigins(env: EnvReader = Deno.env): Set<string> {
  const out = new Set(DEFAULT_ALLOWED_ORIGINS);
  const configured = `${env.get('CORS_ALLOWED_ORIGINS') ?? ''},${env.get('CORS_ALLOWED_ORIGIN') ?? ''}`;
  for (const entry of configured.split(/[\s,]+/)) {
    const origin = normaliseOrigin(entry);
    if (origin) out.add(origin);
  }
  return out;
}

export function isAllowedOrigin(origin: string | null, env: EnvReader = Deno.env): boolean {
  if (!origin) return false;
  return allowedOrigins(env).has(origin) || PAGES_PREVIEW.test(origin);
}

/** The origin the static headers name: the first configured origin, else the app. */
function primaryOrigin(env: EnvReader = Deno.env): string {
  for (const entry of `${env.get('CORS_ALLOWED_ORIGINS') ?? ''},${env.get('CORS_ALLOWED_ORIGIN') ?? ''}`.split(/[\s,]+/)) {
    const origin = normaliseOrigin(entry);
    if (origin) return origin;
  }
  return APP_ORIGIN;
}

const BASE_HEADERS = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-request-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
};

/**
 * Static headers, kept for every existing `{ ...corsHeaders }` caller. They name the primary origin;
 * the Deno.serve wrapper below swaps in the caller's own allowed origin per request.
 */
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': primaryOrigin(),
  ...BASE_HEADERS,
};

/** Headers for this request: its Origin when allowed; no Allow-Origin at all when not. */
export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin');
  if (origin === null) return { ...corsHeaders };
  return isAllowedOrigin(origin) ? { 'Access-Control-Allow-Origin': origin, ...BASE_HEADERS } : { ...BASE_HEADERS };
}

export function preflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null;
  const origin = req.headers.get('Origin');
  if (origin !== null && !isAllowedOrigin(origin)) {
    return new Response('origin not allowed', { status: 403, headers: { Vary: 'Origin' } });
  }
  return new Response('ok', { headers: corsHeadersFor(req) });
}

function setOrigin(headers: Headers, origin: string, allowed: boolean): void {
  if (allowed) headers.set('Access-Control-Allow-Origin', origin);
  else headers.delete('Access-Control-Allow-Origin');
  const vary = headers.get('Vary');
  if (!vary) headers.set('Vary', 'Origin');
  else if (!/(^|,)\s*(origin|\*)\s*(,|$)/i.test(vary)) headers.set('Vary', `${vary}, Origin`);
}

/**
 * Makes a response's CORS headers right for this request. Only responses that already opted into CORS
 * (they carry Access-Control-Allow-Origin) are changed, and only for browser requests (with an Origin).
 */
export function withCors(req: Request, res: Response): Response {
  const origin = req.headers.get('Origin');
  if (origin === null || res.status === 101 || !res.headers.has('Access-Control-Allow-Origin')) return res;
  const allowed = isAllowedOrigin(origin);
  try {
    setOrigin(res.headers, origin, allowed);
    return res;
  } catch {
    // Immutable headers (Response.redirect, a proxied fetch response): copy, then set.
    const copy = new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
    setOrigin(copy.headers, origin, allowed);
    return copy;
  }
}

type Handler = (req: Request, info: Deno.ServeHandlerInfo) => Response | Promise<Response>;
const WRAPPED = Symbol.for('looplet.cors.serve');

function wrapHandler(handler: Handler): Handler {
  return async (req, info) => {
    let res: Response;
    try {
      res = await handler(req, info);
    } catch (err) {
      // An uncaught exception becomes a logged, generic 500 that still carries CORS headers.
      res = serverError(err, req, corsHeaders);
    }
    return withCors(req, await redactServerError(req, res));
  };
}

/**
 * Wraps Deno.serve once so every function's responses get per-request CORS headers, and 5xx bodies are
 * replaced with a generic message (the original is logged server-side; see errors.ts).
 */
export function installCorsServeWrapper(): boolean {
  const original = Deno.serve as unknown as ((...args: unknown[]) => unknown) & { [WRAPPED]?: true };
  if (typeof original !== 'function') return false;
  if (original[WRAPPED]) return true;
  const wrapped = Object.assign(
    function serve(this: unknown, ...args: unknown[]) {
      // Deno.serve(handler) | Deno.serve(options, handler) | Deno.serve({ ...options, handler })
      if (typeof args[0] === 'function') args[0] = wrapHandler(args[0] as Handler);
      else if (typeof args[1] === 'function') args[1] = wrapHandler(args[1] as Handler);
      else if (args[0] && typeof (args[0] as { handler?: unknown }).handler === 'function') {
        const options = args[0] as { handler: Handler };
        args[0] = { ...options, handler: wrapHandler(options.handler) };
      }
      try {
        return Reflect.apply(original, this ?? Deno, args);
      } catch (err) {
        // Only the test runner hits this: several function modules imported into one process each call
        // Deno.serve at import and the second one finds the default port taken. The edge runtime assigns the
        // port itself, so in production this branch never runs. Retry on an ephemeral port rather than fail.
        if (!(err instanceof Deno.errors.AddrInUse)) throw err;
        const retry = [...args];
        if (typeof retry[0] === 'function') retry.unshift({ port: 0 });
        else if (retry[0] && typeof retry[0] === 'object') retry[0] = { ...(retry[0] as object), port: 0 };
        console.warn('[cors] default port in use; serving on an ephemeral port instead');
        return Reflect.apply(original, this ?? Deno, retry);
      }
    },
    { [WRAPPED]: true as const },
  );
  try {
    Object.defineProperty(Deno, 'serve', { value: wrapped, writable: true, configurable: true, enumerable: true });
    return true;
  } catch (err) {
    console.warn('[cors] could not wrap Deno.serve; responses keep the static CORS headers', err);
    return false;
  }
}

installCorsServeWrapper();
