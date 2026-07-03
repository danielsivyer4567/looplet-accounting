// Run: deno test supabase/functions/_shared/sbr/as4-envelope.test.ts

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type BasWorksheetSnapshot,
  buildBasLodgementDraft,
  type SbrParty,
  stableStringify,
} from "./as4-envelope.ts";
import { type EnvReader } from "../ato/config.ts";

function env(values: Record<string, string>): EnvReader {
  return { get: (name: string) => values[name] };
}

const FULL_ENV = {
  ATO_EVTE_ENDPOINT: "https://evte.example.test",
  ATO_DSP_ABN: "12000000000",
  ATO_SOFTWARE_ID: "SW123",
  ATO_STIN: "STIN123",
  ATO_M2M_KEYSTORE_REF: "vault://ato/m2m-test",
  SBR_TAXONOMY_VERSION: "2024.1",
  SBR_TAXONOMY_BASE_URL: "https://cdn.example.test/sbr",
};

const TAXPAYER: SbrParty = {
  role: "taxpayer",
  abn: "12 345 678 901",
  name: "Looplet Test Pty Ltd",
};

const SNAPSHOT: BasWorksheetSnapshot = {
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
    organization_id: "7e0d3a6c-a0c0-44f5-9df2-1165d8c4a053",
    fy_start_year: 2025,
    quarter: 2,
    gst: {
      G1: 110000,
      G2: 0,
      G3: 5500,
      G10: 22000,
      G11: 33000,
      "1A": 10000,
      "1B": 4000,
    },
    payg_withholding: {
      W1: 90000,
      W2: 7000,
      W3: 0,
      W4: 0,
      W5: 7000,
      "4": 7000,
    },
    payg_instalment: {
      T7: 50000,
      "5A": 1200,
      "5B": 200,
      source_status: "provided",
      source_reference: "ATO PAYGI notice",
    },
    summary: {
      "9_net_amount_cents": 14000,
    },
    evidence: {
      label_source: "generate_bas_worksheet:v2",
      snapshot_rpc: "snapshot_bas_worksheet",
    },
  },
  source_drilldown: {
    sales: { rows: [{ invoice_id: "inv-1", labels: ["G1", "1A"] }] },
    purchases: { rows: [{ bill_id: "bill-1", labels: ["G11", "1B"] }] },
  },
};

Deno.test("buildBasLodgementDraft binds BAS labels to the immutable snapshot", async () => {
  const draft = await buildBasLodgementDraft({
    snapshot: SNAPSHOT,
    taxpayer: TAXPAYER,
    created_at: "2026-01-03T00:00:00.000Z",
  }, env({}));

  assertEquals(draft.lodgement_type, "bas");
  assertEquals(draft.status, "draft");
  assertEquals(draft.period_label, "FY2026 Q2 BAS");
  assertEquals(draft.payload_hash.length, 64);
  assertEquals(
    draft.payload.payloads[0].body.period.period_label,
    draft.period_label,
  );
  assertEquals(
    draft.payload.payloads[0].body.evidence.bas_snapshot_id,
    SNAPSHOT.id,
  );
  assertEquals(
    draft.payload.payloads[0].body.evidence.bas_snapshot_hash,
    SNAPSHOT.snapshot_hash,
  );
  assertEquals(draft.payload.payloads[0].body.labels.gst.map((l) => l.code), [
    "G1",
    "G2",
    "G3",
    "G10",
    "G11",
    "1A",
    "1B",
  ]);
  assertEquals(draft.payload.payloads[0].body.labels.net_amount, {
    code: "9",
    amount_cents: 14000,
    source_path: "worksheet.summary.9_net_amount_cents",
  });
});

Deno.test("draft envelope is fail-closed when lodge credentials and SBR taxonomy are absent", async () => {
  const draft = await buildBasLodgementDraft({
    snapshot: SNAPSHOT,
    taxpayer: TAXPAYER,
    created_at: "2026-01-03T00:00:00.000Z",
  }, env({}));
  const serialized = JSON.stringify(draft);

  assertEquals(draft.payload.transport_gate.allowed, false);
  assert(draft.payload.transport_gate.missing.evte?.length);
  assert(draft.payload.transport_gate.missing.dsp?.length);
  assert(draft.payload.transport_gate.missing.sbr?.length);
  assertEquals(draft.payload.send_enabled, false);
  assertStringIncludes(draft.payload.signing.reason, "P2-LODGE-2");
  assert(!serialized.includes("vault://"));
  assert(!serialized.includes("STIN123"));
});

Deno.test("complete deploy config clears the transport gate but still does not enable send", async () => {
  const draft = await buildBasLodgementDraft({
    snapshot: SNAPSHOT,
    taxpayer: TAXPAYER,
    created_at: "2026-01-03T00:00:00.000Z",
  }, env(FULL_ENV));
  const serialized = JSON.stringify(draft);

  assertEquals(draft.payload.transport_gate.allowed, true);
  assertEquals(draft.payload.transport_gate.missing, {});
  assertEquals(draft.payload.ebms.from.dsp_abn, "12000000000");
  assertEquals(draft.payload.ebms.from.software_id, "SW123");
  assertEquals(draft.payload.ebms.agreement_ref.taxonomy_version, "2024.1");
  assertEquals(draft.payload.send_enabled, false);
  assert(!serialized.includes("vault://ato/m2m-test"));
  assert(!serialized.includes("STIN123"));
});

Deno.test("payload hash is stable for the same snapshot, env and timestamp", async () => {
  const first = await buildBasLodgementDraft({
    snapshot: SNAPSHOT,
    taxpayer: TAXPAYER,
    created_at: "2026-01-03T00:00:00.000Z",
  }, env(FULL_ENV));
  const second = await buildBasLodgementDraft({
    snapshot: { ...SNAPSHOT, worksheet: { ...SNAPSHOT.worksheet } },
    taxpayer: TAXPAYER,
    created_at: "2026-01-03T00:00:00.000Z",
  }, env(FULL_ENV));

  assertEquals(first.payload_hash, second.payload_hash);
  assertEquals(
    stableStringify({ b: 1, a: { d: 4, c: 3 } }),
    '{"a":{"c":3,"d":4},"b":1}',
  );
});

Deno.test("missing mandatory BAS labels are rejected before a draft can be queued", async () => {
  const badSnapshot: BasWorksheetSnapshot = {
    ...SNAPSHOT,
    worksheet: {
      ...SNAPSHOT.worksheet,
      gst: {
        G1: 110000,
      },
    },
  };

  await assertRejects(
    () =>
      buildBasLodgementDraft({
        snapshot: badSnapshot,
        taxpayer: TAXPAYER,
        created_at: "2026-01-03T00:00:00.000Z",
      }, env({})),
    Error,
    "worksheet.gst.G2",
  );
});
