import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { AI_HOURLY_LIMITS, enforceAiQuota, hourlyLimit, type QuotaRpc } from "./aiRateLimit.ts";

const env = (vars: Record<string, string> = {}) => ({ get: (k: string) => vars[k] });

function rpcReturning(result: { data: unknown; error: { message: string; code?: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin: QuotaRpc = {
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve(result);
    },
  };
  return { admin, calls };
}

Deno.test("an allowed call takes one unit of the user's hourly quota for that feature", async () => {
  const { admin, calls } = rpcReturning({ data: [{ allowed: true, used: 3, retry_after_seconds: 0 }], error: null });
  const res = await enforceAiQuota(admin, "user-1", "ask_bot", {}, env());
  assertEquals(res, null);
  assertEquals(calls, [{
    fn: "consume_ai_quota",
    args: { p_user_id: "user-1", p_feature: "ask_bot", p_limit: AI_HOURLY_LIMITS.ask_bot, p_window_seconds: 3600 },
  }]);
});

Deno.test("a used-up quota answers 429 with Retry-After and a plain message, keeping the CORS headers", async () => {
  const { admin } = rpcReturning({ data: [{ allowed: false, used: 200, retry_after_seconds: 754 }], error: null });
  const res = await enforceAiQuota(admin, "user-1", "bank_statement_extract", { "Access-Control-Allow-Origin": "https://accounting.looplet.com.au" }, env());
  assert(res);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("Retry-After"), "754");
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "https://accounting.looplet.com.au");
  assertEquals(await res.json(), {
    ok: false,
    code: "rate_limited",
    error: "You have reached the limit of 200 uses an hour for this feature. Try again in 13 minutes.",
    retry_after_seconds: 754,
  });
});

Deno.test("AI_RATE_LIMIT_<FEATURE> overrides a default; nonsense values are ignored", () => {
  assertEquals(hourlyLimit("ask_bot", env({ AI_RATE_LIMIT_ASK_BOT: "15" })), 15);
  assertEquals(hourlyLimit("ask_bot", env({ AI_RATE_LIMIT_ASK_BOT: "0" })), AI_HOURLY_LIMITS.ask_bot);
  assertEquals(hourlyLimit("ask_bot", env({ AI_RATE_LIMIT_ASK_BOT: "lots" })), AI_HOURLY_LIMITS.ask_bot);
  assertEquals(hourlyLimit("staged_entities_enrich", env({ AI_RATE_LIMIT_STAGED_ENTITIES_ENRICH: "5" })), 5);
});

Deno.test("a database error fails closed with 503; a not-yet-installed limiter lets the call through", async () => {
  const quiet = { error: console.error, warn: console.warn };
  console.error = () => undefined;
  console.warn = () => undefined;
  try {
    const down = await enforceAiQuota(rpcReturning({ data: null, error: { message: "connection refused", code: "08006" } }).admin, "u", "advisor", {}, env());
    assertEquals(down?.status, 503);
    await down?.body?.cancel();
    const missing = await enforceAiQuota(
      rpcReturning({ data: null, error: { message: "Could not find the function public.consume_ai_quota", code: "PGRST202" } }).admin,
      "u",
      "advisor",
      {},
      env(),
    );
    assertEquals(missing, null);
    // No row back (unexpected) is treated as refused, never as allowed.
    const empty = await enforceAiQuota(rpcReturning({ data: [], error: null }).admin, "u", "advisor", {}, env());
    assertEquals(empty?.status, 429);
    await empty?.body?.cancel();
  } finally {
    console.error = quiet.error;
    console.warn = quiet.warn;
  }
});
