// working-papers/bundle.ts - pure builders for the working-papers bundle (SC-7.G.02).
//
// The edge handler calls compile_working_papers() and signs source-file links. This
// file keeps the bundle/index-PDF model side-effect free so it can be Deno-tested
// without a Supabase runtime or HTTP listener.

import { type WorksheetDoc } from "../_shared/pdf/worksheet.ts";

export interface SourceFileRef {
  storage_key: string;
  source: string;
  source_id: string | null;
  original_filename: string | null;
}

export interface ResolvedSourceFile extends SourceFileRef {
  resolved: boolean;
  signed_url: string | null;
  expires_in_seconds: number;
  error: string | null;
}

export interface WorkingPapersBundle {
  organization_id: string;
  period_start: string;
  period_end: string;
  generated_at: string;
  manifest: Record<string, unknown>;
  source_files: ResolvedSourceFile[];
  checks: {
    manifest_ok: boolean;
    source_files_resolved: boolean;
    unresolved_source_file_count: number;
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

export function money(cents: unknown): string {
  const n = Number(cents ?? 0);
  return `$${
    (n / 100).toLocaleString("en-AU", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }`;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object") as Record<
      string,
      unknown
    >[]
    : [];
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pdfText(value: unknown): string {
  return String(value ?? "")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, MAX_PDF_TEXT);
}

function boolAt(value: unknown): boolean {
  return value === true;
}

export function collectSourceFileRefs(
  manifestEnvelope: Record<string, unknown>,
): SourceFileRef[] {
  const manifest = objectValue(manifestEnvelope.manifest);
  const refs = new Map<string, SourceFileRef>();

  const remember = (ref: SourceFileRef): void => {
    if (!refs.has(ref.storage_key)) refs.set(ref.storage_key, ref);
  };

  for (const line of arrayValue(manifest.reconciliation_set)) {
    const source = objectValue(line.source_document);
    const storageKey = text(source.storage_key);
    if (storageKey) {
      remember({
        storage_key: storageKey,
        source: `reconciliation:${text(source.type) ?? "source"}`,
        source_id: text(source.id),
        original_filename: text(source.original_filename),
      });
    }
  }

  for (const pkg of arrayValue(manifest.receipt_audit_packages)) {
    const storageKey = text(pkg.storage_key);
    if (storageKey) {
      remember({
        storage_key: storageKey,
        source: "receipt_audit_package",
        source_id: text(pkg.id),
        original_filename: null,
      });
    }
  }

  return [...refs.values()].sort((a, b) =>
    a.storage_key.localeCompare(b.storage_key)
  );
}

export function unresolvedSourceFiles(
  sourceFiles: ResolvedSourceFile[],
): ResolvedSourceFile[] {
  return sourceFiles.filter((file) => !file.resolved || !file.signed_url);
}

export function buildWorkingPapersBundle(
  manifestEnvelope: Record<string, unknown>,
  sourceFiles: ResolvedSourceFile[],
  generatedAt: string,
): WorkingPapersBundle {
  const unresolved = unresolvedSourceFiles(sourceFiles);
  const manifestOk = boolAt(manifestEnvelope.ok);

  return {
    organization_id: String(manifestEnvelope.organization_id ?? ""),
    period_start: String(manifestEnvelope.period_start ?? ""),
    period_end: String(manifestEnvelope.period_end ?? ""),
    generated_at: generatedAt,
    manifest: manifestEnvelope,
    source_files: sourceFiles,
    checks: {
      manifest_ok: manifestOk,
      source_files_resolved: unresolved.length === 0,
      unresolved_source_file_count: unresolved.length,
    },
    complete: manifestOk && unresolved.length === 0,
  };
}

export function toWorkingPapersIndexDoc(
  bundle: WorkingPapersBundle,
): WorksheetDoc {
  const manifest = objectValue(bundle.manifest.manifest);
  const checks = objectValue(bundle.manifest.checks);
  const reconciliationCheck = objectValue(checks.reconciliation_complete);
  const periodCheck = objectValue(checks.period_closed);
  const journalCheck = objectValue(checks.period_journals);
  const schedules = objectValue(manifest.schedules);
  const reconciliationRows = arrayValue(manifest.reconciliation_set);
  const journalRows = arrayValue(manifest.period_journals);
  const trialBalanceRows = arrayValue(schedules.trial_balance);
  const auditLogRows = arrayValue(manifest.audit_log);

  return {
    title: "Working Papers Index",
    subtitle: `${pdfText(bundle.period_start)} to ${
      pdfText(bundle.period_end)
    } - ${bundle.complete ? "COMPLETE" : "INCOMPLETE"} - DRAFT`,
    sections: [
      {
        heading: "Bundle status",
        rows: [
          {
            label: "Manifest complete",
            value: bundle.checks.manifest_ok ? "yes" : "no",
          },
          {
            label: "Source-file links resolved",
            value: bundle.checks.source_files_resolved ? "yes" : "no",
          },
          {
            label: "Unresolved source files",
            value: String(bundle.checks.unresolved_source_file_count),
          },
          { label: "Generated at", value: pdfText(bundle.generated_at) },
        ],
      },
      {
        heading: "Close and reconciliation checks",
        rows: [
          {
            label: "Period closed",
            value: boolAt(periodCheck.passed) ? "yes" : "no",
          },
          {
            label: "Reconciliation complete",
            value: boolAt(reconciliationCheck.passed) ? "yes" : "no",
          },
          {
            label: "Reconciled bank lines",
            value: String(reconciliationCheck.reconciled_count ?? 0),
          },
          {
            label: "Unreconciled bank lines",
            value: String(reconciliationCheck.unreconciled_count ?? 0),
          },
          {
            label: "Period journals",
            value: String(journalCheck.journal_count ?? journalRows.length),
          },
        ],
      },
      {
        heading: "Reconciliation set",
        caption:
          "Every bank line in the period, with the source document when available.",
        rows: reconciliationRows.map((line) => {
          const source = objectValue(line.source_document);
          const sourceLabel = text(source.invoice_number) ??
            text(source.storage_key) ?? text(source.type) ?? "no source";
          return {
            label: `${pdfText(line.posted_at)} ${pdfText(line.description)}`,
            value: `${money(line.amount_cents)} / ${pdfText(sourceLabel)}`,
          };
        }),
      },
      {
        heading: "Period journals",
        rows: journalRows.map((journal) => ({
          label: `${pdfText(journal.entry_date)} ${
            pdfText(journal.memo ?? journal.source_type ?? journal.id)
          }`,
          value: pdfText(journal.status ?? "unknown"),
        })),
      },
      {
        heading: "Trial balance schedule",
        rows: trialBalanceRows.map((row) => ({
          label: `${pdfText(row.account_code)} ${pdfText(row.account_name)}`
            .trim(),
          value: money(row.net_cents),
        })),
      },
      {
        heading: "Source files",
        caption:
          "Private storage links are short-lived signed URLs in the JSON bundle.",
        rows: bundle.source_files.map((file) => ({
          label: pdfText(file.original_filename ?? file.storage_key),
          value: file.resolved
            ? "resolved"
            : `missing: ${pdfText(file.error ?? "unresolved")}`,
        })),
      },
      {
        heading: "Audit-log evidence",
        rows: auditLogRows.map((row) => ({
          label: `${pdfText(row.table_name)} ${pdfText(row.operation)} ${
            pdfText(row.record_id)
          }`,
          value: pdfText(row.occurred_at),
        })),
      },
    ],
    footer:
      "Draft working-papers bundle generated by Looplet Accounting. It indexes the closed-period " +
      "manifest, reconciliation set, schedules, source-file links, and audit-log evidence. Review " +
      "the linked source files before relying on the pack.",
  };
}
