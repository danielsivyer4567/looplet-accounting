// ato-correspondence/draft.ts - pure draft/evidence builders for SC-7.H.02.
//
// The edge handler owns DB reads, ask-bot invocation, and approval RPC calls.
// This file stays deterministic so the high-liability drafting boundary can be
// tested without live AI, Supabase, or ATO transport.

export interface AtoCorrespondenceRow {
  id: string;
  organization_id: string;
  notice_type: string;
  subject: string | null;
  ato_reference: string | null;
  received_at: string;
  due_date: string | null;
  source_doc_ref: Record<string, unknown>;
  details: Record<string, unknown>;
}

export interface AskBotDraftGrounding {
  ok?: boolean;
  answer?: string;
  route?: string;
  citations?: unknown[];
  sonar_citations?: string[];
  data_rows?: unknown[];
  sql?: string | null;
}

export interface EvidenceLink {
  type: string;
  label: string;
  href: string | null;
  storage_key: string | null;
  source_id: string | null;
  resolved: boolean;
}

export interface WorkingPapersBundleLike {
  source_files?: {
    storage_key?: string | null;
    signed_url?: string | null;
    resolved?: boolean;
    source?: string | null;
    source_id?: string | null;
    original_filename?: string | null;
  }[];
  manifest?: {
    manifest?: {
      audit_log?: unknown[];
    };
  };
}

export interface DraftPayload {
  draft_type:
    | "response"
    | "objection"
    | "review_request"
    | "payment_plan"
    | "note";
  subject: string;
  body: string;
  evidence: EvidenceLink[];
}

export function buildAskBotQuestion(
  notice: AtoCorrespondenceRow,
  requestedOutcome: string | null,
): string {
  const parts = [
    "Draft an Australian tax-agent style response strategy for this ATO correspondence.",
    `Notice type: ${notice.notice_type}.`,
    notice.subject ? `Subject: ${notice.subject}.` : null,
    notice.ato_reference ? `ATO reference: ${notice.ato_reference}.` : null,
    notice.received_at ? `Received at: ${notice.received_at}.` : null,
    notice.due_date ? `Due date: ${notice.due_date}.` : null,
    requestedOutcome ? `Requested outcome: ${requestedOutcome}.` : null,
    "Ground the answer in AU tax/admin law, the organization's books, and the available evidence.",
    "Return a concise draft rationale with citations or clear caveats where the law is not fully established.",
  ];
  return parts.filter(Boolean).join("\n");
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstUrl(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  return /^https?:\/\//i.test(candidate) || /^signed:\/\//i.test(candidate)
    ? candidate
    : null;
}

function remember(map: Map<string, EvidenceLink>, link: EvidenceLink): void {
  const key = link.href ?? link.storage_key ??
    `${link.type}:${link.source_id ?? link.label}`;
  if (!map.has(key)) map.set(key, link);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function collectEvidenceLinks(
  notice: AtoCorrespondenceRow,
  workingPapers: WorkingPapersBundleLike | null,
  askBot: AskBotDraftGrounding | null,
): EvidenceLink[] {
  const links = new Map<string, EvidenceLink>();
  const source = notice.source_doc_ref ?? {};
  const sourceHref = firstUrl(source.signed_url) ?? firstUrl(source.href) ??
    null;
  const sourceStorage = text(source.storage_key);
  if (sourceHref || sourceStorage) {
    remember(links, {
      type: "ato_notice",
      label: text(source.filename) ?? text(source.original_filename) ??
        "ATO source notice",
      href: sourceHref,
      storage_key: sourceStorage,
      source_id: notice.id,
      resolved: sourceHref != null,
    });
  }

  for (const file of workingPapers?.source_files ?? []) {
    const href = firstUrl(file.signed_url);
    const storageKey = text(file.storage_key);
    if (!href && !storageKey) continue;
    remember(links, {
      type: "working_papers_source",
      label: text(file.original_filename) ?? storageKey ??
        "Working-papers source",
      href,
      storage_key: storageKey,
      source_id: text(file.source_id),
      resolved: file.resolved === true && href != null,
    });
  }

  for (const row of workingPapers?.manifest?.manifest?.audit_log ?? []) {
    const record = recordValue(row);
    const tableName = text(record.table_name) ?? "audit_log";
    const operation = text(record.operation) ?? "event";
    const recordId = text(record.record_id);
    remember(links, {
      type: "audit_log",
      label: `${tableName} ${operation}${recordId ? ` ${recordId}` : ""}`,
      href: null,
      storage_key: null,
      source_id: recordId,
      resolved: false,
    });
  }

  for (const url of askBot?.sonar_citations ?? []) {
    const href = firstUrl(url);
    if (!href) continue;
    remember(links, {
      type: "legal_citation",
      label: href,
      href,
      storage_key: null,
      source_id: null,
      resolved: true,
    });
  }

  return [...links.values()];
}

function draftKindForNotice(noticeType: string): DraftPayload["draft_type"] {
  const t = noticeType.toLowerCase();
  if (t.includes("objection")) return "objection";
  if (t.includes("review")) return "review_request";
  if (t.includes("debt") || t.includes("payment")) return "payment_plan";
  if (t.includes("audit") || t.includes("query")) return "response";
  return "response";
}

function evidenceSummary(evidence: EvidenceLink[]): string {
  const resolved = evidence.filter((item) => item.resolved && item.href).length;
  return `${evidence.length} evidence link${
    evidence.length === 1 ? "" : "s"
  } (${resolved} resolved URL${resolved === 1 ? "" : "s"})`;
}

export function buildDraftPayload(
  notice: AtoCorrespondenceRow,
  askBot: AskBotDraftGrounding,
  evidence: EvidenceLink[],
): DraftPayload {
  const subject = `Draft response: ${notice.subject ?? notice.notice_type}`;
  const answer = text(askBot.answer) ??
    "No grounded answer was returned by ask-bot.";
  const referenceLines = [
    notice.ato_reference ? `ATO reference: ${notice.ato_reference}` : null,
    notice.due_date ? `Response due: ${notice.due_date}` : null,
    `Evidence attached: ${evidenceSummary(evidence)}`,
  ].filter(Boolean);

  const body = [
    subject,
    "",
    "Background",
    `We have reviewed the ATO correspondence received on ${notice.received_at}.`,
    ...referenceLines.map((line) => `- ${line}`),
    "",
    "Draft position",
    answer,
    "",
    "Evidence trail",
    ...evidence.map((item) =>
      `- ${item.label} (${item.type}) - ${
        item.resolved ? "resolved" : "needs review"
      }`
    ),
    "",
    "Registered-agent review required",
    "This is a draft only. A registered tax agent must review, approve, and send it through the authorised ATO channel. Looplet has not transmitted this response.",
  ].join("\n");

  return {
    draft_type: draftKindForNotice(notice.notice_type),
    subject,
    body,
    evidence,
  };
}

export function sendApprovalPayload(draft: {
  id: string;
  correspondence_id: string;
  subject: string;
  body: string;
  evidence: unknown;
}): Record<string, unknown> {
  return {
    action: "send_ato_correspondence_draft",
    draft_id: draft.id,
    correspondence_id: draft.correspondence_id,
    subject: draft.subject,
    body: draft.body,
    evidence: draft.evidence,
  };
}

export function requireTier2ApprovalForSend(approved: boolean): void {
  if (!approved) {
    throw new Error(
      "Tier-2 approval required before sending ATO correspondence.",
    );
  }
}
