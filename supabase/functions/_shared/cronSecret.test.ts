import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CRON_SECRET_HEADER, hasCronSecret, presentedCronSecret } from "./cronSecret.ts";

const call = (opts: { header?: string; query?: string } = {}) => {
  const url = new URL("https://ref.supabase.co/functions/v1/bank-sync-all");
  if (opts.query !== undefined) url.searchParams.set("secret", opts.query);
  return new Request(url, { method: "POST", headers: opts.header !== undefined ? { [CRON_SECRET_HEADER]: opts.header } : {} });
};

Deno.test("cron jobs authenticate with the X-Cron-Secret header", () => {
  assertEquals(CRON_SECRET_HEADER, "X-Cron-Secret");
  assert(hasCronSecret(call({ header: "s3cret-value" }), "s3cret-value"));
  assertFalse(hasCronSecret(call({ header: "s3cret-valuX" }), "s3cret-value"));
  assertFalse(hasCronSecret(call({ header: "s3cret" }), "s3cret-value"));
  assertFalse(hasCronSecret(call(), "s3cret-value"));
});

Deno.test("an unset expected secret never matches, even an empty presented one", () => {
  assertFalse(hasCronSecret(call({ header: "" }), ""));
  assertFalse(hasCronSecret(call({ header: "x" }), undefined));
  assertFalse(hasCronSecret(call({ query: "" }), null));
});

Deno.test("the header wins over the URL; a wrong header is not rescued by a right URL secret", () => {
  assertEquals(presentedCronSecret(call({ header: "from-header", query: "from-url" })), "from-header");
  assertFalse(hasCronSecret(call({ header: "wrong", query: "s3cret-value" }), "s3cret-value"));
});

Deno.test("for one release the legacy ?secret= still works, with a warning", () => {
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    assert(hasCronSecret(call({ query: "s3cret-value" }), "s3cret-value"));
    assertFalse(hasCronSecret(call({ query: "nope" }), "s3cret-value"));
  } finally {
    console.warn = original;
  }
  assertEquals(warnings.length, 2);
  assert(String(warnings[0]).includes("/functions/v1/bank-sync-all"));
  assert(String(warnings[0]).includes("X-Cron-Secret"));
  assertFalse(String(warnings[0]).includes("s3cret-value"), "the warning must not log the secret");
});
