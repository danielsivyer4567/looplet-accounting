// bas-lodgement-pack/pack.ts - pure BAS lodgement pack builders.
//
// Produces a review bundle and PDF document from the immutable lodgements.payload
// JSON. No network, DB, auth, ATO, or storage side effects live here, so the
// pack can be tested in Deno before the edge handler is deployed.

import { type WorksheetDoc } from "../_shared/pdf/worksheet.ts";

export interface BasLodgementRow {
  id: string;
  organization_id: string;
  lodgement_type: string;
  period_label: string;
  payload_hash: string;
  payload: Record<string, unknown>;
  ato_receipt_id: string | null;
  status: string;
  submitted_at: string | null;
  response: Record<string, unknown>;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface BasLodgementBundle {
  lodgement_id: string;
  organization_id: string;
  lodgement_type: string;
  period_label: string;
  status: string;
  payload_hash: string;
  generated_at: string;
  payload: Record<string, unknown>;
  response: Record<string, unknown>;
  checks: {
    is_bas_lodgement: boolean;
    has_payload_hash: boolean;
    has_required_bas_totals: boolean;
    ato_transmission_included: false;
    human_declaration_required: true;
  };
  complete: boolean;
}

const MAX_PDF_TEXT = 120;

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasNumber(obj: Record<string, unknown>, key: string): boolean {
  return typeof obj[key] === "number" && Number.isFinite(obj[key]);
}

function money(cents: unknown): string {
  const n = Number(cents ?? 0);
  return `$${
    (n / 100).toLocaleString("en-AU", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }`;
}

function pdfText(value: unknown): string {
  return String(value ?? "")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, MAX_PDF_TEXT);
}

function upper(value: unknown): string {
  return pdfText(value).toUpperCase();
}

export function requiredBasTotalsPresent(payload: Record<string, unknown>): boolean {
  const gst = record(payload.gst);
  const summary = record(payload.summary);
  return (
    hasNumber(gst, "G1") &&
    hasNumber(gst, "G10") &&
    hasNumber(gst, "G11") &&
    hasNumber(gst, "1A") &&
    hasNumber(gst, "1B") &&
    hasNumber(summary, "9_net_amount_cents")
  );
}

export function buildBasLodgementBundle(
  row: BasLodgementRow,
  generatedAt: string,
): BasLodgementBundle {
  const hasPayloadHash = row.payload_hash.trim().length > 0;
  const hasRequiredBasTotals = requiredBasTotalsPresent(row.payload);
  const isBasLodgement = row.lodgement_type === "bas";

  return {
    lodgement_id: row.id,
    organization_id: row.organization_id,
    lodgement_type: row.lodgement_type,
    period_label: row.period_label,
    status: row.status,
    payload_hash: row.payload_hash,
    generated_at: generatedAt,
    payload: row.payload,
    response: row.response,
    checks: {
      is_bas_lodgement: isBasLodgement,
      has_payload_hash: hasPayloadHash,
      has_required_bas_totals: hasRequiredBasTotals,
      ato_transmission_included: false,
      human_declaration_required: true,
    },
    complete: isBasLodgement && hasPayloadHash && hasRequiredBasTotals,
  };
}

export function toBasLodgementWorksheetDoc(
  row: BasLodgementRow,
  bundle: BasLodgementBundle,
): WorksheetDoc {
  const payload = row.payload;
  const gst = record(payload.gst);
  const payg = record(payload.payg_withholding);
  const instalment = record(payload.payg_instalment);
  const summary = record(payload.summary);
  const hasInstalment = Object.keys(instalment).length > 0;
  const quarterStart = pdfText(payload.quarter_start);
  const quarterEnd = pdfText(payload.quarter_end);
  const dueDate = pdfText(payload.due_date);
  const period = quarterStart && quarterEnd
    ? `${quarterStart} to ${quarterEnd}`
    : row.period_label;
  const due = dueDate ? `, due ${dueDate}` : "";

  const sections: WorksheetDoc["sections"] = [
    {
      heading: "Lodgement identity",
      caption: "Immutable draft ledger row. This pack does not transmit to the ATO.",
      rows: [
        { label: "Lodgement id", value: pdfText(row.id) },
        { label: "Organization id", value: pdfText(row.organization_id) },
        { label: "Status", value: upper(row.status) },
        { label: "Payload hash", value: pdfText(row.payload_hash) },
        { label: "Generated at", value: pdfText(bundle.generated_at) },
      ],
    },
    {
      heading: "GST",
      caption: "From the exact BAS worksheet payload stored on the lodgement row.",
      rows: [
        { label: "G1   Total sales (inc GST)", value: money(gst["G1"]) },
        { label: "G10  Capital purchases", value: money(gst["G10"]) },
        { label: "G11  Non-capital purchases (inc GST)", value: money(gst["G11"]) },
        { label: "1A   GST on sales", value: money(gst["1A"]) },
        { label: "1B   GST on purchases", value: money(gst["1B"]) },
      ],
    },
    {
      heading: "PAYG withholding",
      rows: [
        { label: "W1   Total salary, wages and payments", value: money(payg["W1"]) },
        { label: "W2   Amounts withheld from W1", value: money(payg["W2"]) },
        { label: "W4   Amounts withheld (no ABN)", value: money(payg["W4"]) },
        { label: "W5   Total amounts withheld", value: money(payg["W5"]) },
        { label: "4    PAYG tax withheld", value: money(payg["4"]) },
      ],
    },
  ];

  if (hasInstalment) {
    sections.push({
      heading: "PAYG instalment",
      rows: [
        { label: "T7   PAYG instalment amount", value: money(instalment["T7"]) },
        { label: "5A   PAYG income tax instalment", value: money(instalment["5A"]) },
        { label: "5B   Credit from PAYG instalment variation", value: money(instalment["5B"]) },
      ],
    });
  }

  sections.push(
    {
      heading: "Summary",
      caption: "Net amount = (1A + 4 + 5A) - (1B + 5B). Positive = payable.",
      rows: [
        { label: "9    Net amount", value: money(summary["9_net_amount_cents"]) },
      ],
    },
    {
      heading: "Guardrails",
      rows: [
        { label: "ATO transmission", value: "not included" },
        { label: "Human declaration", value: "required before lodgement" },
        { label: "Pack complete", value: bundle.complete ? "yes" : "no" },
      ],
    },
  );

  return {
    title: "Business Activity Statement - Lodgement Pack",
    subtitle: `${pdfText(row.period_label)} (${period}${due}) - ${
      upper(row.status)
    } - NOT LODGED`,
    sections,
    footer:
      "Draft BAS lodgement pack generated by Looplet Accounting. Review source records, approvals, and declaration before any ATO lodgement.",
  };
}

export function basLodgementFilename(row: BasLodgementRow): string {
  const safePeriod = row.period_label
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "period";
  return `bas-lodgement-pack-${safePeriod}-${row.id.slice(0, 8)}.pdf`;
}
