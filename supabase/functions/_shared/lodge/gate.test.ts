// Tests for the fail-closed lodge gate (SC-DEPLOY-04).
//
// Run: deno test supabase/functions/_shared/lodge/gate.test.ts
//
// These assert the gate fails CLOSED: absent credentials/taxonomy must yield a
// FORBIDDEN block with an auditable (but secret-free) reason. The live "returns
// 403 from the deployed function" ride is SC-DEPLOY-01 post-deploy.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { requireLodgeReady, requireSbrReady } from "./gate.ts";

function env(map: Record<string, string>) {
  return { get: (name: string) => map[name] };
}

const FULL_LODGE_ENV = {
  ATO_EVTE_ENDPOINT: "https://evte.example",
  ATO_DSP_ABN: "12345678901",
  ATO_SOFTWARE_ID: "SWID",
  ATO_STIN: "STIN",
  ATO_M2M_KEYSTORE_REF: "vault://keystore",
  SBR_TAXONOMY_VERSION: "2024.1",
  SBR_TAXONOMY_BASE_URL: "https://cdn.example/sbr",
};

Deno.test("requireLodgeReady blocks when all credentials absent", () => {
  const block = requireLodgeReady("ato_correspondence_send", env({}));
  assert(block, "expected a block when nothing is configured");
  assertEquals(block.error, "FORBIDDEN");
  assertEquals(block.blocked_action, "ato_correspondence_send");
  // Surfaces what is missing per gate, for the audit trail.
  assert(block.missing.evte && block.missing.evte.length > 0);
  assert(block.missing.dsp && block.missing.dsp.length > 0);
  assert(block.missing.sbr && block.missing.sbr.length > 0);
  // Never leaks a value — only names.
  assert(!JSON.stringify(block).includes("vault://"));
});

Deno.test("requireLodgeReady blocks when only SBR is missing", () => {
  const partial = { ...FULL_LODGE_ENV } as Record<string, string>;
  delete partial.SBR_TAXONOMY_VERSION;
  delete partial.SBR_TAXONOMY_BASE_URL;
  const block = requireLodgeReady("ato_correspondence_send", env(partial));
  assert(block, "expected a block when SBR is missing");
  assertEquals(block.missing.evte, undefined);
  assertEquals(block.missing.dsp, undefined);
  assert(block.missing.sbr && block.missing.sbr.length === 2);
});

Deno.test("requireLodgeReady passes when all gates green", () => {
  const block = requireLodgeReady("ato_correspondence_send", env(FULL_LODGE_ENV));
  assertEquals(block, null);
});

Deno.test("requireSbrReady blocks when taxonomy unset and no fallback", () => {
  const block = requireSbrReady("working_papers_bundle", env({}));
  assert(block, "expected a block with no taxonomy and no fallback");
  assertEquals(block.error, "FORBIDDEN");
  assertEquals(block.blocked_action, "working_papers_bundle");
  assert(block.missing.sbr && block.missing.sbr.length === 2);
});

Deno.test("requireSbrReady passes with the bundled-subset fallback", () => {
  const block = requireSbrReady(
    "working_papers_bundle",
    env({ SBR_TAXONOMY_FALLBACK_ENABLED: "true" }),
  );
  assertEquals(block, null);
});

Deno.test("requireSbrReady passes with full taxonomy config", () => {
  const block = requireSbrReady(
    "smsf_audit_pack",
    env({
      SBR_TAXONOMY_VERSION: "2024.1",
      SBR_TAXONOMY_BASE_URL: "https://cdn.example/sbr",
    }),
  );
  assertEquals(block, null);
});
