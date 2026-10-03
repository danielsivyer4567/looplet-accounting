// SEC-07: CORS allow-list. Run: deno test --allow-env --allow-read --allow-net supabase/functions/_shared/cors.test.ts
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  allowedOrigins,
  APP_ORIGIN,
  corsHeaders,
  corsHeadersFor,
  isAllowedOrigin,
  preflight,
  withCors,
} from "./cors.ts";

const env = (vars: Record<string, string>) => ({ get: (key: string) => vars[key] });
const req = (method: string, origin?: string) =>
  new Request("https://ref.supabase.co/functions/v1/x", { method, headers: origin ? { Origin: origin } : {} });

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
}

Deno.test("the default allow-list is the app, its Pages project and local Vite ports, never *", () => {
  const origins = allowedOrigins(env({}));
  for (const origin of [
    "https://accounting.looplet.com.au",
    "https://looplet-accounting.pages.dev",
    "http://localhost:4000",
    "http://127.0.0.1:4000",
    "http://localhost:4173",
    "http://localhost:5173",
  ]) assert(origins.has(origin), origin);
  assertFalse(origins.has("*"));
  assert(isAllowedOrigin("https://3f2a1b.looplet-accounting.pages.dev", env({})));
  for (const origin of [
    "https://evil.example",
    "https://accounting.looplet.com.au.evil.example",
    "https://evil-looplet-accounting.pages.dev",
    "https://a.b.looplet-accounting.pages.dev",
    "http://accounting.looplet.com.au",
    "http://localhost:3000",
    "null",
    "",
  ]) assertFalse(isAllowedOrigin(origin, env({})), origin);
  assertFalse(isAllowedOrigin(null, env({})));
});

Deno.test("CORS_ALLOWED_ORIGINS adds exact origins; wildcards and malformed entries are ignored", () => {
  const vars = env({
    CORS_ALLOWED_ORIGINS: "https://staging.looplet.com.au, https://other.example  *, https://x.example/path, ftp://f.example, nonsense",
    CORS_ALLOWED_ORIGIN: "https://legacy.example",
  });
  assert(isAllowedOrigin("https://staging.looplet.com.au", vars));
  assert(isAllowedOrigin("https://other.example", vars));
  assert(isAllowedOrigin("https://legacy.example", vars));
  assertFalse(isAllowedOrigin("https://x.example", vars));
  assertFalse(isAllowedOrigin("ftp://f.example", vars));
  assertFalse(allowedOrigins(vars).has("*"));
  // The old escape hatch CORS_ALLOWED_ORIGIN='*' no longer opens everything.
  assertFalse(isAllowedOrigin("https://evil.example", env({ CORS_ALLOWED_ORIGIN: "*" })));
});

Deno.test("the static corsHeaders no longer allow every origin", () => {
  assert(corsHeaders["Access-Control-Allow-Origin"] !== "*");
  if (!Deno.env.get("CORS_ALLOWED_ORIGINS") && !Deno.env.get("CORS_ALLOWED_ORIGIN")) {
    assertEquals(corsHeaders["Access-Control-Allow-Origin"], APP_ORIGIN);
  }
  assertEquals(corsHeaders["Vary"], "Origin");
  assertEquals(corsHeaders["Access-Control-Allow-Methods"], "POST, OPTIONS");
});

Deno.test("preflight answers allowed origins with their own origin and refuses others", async () => {
  await withEnv({ CORS_ALLOWED_ORIGINS: undefined, CORS_ALLOWED_ORIGIN: undefined }, async () => {
    assertEquals(preflight(req("POST", "http://localhost:4000")), null);

    const ok = preflight(req("OPTIONS", "http://localhost:4000"));
    assert(ok);
    assertEquals(ok.status, 200);
    assertEquals(ok.headers.get("Access-Control-Allow-Origin"), "http://localhost:4000");
    assertEquals(ok.headers.get("Access-Control-Allow-Headers"), "authorization, x-client-info, apikey, content-type, x-request-id");
    assertEquals(ok.headers.get("Vary"), "Origin");
    await ok.body?.cancel();

    const refused = preflight(req("OPTIONS", "https://evil.example"));
    assert(refused);
    assertEquals(refused.status, 403);
    assertEquals(refused.headers.get("Access-Control-Allow-Origin"), null);
    await refused.body?.cancel();

    // No Origin: not a browser CORS request; answer as before with the static headers.
    const plain = preflight(req("OPTIONS"));
    assertEquals(plain?.headers.get("Access-Control-Allow-Origin"), corsHeaders["Access-Control-Allow-Origin"]);
    await plain?.body?.cancel();
  });
});

Deno.test("corsHeadersFor reflects an allowed origin and leaves Allow-Origin out otherwise", async () => {
  await withEnv({ CORS_ALLOWED_ORIGINS: "https://staging.looplet.com.au", CORS_ALLOWED_ORIGIN: undefined }, () => {
    assertEquals(corsHeadersFor(req("POST", "https://staging.looplet.com.au"))["Access-Control-Allow-Origin"], "https://staging.looplet.com.au");
    assertEquals(corsHeadersFor(req("POST", "https://evil.example"))["Access-Control-Allow-Origin"], undefined);
  });
});

Deno.test("withCors fixes responses built from the static headers, and only those", async () => {
  await withEnv({ CORS_ALLOWED_ORIGINS: undefined, CORS_ALLOWED_ORIGIN: undefined }, async () => {
    const make = () => new Response("{}", { headers: { ...corsHeaders, "Content-Type": "application/json", Vary: "Accept-Encoding" } });

    const fromDev = withCors(req("POST", "http://127.0.0.1:4000"), make());
    assertEquals(fromDev.headers.get("Access-Control-Allow-Origin"), "http://127.0.0.1:4000");
    assertEquals(fromDev.headers.get("Vary"), "Accept-Encoding, Origin");

    const fromEvil = withCors(req("POST", "https://evil.example"), make());
    assertEquals(fromEvil.headers.get("Access-Control-Allow-Origin"), null);

    const fromServer = withCors(req("POST"), make());
    assertEquals(fromServer.headers.get("Access-Control-Allow-Origin"), corsHeaders["Access-Control-Allow-Origin"]);

    // A response that never opted into CORS (webhook, cron) is not given CORS headers.
    const noCors = withCors(req("POST", APP_ORIGIN), new Response("ok"));
    assertEquals(noCors.headers.get("Access-Control-Allow-Origin"), null);

    for (const r of [fromDev, fromEvil, fromServer, noCors]) await r.body?.cancel();
  });
});

Deno.test("an existing function served with Deno.serve answers each allowed origin with its own origin", async () => {
  await withEnv({ CORS_ALLOWED_ORIGINS: undefined, CORS_ALLOWED_ORIGIN: undefined }, async () => {
    // The shape of every existing function: preflight first, then responses built from corsHeaders.
    let port = 0;
    const server: Deno.HttpServer<Deno.NetAddr> = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (r): Promise<Response> => {
      const pre = preflight(r);
      if (pre) return pre;
      // A function that passes an upstream fetch response straight through (its headers are immutable).
      if (new URL(r.url).pathname === "/proxy") return await fetch(`http://127.0.0.1:${port}/`, { method: "POST" });
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    });
    port = server.addr.port;
    const url = `http://127.0.0.1:${port}/`;
    try {
      for (const origin of ["http://localhost:4000", "https://looplet-accounting.pages.dev", APP_ORIGIN]) {
        const res = await fetch(url, { method: "POST", headers: { Origin: origin } });
        assertEquals(res.headers.get("Access-Control-Allow-Origin"), origin, origin);
        assertEquals(res.headers.get("Vary"), "Origin");
        assertEquals(await res.json(), { ok: true });
      }
      const proxied = await fetch(`${url}proxy`, { method: "POST", headers: { Origin: "http://localhost:5173" } });
      assertEquals(proxied.headers.get("Access-Control-Allow-Origin"), "http://localhost:5173");
      assertEquals(await proxied.json(), { ok: true });
      const evil = await fetch(url, { method: "POST", headers: { Origin: "https://evil.example" } });
      assertEquals(evil.headers.get("Access-Control-Allow-Origin"), null);
      await evil.body?.cancel();
      const evilPre = await fetch(url, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
      assertEquals(evilPre.status, 403);
      await evilPre.body?.cancel();
    } finally {
      await server.shutdown();
    }
  });
});

Deno.test("the same wrapper keeps raw error text out of 5xx bodies, and errors still carry CORS headers", async () => {
  await withEnv({ CORS_ALLOWED_ORIGINS: undefined, CORS_ALLOWED_ORIGIN: undefined }, async () => {
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    // The shapes existing functions use: a database error in a 500 body, an uncaught throw, and a 400.
    const server: Deno.HttpServer<Deno.NetAddr> = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (r): Response => {
      const path = new URL(r.url).pathname;
      const headers = { ...corsHeaders, "Content-Type": "application/json" };
      if (path === "/db-error") {
        return new Response(JSON.stringify({ ok: false, error: 'load schedules: relation "public.asset_schedules" does not exist' }), { status: 500, headers });
      }
      if (path === "/throw") throw new Error('duplicate key value violates unique constraint "bills_pkey"');
      return new Response(JSON.stringify({ ok: false, error: "organization_id is required" }), { status: 400, headers });
    });
    const url = `http://127.0.0.1:${server.addr.port}`;
    const origin = { Origin: "http://localhost:4000" };
    try {
      const dbError = await fetch(`${url}/db-error`, { method: "POST", headers: origin });
      assertEquals(dbError.status, 500);
      assertEquals(dbError.headers.get("Access-Control-Allow-Origin"), "http://localhost:4000");
      const dbBody = await dbError.json();
      assertEquals(dbBody.ok, false);
      assertEquals(dbBody.error, "Something went wrong on our side. Please try again.");
      assert(typeof dbBody.request_id === "string" && dbBody.request_id.length > 0);
      assertFalse(JSON.stringify(dbBody).includes("asset_schedules"));

      const thrown = await fetch(`${url}/throw`, { method: "POST", headers: origin });
      assertEquals(thrown.status, 500);
      assertEquals(thrown.headers.get("Access-Control-Allow-Origin"), "http://localhost:4000");
      assertFalse((await thrown.text()).includes("bills_pkey"));

      const bad = await fetch(`${url}/bad`, { method: "POST", headers: origin });
      assertEquals(bad.status, 400);
      assertEquals((await bad.json()).error, "organization_id is required");

      // The details went to the server log instead, with the reference the client was given.
      assert(logged.some((l) => l.includes("asset_schedules") && l.includes(dbBody.request_id)));
      assert(logged.some((l) => l.includes("bills_pkey")));
    } finally {
      console.error = originalError;
      await server.shutdown();
    }
  });
});
