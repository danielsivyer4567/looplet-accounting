// Server errors never reach the client in raw form. A 5xx body used to carry database messages, upstream
// API errors and exception text (table names, constraint names, configuration hints). The shared
// Deno.serve wrapper in cors.ts passes every response through redactServerError(): a 5xx body is logged
// here, server-side, with a reference, and the client gets a generic message with the same reference.
// 4xx bodies are left alone: they describe the caller's own request.

export const GENERIC_SERVER_ERROR = 'Something went wrong on our side. Please try again.';

const MAX_LOGGED_BODY = 4000;

/** A reference to quote in support: the caller's x-request-id if it is a plain token, else a new id. */
export function errorReference(req: Request): string {
  const given = req.headers.get('x-request-id') ?? '';
  return /^[A-Za-z0-9._-]{8,64}$/.test(given) ? given : crypto.randomUUID();
}

function where(req: Request): string {
  return `${req.method} ${new URL(req.url).pathname}`;
}

function genericBody(reference: string): string {
  return JSON.stringify({ ok: false, error: GENERIC_SERVER_ERROR, request_id: reference });
}

/** Replaces a 5xx response body with a generic one, logging the original. Other responses pass through. */
export async function redactServerError(req: Request, res: Response): Promise<Response> {
  if (res.status < 500 || res.status > 599) return res;
  const reference = errorReference(req);
  let original: string;
  try {
    original = await res.text();
  } catch {
    original = '<unreadable body>';
  }
  console.error(`[server-error ${reference}] ${where(req)} -> ${res.status}: ${original.slice(0, MAX_LOGGED_BODY)}`);
  const headers = new Headers(res.headers);
  headers.set('Content-Type', 'application/json');
  headers.delete('Content-Length');
  return new Response(genericBody(reference), { status: res.status, statusText: res.statusText, headers });
}

/** A generic 500 for an exception, logged with its stack. For handlers and the shared wrapper. */
export function serverError(err: unknown, req: Request, headers: HeadersInit = {}): Response {
  const reference = errorReference(req);
  const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  console.error(`[server-error ${reference}] ${where(req)} threw: ${detail.slice(0, MAX_LOGGED_BODY)}`);
  const out = new Headers(headers);
  out.set('Content-Type', 'application/json');
  return new Response(genericBody(reference), { status: 500, headers: out });
}
