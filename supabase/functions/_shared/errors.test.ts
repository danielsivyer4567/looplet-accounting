import { assert, assertEquals, assertFalse, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { errorReference, GENERIC_SERVER_ERROR, redactServerError, serverError } from "./errors.ts";

const req = (headers: Record<string, string> = {}) =>
  new Request("https://ref.supabase.co/functions/v1/bills-extract", { method: "POST", headers });

function captureErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => (console.error = original) };
}

Deno.test("a 5xx body is replaced with a generic message and a reference; the original is logged", async () => {
  const log = captureErrors();
  try {
    const raw = new Response(JSON.stringify({ ok: false, error: 'Storage read failed: relation "storage.objects" does not exist' }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://accounting.looplet.com.au", "Retry-After": "5" },
    });
    const res = await redactServerError(req({ "x-request-id": "req-12345678" }), raw);
    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body, { ok: false, error: GENERIC_SERVER_ERROR, request_id: "req-12345678" });
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "https://accounting.looplet.com.au");
    assertEquals(res.headers.get("Retry-After"), "5");
    assertEquals(log.lines.length, 1);
    assert(log.lines[0].includes("req-12345678"));
    assert(log.lines[0].includes("POST /functions/v1/bills-extract -> 500"));
    assert(log.lines[0].includes('relation \\"storage.objects\\" does not exist'));
  } finally {
    log.restore();
  }
});

Deno.test("every 5xx is redacted (502 upstream errors too); 4xx and 2xx pass through untouched", async () => {
  const log = captureErrors();
  try {
    const upstream = await redactServerError(req(), new Response("Groq API error 401: invalid key gsk_...", { status: 502 }));
    assertEquals(upstream.status, 502);
    assertEquals((await upstream.json()).error, GENERIC_SERVER_ERROR);

    const bad = new Response(JSON.stringify({ ok: false, error: "organization_id is required" }), { status: 400 });
    assertEquals(await redactServerError(req(), bad), bad);
    const ok = new Response("{}", { status: 200 });
    assertEquals(await redactServerError(req(), ok), ok);
  } finally {
    log.restore();
  }
});

Deno.test("serverError logs the exception and returns a generic 500 with the given headers", async () => {
  const log = captureErrors();
  try {
    const res = serverError(new Error('duplicate key value violates unique constraint "bills_pkey"'), req(), { Vary: "Origin" });
    assertEquals(res.status, 500);
    assertEquals(res.headers.get("Vary"), "Origin");
    const body = await res.json();
    assertEquals(body.error, GENERIC_SERVER_ERROR);
    assertFalse(JSON.stringify(body).includes("bills_pkey"));
    assert(log.lines[0].includes("bills_pkey"));
  } finally {
    log.restore();
  }
});

Deno.test("the reference is the caller's x-request-id only when it is a plain token", () => {
  assertEquals(errorReference(req({ "x-request-id": "abc-123_45.6" })), "abc-123_45.6");
  assertMatch(errorReference(req({ "x-request-id": "<script>alert(1)</script>" })), /^[0-9a-f-]{36}$/);
  assertMatch(errorReference(req()), /^[0-9a-f-]{36}$/);
});
