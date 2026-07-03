import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isInboundAuthorized } from "./index.ts";

// The inbound webhook is deployed verify_jwt=false, so isInboundAuthorized is the
// ONLY auth gate: false -> the handler returns 403; true -> the handler proceeds
// (200). These three cases pin the slice's fail-closed contract.

Deno.test("absent secret -> 403 (fail CLOSED, even with a header present)", () => {
  // EMAIL_INBOUND_SECRET unset/empty: reject everything, never wave through.
  assertEquals(isInboundAuthorized(undefined, "anything"), false);
  assertEquals(isInboundAuthorized(null, "anything"), false);
  assertEquals(isInboundAuthorized("", "anything"), false);
  // Unset secret + absent header is also rejected (not a silent 200).
  assertEquals(isInboundAuthorized(undefined, null), false);
});

Deno.test("wrong / missing header -> 403 when a secret is configured", () => {
  const secret = "s3cret-inbound-token";
  assertEquals(isInboundAuthorized(secret, "wrong-token"), false);
  assertEquals(isInboundAuthorized(secret, null), false);
  assertEquals(isInboundAuthorized(secret, undefined), false);
  assertEquals(isInboundAuthorized(secret, ""), false);
  // A near-miss of the same length is still rejected (constant-time compare).
  assertEquals(isInboundAuthorized("abcdef", "abcdeg"), false);
  // A prefix of the real secret is rejected (length mismatch).
  assertEquals(isInboundAuthorized(secret, secret.slice(0, -1)), false);
});

Deno.test("correct header -> authorized (handler proceeds to 200)", () => {
  const secret = "s3cret-inbound-token";
  assertEquals(isInboundAuthorized(secret, secret), true);
});
