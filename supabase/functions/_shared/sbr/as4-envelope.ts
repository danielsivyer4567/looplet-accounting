// SBR/AS4 draft envelope builder (P2-LODGE-1).
//
// This is deliberately a builder, not a sender. It creates a stable, auditable
// BAS lodgement payload from an immutable BAS worksheet snapshot and wraps it in
// a draft AS4/ebMS3-shaped envelope. Actual XML/XBRL taxonomy validation,
// signing, transport, polling, and correspondence ingest stay behind later
// external-gated slices.

import { readDspConfig } from "../ato/dsp-config.ts";
import { type EnvReader } from "../ato/config.ts";
import { requireLodgeReady } from "../lodge/gate.ts";
import { readSbrTaxonomyConfig } from "./taxonomy-config.ts";

export const BAS_LODGEMENT_MESSAGE_SCHEMA = "looplet.sbr.bas-message.v1";
export const AS4_DRAFT_ENVELOPE_SCHEMA = "looplet.sbr.as4-envelope.draft.v1";
export const AS4_DRAFT_PROFILE = "SBR_AS4_DRAFT_NO_TRANSPORT";
export const BAS_AS4_BLOCKED_ACTION = "sbr_as4_bas_lodgement_send";

const GST_LABELS = ["G1", "G2", "G3", "G10", "G11", "1A", "1B"] as const;
const PAYG_WITHHOLDING_LABELS = ["W1", "W2", "W3", "W4", "W5", "4"] as const;
const PAYG_INSTALMENT_LABELS = ["T7", "5A", "5B"] as const;

type GstLabel = typeof GST_LABELS[number];
type PaygWithholdingLabel = typeof PAYG_WITHHOLDING_LABELS[number];
type PaygInstalmentLabel = typeof PAYG_INSTALMENT_LABELS[number];
export type BasLabelCode =
  | GstLabel
  | PaygWithholdingLabel
  | PaygInstalmentLabel
  | "9";

export interface BasWorksheetSnapshot {
  id: string;
  organization_id: string;
  fy_start_year: number;
  quarter_num: number;
  quarter_start: string;
  quarter_end: string;
  due_date: string;
  worksheet: Record<string, unknown>;
  source_drilldown: Record<string, unknown>;
  snapshot_hash: string;
  source_version: string;
  created_at: string;
}

export interface SbrParty {
  role: "taxpayer" | "agent" | "intermediary";
  abn: string;
  name?: string;
  branch_number?: string;
}

export interface BuildBasAs4EnvelopeInput {
  snapshot: BasWorksheetSnapshot;
  taxpayer: SbrParty;
  agent?: SbrParty;
  declaration?: {
    accepted_at?: string;
    signer_name?: string;
    signer_role?: string;
  };
  message_id?: string;
  conversation_id?: string;
  correlation_id?: string;
  created_at?: string;
}

export interface BasLodgementLabel {
  code: BasLabelCode;
  amount_cents: number;
  source_path: string;
}

export interface BasSbrLodgementMessage {
  schema_version: typeof BAS_LODGEMENT_MESSAGE_SCHEMA;
  lodgement_type: "bas";
  service: {
    agency: "ATO";
    sbr_domain: "ActivityStatements";
    sbr_platform: "ebMS3/AS4";
    form: "BusinessActivityStatement";
  };
  organization_id: string;
  taxpayer: SbrParty;
  agent: SbrParty | null;
  period: {
    fy_start_year: number;
    quarter: number;
    quarter_start: string;
    quarter_end: string;
    due_date: string;
    period_label: string;
  };
  labels: {
    gst: BasLodgementLabel[];
    payg_withholding: BasLodgementLabel[];
    payg_instalment: BasLodgementLabel[] | null;
    net_amount: BasLodgementLabel;
  };
  evidence: {
    bas_snapshot_id: string;
    bas_snapshot_hash: string;
    bas_snapshot_created_at: string;
    source_version: string;
    source_drilldown_hash: string;
  };
  declaration: {
    accepted: boolean;
    accepted_at: string | null;
    signer_name: string | null;
    signer_role: string | null;
    required_before_send: true;
  };
  send_preconditions: string[];
}

export interface As4DraftEnvelope {
  schema_version: typeof AS4_DRAFT_ENVELOPE_SCHEMA;
  profile: typeof AS4_DRAFT_PROFILE;
  message_id: string;
  conversation_id: string;
  correlation_id: string | null;
  created_at: string;
  ebms: {
    protocol: "ebMS3/AS4";
    service: "ATO.ActivityStatements.BusinessActivityStatement";
    action: "Submit";
    from: {
      role: "DigitalServiceProvider";
      dsp_abn: string | null;
      software_id: string | null;
    };
    to: {
      role: "AustralianTaxationOffice";
      party_id: "ATO";
    };
    agreement_ref: {
      taxonomy_version: string | null;
      taxonomy_base_url: string | null;
    };
    properties: { name: string; value: string }[];
  };
  payloads: {
    content_id: "bas-lodgement-message.json";
    content_type: "application/json";
    compression: "none";
    sha256: string;
    body: BasSbrLodgementMessage;
  }[];
  transport_gate: {
    allowed: boolean;
    blocked_action: typeof BAS_AS4_BLOCKED_ACTION;
    block_reason: string | null;
    missing: {
      evte?: string[];
      dsp?: string[];
      sbr?: string[];
    };
  };
  signing: {
    status: "not_signed";
    reason: string;
    required_before_send: true;
  };
  send_enabled: false;
  send_reason: string;
  envelope_hash: string;
}

export interface BasLodgementDraft {
  lodgement_type: "bas";
  period_label: string;
  payload_hash: string;
  payload: As4DraftEnvelope;
  status: "draft";
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function cents(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${path} must be an integer cents value`);
  }
  return value;
}

function normaliseAbn(abn: string, path: string): string {
  const digits = abn.replace(/\D/g, "");
  if (!/^\d{11}$/.test(digits)) {
    throw new Error(`${path} must be an 11-digit ABN`);
  }
  return digits;
}

function normaliseParty(party: SbrParty, path: string): SbrParty {
  return {
    role: party.role,
    abn: normaliseAbn(party.abn, `${path}.abn`),
    ...(party.name && party.name.trim().length > 0
      ? { name: party.name.trim() }
      : {}),
    ...(party.branch_number && party.branch_number.trim().length > 0
      ? { branch_number: party.branch_number.trim() }
      : {}),
  };
}

function assertSnapshot(snapshot: BasWorksheetSnapshot): void {
  nonEmptyString(snapshot.id, "snapshot.id");
  nonEmptyString(snapshot.organization_id, "snapshot.organization_id");
  if (
    !Number.isInteger(snapshot.fy_start_year) || snapshot.fy_start_year < 2000
  ) {
    throw new Error(
      "snapshot.fy_start_year must be a valid financial year start",
    );
  }
  if (
    !Number.isInteger(snapshot.quarter_num) || snapshot.quarter_num < 1 ||
    snapshot.quarter_num > 4
  ) {
    throw new Error("snapshot.quarter_num must be between 1 and 4");
  }
  nonEmptyString(snapshot.quarter_start, "snapshot.quarter_start");
  nonEmptyString(snapshot.quarter_end, "snapshot.quarter_end");
  nonEmptyString(snapshot.due_date, "snapshot.due_date");
  asRecord(snapshot.worksheet, "snapshot.worksheet");
  asRecord(snapshot.source_drilldown, "snapshot.source_drilldown");
  if (!/^[a-f0-9]{64}$/i.test(snapshot.snapshot_hash)) {
    throw new Error("snapshot.snapshot_hash must be a SHA-256 hex digest");
  }
  nonEmptyString(snapshot.source_version, "snapshot.source_version");
  nonEmptyString(snapshot.created_at, "snapshot.created_at");
}

function readLabelGroup(
  worksheet: Record<string, unknown>,
  section: "gst" | "payg_withholding" | "payg_instalment",
): Record<string, unknown> | null {
  const value = worksheet[section];
  if (value === null && section === "payg_instalment") return null;
  return asRecord(value, `worksheet.${section}`);
}

function label(
  group: Record<string, unknown>,
  section: "gst" | "payg_withholding" | "payg_instalment" | "summary",
  code: BasLabelCode,
  valueKey: string = code,
): BasLodgementLabel {
  return {
    code,
    amount_cents: cents(group[valueKey], `worksheet.${section}.${valueKey}`),
    source_path: `worksheet.${section}.${valueKey}`,
  };
}

function periodLabel(snapshot: BasWorksheetSnapshot): string {
  return `FY${snapshot.fy_start_year + 1} Q${snapshot.quarter_num} BAS`;
}

function publicDspEnvelopeConfig(
  env: EnvReader,
): { dsp_abn: string | null; software_id: string | null } {
  const result = readDspConfig(env);
  if (!result.config) return { dsp_abn: null, software_id: null };
  return {
    dsp_abn: result.config.dspAbn,
    software_id: result.config.softwareId,
  };
}

function publicSbrEnvelopeConfig(
  env: EnvReader,
): { taxonomy_version: string | null; taxonomy_base_url: string | null } {
  const result = readSbrTaxonomyConfig(env);
  if (!result.config) {
    return { taxonomy_version: null, taxonomy_base_url: null };
  }
  return {
    taxonomy_version: result.config.taxonomyVersion,
    taxonomy_base_url: result.config.taxonomyBaseUrl,
  };
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${
    Object.keys(obj).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(obj[key])}`
    ).join(",")
  }}`;
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function sha256Uuid(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  const b = bytes.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20, 32)}`;
}

async function defaultMessageId(
  snapshot: BasWorksheetSnapshot,
): Promise<string> {
  const uuid = await sha256Uuid(
    `looplet:sbr-as4:v1:message:${snapshot.organization_id}:${snapshot.id}:${snapshot.snapshot_hash}`,
  );
  return `${uuid}@looplet.local`;
}

async function defaultConversationId(
  snapshot: BasWorksheetSnapshot,
): Promise<string> {
  return await sha256Uuid(
    `looplet:sbr-as4:v1:conversation:${snapshot.organization_id}:bas:${snapshot.fy_start_year}:${snapshot.quarter_num}:${snapshot.snapshot_hash}`,
  );
}

export async function buildBasSbrLodgementMessage(
  input: BuildBasAs4EnvelopeInput,
): Promise<BasSbrLodgementMessage> {
  const { snapshot } = input;
  assertSnapshot(snapshot);

  const worksheet = asRecord(snapshot.worksheet, "snapshot.worksheet");
  const gst = readLabelGroup(worksheet, "gst");
  const paygWithholding = readLabelGroup(worksheet, "payg_withholding");
  const paygInstalment = readLabelGroup(worksheet, "payg_instalment");
  const summary = asRecord(worksheet.summary, "worksheet.summary");
  if (!gst) throw new Error("worksheet.gst must be an object");
  if (!paygWithholding) {
    throw new Error("worksheet.payg_withholding must be an object");
  }

  const declaration = input.declaration ?? {};

  return {
    schema_version: BAS_LODGEMENT_MESSAGE_SCHEMA,
    lodgement_type: "bas",
    service: {
      agency: "ATO",
      sbr_domain: "ActivityStatements",
      sbr_platform: "ebMS3/AS4",
      form: "BusinessActivityStatement",
    },
    organization_id: snapshot.organization_id,
    taxpayer: normaliseParty(input.taxpayer, "taxpayer"),
    agent: input.agent ? normaliseParty(input.agent, "agent") : null,
    period: {
      fy_start_year: snapshot.fy_start_year,
      quarter: snapshot.quarter_num,
      quarter_start: snapshot.quarter_start,
      quarter_end: snapshot.quarter_end,
      due_date: snapshot.due_date,
      period_label: periodLabel(snapshot),
    },
    labels: {
      gst: GST_LABELS.map((code) => label(gst, "gst", code)),
      payg_withholding: PAYG_WITHHOLDING_LABELS.map((code) =>
        label(paygWithholding, "payg_withholding", code)
      ),
      payg_instalment: paygInstalment
        ? PAYG_INSTALMENT_LABELS.map((code) =>
          label(paygInstalment, "payg_instalment", code)
        )
        : null,
      net_amount: label(summary, "summary", "9", "9_net_amount_cents"),
    },
    evidence: {
      bas_snapshot_id: snapshot.id,
      bas_snapshot_hash: snapshot.snapshot_hash.toLowerCase(),
      bas_snapshot_created_at: snapshot.created_at,
      source_version: snapshot.source_version,
      source_drilldown_hash: await sha256Hex(
        stableStringify(snapshot.source_drilldown),
      ),
    },
    declaration: {
      accepted: Boolean(declaration.accepted_at),
      accepted_at: optionalString(declaration.accepted_at),
      signer_name: optionalString(declaration.signer_name),
      signer_role: optionalString(declaration.signer_role),
      required_before_send: true,
    },
    send_preconditions: [
      "ATO DSP accreditation",
      "EVTE certification",
      "SBR taxonomy assets hosted and pinned",
      "digital signing via P2-LODGE-2",
      "Tier-2 lodgement approval and declaration",
      "P2-LODGE-4 orchestration transport gate",
    ],
  };
}

export async function buildBasAs4DraftEnvelope(
  input: BuildBasAs4EnvelopeInput,
  env: EnvReader = Deno.env,
): Promise<As4DraftEnvelope> {
  const snapshot = input.snapshot;
  const createdAt = input.created_at ?? new Date().toISOString();
  const message = await buildBasSbrLodgementMessage(input);
  const messageHash = await sha256Hex(stableStringify(message));
  const block = requireLodgeReady(BAS_AS4_BLOCKED_ACTION, env);
  const dsp = publicDspEnvelopeConfig(env);
  const sbr = publicSbrEnvelopeConfig(env);

  const envelopeWithoutHash: Omit<As4DraftEnvelope, "envelope_hash"> = {
    schema_version: AS4_DRAFT_ENVELOPE_SCHEMA,
    profile: AS4_DRAFT_PROFILE,
    message_id: input.message_id ?? await defaultMessageId(snapshot),
    conversation_id: input.conversation_id ??
      await defaultConversationId(snapshot),
    correlation_id: optionalString(input.correlation_id),
    created_at: createdAt,
    ebms: {
      protocol: "ebMS3/AS4" as const,
      service: "ATO.ActivityStatements.BusinessActivityStatement" as const,
      action: "Submit" as const,
      from: {
        role: "DigitalServiceProvider" as const,
        dsp_abn: dsp.dsp_abn,
        software_id: dsp.software_id,
      },
      to: {
        role: "AustralianTaxationOffice" as const,
        party_id: "ATO" as const,
      },
      agreement_ref: {
        taxonomy_version: sbr.taxonomy_version,
        taxonomy_base_url: sbr.taxonomy_base_url,
      },
      properties: [
        { name: "lodgement_type", value: "bas" },
        { name: "period_label", value: periodLabel(snapshot) },
        { name: "snapshot_hash", value: snapshot.snapshot_hash.toLowerCase() },
      ],
    },
    payloads: [{
      content_id: "bas-lodgement-message.json" as const,
      content_type: "application/json",
      compression: "none",
      sha256: messageHash,
      body: message,
    }],
    transport_gate: {
      allowed: block === null,
      blocked_action: BAS_AS4_BLOCKED_ACTION,
      block_reason: block?.block_reason ?? null,
      missing: block?.missing ?? {},
    },
    signing: {
      status: "not_signed" as const,
      reason: "Digital signing is external-gated and belongs to P2-LODGE-2.",
      required_before_send: true as const,
    },
    send_enabled: false as const,
    send_reason:
      "P2-LODGE-1 creates a draft message/envelope only; no ATO transport is implemented.",
  };

  return {
    ...envelopeWithoutHash,
    envelope_hash: await sha256Hex(stableStringify(envelopeWithoutHash)),
  };
}

export async function buildBasLodgementDraft(
  input: BuildBasAs4EnvelopeInput,
  env: EnvReader = Deno.env,
): Promise<BasLodgementDraft> {
  const envelope = await buildBasAs4DraftEnvelope(input, env);
  return {
    lodgement_type: "bas",
    period_label: envelope.payloads[0].body.period.period_label,
    payload_hash: envelope.envelope_hash,
    payload: envelope,
    status: "draft",
  };
}
