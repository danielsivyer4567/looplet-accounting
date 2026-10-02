import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type AtoLodgeAuthorizer, handleAtoLodge } from "./index.ts";

const signedIn: AtoLodgeAuthorizer = () => Promise.resolve({ ok: true, caller: { kind: "user", userId: "u1" } });
const signedOut: AtoLodgeAuthorizer = () => Promise.resolve({ ok: false, status: 401, error: "Unauthorized" });

function env(values: Record<string, string> = {}) {
  return { get: (name: string) => values[name] };
}

function post(body: Record<string, unknown>) {
  return new Request("http://localhost/ato-lodge", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

Deno.test("approved lodgement drafts still require a true-and-correct declaration", async () => {
  const res = await handleAtoLodge(
    post({
      approval_id: "11111111-1111-4111-8111-111111111111",
      lodgement_id: "22222222-2222-4222-8222-222222222222",
    }),
    env(),
    signedIn,
  );
  const body = await res.json();

  assertEquals(res.status, 403);
  assertEquals(body.error, "FORBIDDEN");
  assertEquals(body.blocked_action, "true_and_correct_declaration");
  assertEquals(body.requires_true_and_correct_declaration, true);
});

Deno.test("declared lodgement attempts stop at the ATO/SBR operations wall when gateway config is absent", async () => {
  const res = await handleAtoLodge(
    post({
      approval_id: "11111111-1111-4111-8111-111111111111",
      lodgement_id: "22222222-2222-4222-8222-222222222222",
      declaration_accepted: true,
    }),
    env(),
    signedIn,
  );
  const body = await res.json();

  assertEquals(res.status, 403);
  assertEquals(body.error, "FORBIDDEN");
  assertEquals(body.blocked_action, "ato_sbr_lodgement_submit");
  assertEquals(body.declaration_accepted, true);
  assert(body.missing.evte.length > 0);
  assert(body.missing.dsp.length > 0);
  assert(body.missing.sbr.length > 0);
});


Deno.test("callers who are not signed in are refused before any configuration detail is returned", async () => {
  for (const body of [{}, { approval_id: "a", lodgement_id: "b", declaration_accepted: true }]) {
    const res = await handleAtoLodge(post(body), env(), signedOut);
    const payload = await res.json();
    assertEquals(res.status, 401);
    assertEquals(payload, { ok: false, error: "Unauthorized" });
  }
});

Deno.test("signed-in callers still get the fail-closed configuration health", async () => {
  const res = await handleAtoLodge(post({}), env(), signedIn);
  const payload = await res.json();
  assertEquals(res.status, 200);
  assertEquals(payload.lodgement_enabled, false);
  assertEquals(payload.configured, false);
});
