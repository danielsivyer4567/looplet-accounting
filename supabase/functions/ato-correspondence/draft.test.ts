// Tests for the ATO correspondence pure draft builders (SC-7.H.02).
//
// Run: deno test supabase/functions/ato-correspondence/draft.test.ts

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AskBotDraftGrounding,
  type AtoCorrespondenceRow,
  buildAskBotQuestion,
  buildDraftPayload,
  collectEvidenceLinks,
  requireTier2ApprovalForSend,
  sendApprovalPayload,
  type WorkingPapersBundleLike,
} from "./draft.ts";

const notice: AtoCorrespondenceRow = {
  id: "30000000-0000-0000-0000-000000000001",
  organization_id: "10000000-0000-0000-0000-000000000001",
  notice_type: "objection",
  subject: "Notice of amended assessment",
  ato_reference: "ATO-REF-123",
  received_at: "2026-02-01T00:00:00Z",
  due_date: "2026-03-01",
  source_doc_ref: {
    bucket: "bills",
    storage_key: "org-a/ato/amended-assessment.pdf",
    signed_url: "https://signed.example/ato-notice",
    filename: "amended-assessment.pdf",
  },
  details: { issue: "GST input tax credit denied" },
};

const askBot: AskBotDraftGrounding = {
  ok: true,
  route: "hybrid",
  answer:
    "**It depends on evidence.** The draft should identify the creditable acquisition rule and attach the tax invoice and working papers before requesting amendment review.",
  sonar_citations: ["https://www.ato.gov.au/example"],
  data_rows: [{ net_gst_owed_cents: 120000 }],
};

const workingPapers: WorkingPapersBundleLike = {
  source_files: [
    {
      storage_key: "org-a/bills/tax-invoice.pdf",
      signed_url: "https://signed.example/tax-invoice",
      resolved: true,
      original_filename: "tax-invoice.pdf",
      source: "reconciliation:bill",
      source_id: "bill-1",
    },
  ],
  manifest: {
    manifest: {
      audit_log: [
        {
          table_name: "bank_transactions",
          operation: "INSERT",
          record_id: "bt-1",
        },
      ],
    },
  },
};

Deno.test("buildAskBotQuestion includes notice facts and requested outcome", () => {
  const question = buildAskBotQuestion(notice, "Object to denied GST credits");
  assert(question.includes("Notice type: objection."));
  assert(question.includes("ATO reference: ATO-REF-123."));
  assert(question.includes("Requested outcome: Object to denied GST credits."));
});

Deno.test("collectEvidenceLinks gathers notice, working-papers, and legal links", () => {
  const links = collectEvidenceLinks(notice, workingPapers, askBot);
  assertEquals(links.length, 4);
  assert(
    links.some((link) =>
      link.label === "amended-assessment.pdf" && link.resolved
    ),
  );
  assert(
    links.some((link) =>
      link.label === "tax-invoice.pdf" && link.href?.startsWith("https://")
    ),
  );
  assert(links.some((link) => link.type === "audit_log" && !link.resolved));
  assert(links.some((link) => link.type === "legal_citation" && link.resolved));
});

Deno.test("buildDraftPayload creates an objection draft with resolved evidence and signoff warning", () => {
  const evidence = collectEvidenceLinks(notice, workingPapers, askBot);
  const draft = buildDraftPayload(notice, askBot, evidence);

  assertEquals(draft.draft_type, "objection");
  assert(draft.subject.includes("Notice of amended assessment"));
  assert(draft.body.includes("Draft position"));
  assert(draft.body.includes("Registered-agent review required"));
  assert(
    draft.evidence.some((item) =>
      item.resolved && item.href?.startsWith("https://")
    ),
  );
});

Deno.test("sendApprovalPayload binds to exact draft content", () => {
  const payload = sendApprovalPayload({
    id: "draft-1",
    correspondence_id: notice.id,
    subject: "Subject",
    body: "Body",
    evidence: [{ href: "https://signed.example/tax-invoice" }],
  });

  assertEquals(payload.action, "send_ato_correspondence_draft");
  assertEquals(payload.draft_id, "draft-1");
  assertEquals(payload.correspondence_id, notice.id);
  assertEquals(Array.isArray(payload.evidence), true);
});

Deno.test("send refuses without Tier-2 approval", async () => {
  await assertRejects(
    () => Promise.resolve().then(() => requireTier2ApprovalForSend(false)),
    Error,
    "Tier-2 approval required",
  );
  requireTier2ApprovalForSend(true);
});
