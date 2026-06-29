// Run: deno test supabase/functions/ato-lodge/index.test.ts

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleAtoLodge } from "./index.ts";
import { type EnvReader } from "../_shared/ato/config.ts";

function env(values: Record<string, string>): EnvReader {
  return { get: (name: string) => values[name] };
}

function request(body: Record<string, unknown>): Request {
  return new Request("https://example.test/ato-lodge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SNAPSHOT = {
  id: "5c893d2f-0a4c-44d8-a999-85d8dcfca0d6",
  organization_id: "7e0d3a6c-a0c0-44f5-9df2-1165d8c4a053",
  fy_start_year: 2025,
  quarter_num: 2,
  quarter_start: "2025-10-01",
  quarter_end: "2025-12-31",
  due_date: "2026-02-28",
  snapshot_hash:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  source_version: "generate_bas_worksheet:v2",
  created_at: "2026-01-02T03:04:05.000Z",
  worksheet: {
    gst: {
      G1: 110000,
      G2: 0,
      G3: 0,
      G10: 0,
      G11: 33000,
      "1A": 10000,
      "1B": 3000,
    },
    payg_withholding: {
      W1: 90000,
      W2: 7000,
      W3: 0,
      W4: 0,
      W5: 7000,
      "4": 7000,
    },
    payg_instalment: null,
    summary: { "9_net_amount_cents": 14000 },
  },
  source_drilldown: { sales: { rows: [] }, purchases: { rows: [] } },
};

Deno.test("ato-lodge build_bas_as4_draft returns a non-sendable draft payload", async () => {
  const res = await handleAtoLodge(
    request({
      action: "build_bas_as4_draft",
      snapshot: SNAPSHOT,
      taxpayer: { role: "taxpayer", abn: "12 345 678 901" },
      created_at: "2026-01-03T00:00:00.000Z",
    }),
    env({}),
  );
  const body = await res.json();

  assertEquals(res.status, 200);
  assertEquals(body.ok, true);
  assertEquals(body.operation, "build_bas_as4_draft");
  assertEquals(body.lodgement_enabled, false);
  assertEquals(body.draft.status, "draft");
  assertEquals(body.draft.payload.send_enabled, false);
  assertEquals(body.transport_gate.allowed, false);
});

Deno.test("ato-lodge send-like requests fail closed through the lodge gate", async () => {
  const res = await handleAtoLodge(request({ action: "smoke" }), env({}));
  const body = await res.json();

  assertEquals(res.status, 403);
  assertEquals(body.error, "FORBIDDEN");
  assertEquals(body.blocked_action, "sbr_as4_bas_lodgement_send");
  assertStringIncludes(body.block_reason, "Lodge blocked");
});

Deno.test("ato-lodge rejects malformed BAS snapshot input", async () => {
  const res = await handleAtoLodge(
    request({
      action: "build_bas_as4_draft",
      snapshot: { ...SNAPSHOT, snapshot_hash: "not-a-sha" },
      taxpayer: { role: "taxpayer", abn: "12 345 678 901" },
    }),
    env({}),
  );
  const body = await res.json();

  assertEquals(res.status, 400);
  assertEquals(body.ok, false);
  assertStringIncludes(body.error, "snapshot.snapshot_hash");
});
