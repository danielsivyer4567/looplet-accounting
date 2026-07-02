import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleAtoLodge } from "./index.ts";

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

