// smsf-audit-pack/pack.ts — pure builders for the SMSF audit-pack bundle (SC-5.M.01).
// Split from index.ts so they carry NO side effects (index.ts runs Deno.serve at load): the
// test imports these without booting an HTTP listener. Render text is WinAnsi-safe ASCII
// (hyphens, no em-dashes) per the shared renderer's StandardFonts.Helvetica constraint.

import { type WorksheetDoc } from "../_shared/pdf/worksheet.ts";

/** Cents (any) -> "$1,234.00". */
export function money(cents: unknown): string {
  const n = Number(cents ?? 0);
  return `$${(n / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Base64 a byte array in chunks (spreading a whole PDF into fromCharCode overflows the arg limit). */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** One fund investment as audit evidence (the per-holding detail, not just the asset-class roll). */
export interface InvestmentEvidence {
  name: string;
  asset_class: string | null;
  units: number | null;
  cost_base_cents: number | null;
  market_value_cents: number | null;
  acquisition_date: string | null;
}

// The composed audit-pack bundle: the financials + member + compliance + evidence + reconciliation
// sections an auditor needs for hand-off. Each RPC section is the verbatim payload (single source
// of truth); `investments` is the per-holding evidence; `reconciliations` ties the key totals.
export interface AuditPackBundle {
  organization_id: string;
  fund_id: string;
  fy_start_year: number;
  operating_statement: Record<string, unknown> | null;
  financial_position: Record<string, unknown> | null;
  member_statements: Record<string, unknown> | null;
  contribution_caps: Record<string, unknown> | null;
  pension_drawdown: Record<string, unknown> | null;
  // Investment evidence: the per-holding detail (cost base + market value) backing the SoFP.
  investments: InvestmentEvidence[];
  // Reconciliation ties (computed from the sections above) so the auditor sees the figures agree.
  reconciliations: ReconciliationCheck[];
}

/** One reconciliation tie: two figures that should be equal, plus the resulting match flag. */
export interface ReconciliationCheck {
  label: string;
  left_cents: number;
  right_cents: number;
  difference_cents: number;
  reconciles: boolean;
}

// The required sections — the audit pack is incomplete if any RPC section is missing. The smoke
// test and the bundle's `sections_present` flag both check this list. (investments/reconciliations
// are always-present arrays, so they are not in this null-checkable set.)
export const REQUIRED_SECTIONS: (keyof AuditPackBundle)[] = [
  "operating_statement",
  "financial_position",
  "member_statements",
  "contribution_caps",
  "pension_drawdown",
];

/** Read a top-level cents figure from a (possibly null) RPC section. */
function cents(section: Record<string, unknown> | null, key: string): number {
  return Number(section?.[key] ?? 0);
}

/**
 * Build the reconciliation ties from the fetched sections. These are the agreements an auditor
 * checks first: that the balance sheet balances, that members' funds tie to the member roll, and
 * that the per-holding evidence sums to the reported assets.
 */
export function buildReconciliations(bundle: AuditPackBundle): ReconciliationCheck[] {
  const fp = bundle.financial_position;
  const assets = (fp?.assets ?? {}) as Record<string, unknown>;
  const totalAssets = Number(assets.total_assets_cents ?? 0);
  const liabilities = cents(fp, "liabilities_cents");
  const membersFunds = cents(fp, "members_funds_cents");

  // Members' funds per the member statements (sum of each member's closing balance).
  const members = ((bundle.member_statements?.members ?? []) as Record<string, unknown>[]);
  const membersClosingTotal = members.reduce((sum, m) => sum + Number(m.closing_balance_cents ?? 0), 0);

  // The per-holding evidence should sum to the SoFP's total assets (market value).
  const evidenceTotal = bundle.investments.reduce((sum, i) => sum + Number(i.market_value_cents ?? 0), 0);

  const tie = (label: string, left: number, right: number): ReconciliationCheck => ({
    label,
    left_cents: left,
    right_cents: right,
    difference_cents: left - right,
    reconciles: left === right,
  });

  return [
    tie("Assets less liabilities equals members' funds", totalAssets - liabilities, membersFunds),
    tie("Members' funds (SoFP) equals members' closing balances (statements)", membersFunds, membersClosingTotal),
    tie("Investment evidence (market value) equals total assets (SoFP)", evidenceTotal, totalAssets),
  ];
}

/** Which required sections are present (non-null) in the bundle. */
export function sectionsPresent(bundle: AuditPackBundle): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of REQUIRED_SECTIONS) out[key] = bundle[key] != null;
  return out;
}

/** True when every required section is present. */
export function isComplete(bundle: AuditPackBundle): boolean {
  return REQUIRED_SECTIONS.every((key) => bundle[key] != null);
}

/**
 * Lay the audit pack's face out as a generic worksheet doc for the PDF cover. The full
 * section payloads travel in the JSON bundle; this is a readable summary for the auditor.
 */
export function toAuditPackDoc(bundle: AuditPackBundle): WorksheetDoc {
  const os = bundle.operating_statement ?? {};
  const fp = bundle.financial_position ?? {};
  const assets = (fp.assets ?? {}) as Record<string, unknown>;
  const fy = bundle.fy_start_year;

  const sections: WorksheetDoc["sections"] = [
    {
      heading: "Operating statement",
      caption: "Income, tax, and net result for the year (SC-5.J.01).",
      rows: [
        { label: "Total assessable income", value: money(os.assessable_income_cents) },
        { label: "Income tax", value: money(os.income_tax_cents) },
        { label: "Net result", value: money(os.net_result_cents) },
      ],
    },
    {
      heading: "Statement of financial position",
      caption: "Assets at market value, liabilities, members' funds (SC-5.J.02).",
      rows: [
        { label: "Total assets (market value)", value: money(assets.total_assets_cents) },
        { label: "Liabilities", value: money(fp.liabilities_cents) },
        { label: "Members' funds", value: money(fp.members_funds_cents) },
      ],
    },
  ];

  // One line per member's closing balance (from the member statements section).
  const members = ((bundle.member_statements?.members ?? []) as Record<string, unknown>[]);
  if (members.length > 0) {
    sections.push({
      heading: "Member balances",
      caption: "Closing balance per member (SC-5.J.03).",
      rows: members.map((m) => ({
        label: String(m.name ?? m.member_id ?? "member"),
        value: money(m.closing_balance_cents),
      })),
    });
  }

  // Investment evidence: one line per holding at market value (the SoFP backing detail).
  if (bundle.investments.length > 0) {
    sections.push({
      heading: "Investment evidence",
      caption: "Each holding at market value, with cost base in the JSON bundle (SIS reg 8.02B).",
      rows: bundle.investments.map((i) => ({
        label: `${i.name}${i.asset_class ? ` (${i.asset_class})` : ""}`,
        value: money(i.market_value_cents),
      })),
    });
  }

  // Reconciliation ties: the agreements an auditor checks first.
  if (bundle.reconciliations.length > 0) {
    sections.push({
      heading: "Reconciliations",
      caption: "Key ties an auditor checks; a difference flags a balance that does not agree.",
      rows: bundle.reconciliations.map((r) => ({
        label: `${r.reconciles ? "OK" : "CHECK"} - ${r.label}`,
        value: r.reconciles ? "agrees" : `out by ${money(r.difference_cents)}`,
      })),
    });
  }

  // Compliance flags worth surfacing on the cover (full detail is in the bundle).
  const caps = (bundle.contribution_caps ?? {}) as Record<string, unknown>;
  const capsTotals = (caps.totals ?? {}) as Record<string, unknown>;
  const draw = (bundle.pension_drawdown ?? {}) as Record<string, unknown>;
  const drawTotals = (draw.totals ?? {}) as Record<string, unknown>;
  sections.push({
    heading: "Compliance flags",
    caption: "Cap breaches and under-drawn pensions (SC-5.L) — review before sign-off.",
    rows: [
      { label: "Members over the concessional cap", value: String(capsTotals.members_over_concessional ?? 0) },
      { label: "Members over the non-concessional cap", value: String(capsTotals.members_over_non_concessional ?? 0) },
      { label: "Members subject to Div 293", value: String(capsTotals.members_div293 ?? 0) },
      { label: "Pensions under the minimum drawdown", value: String(drawTotals.under_minimum_count ?? 0) },
    ],
  });

  return {
    title: "SMSF Audit Pack",
    subtitle: `Fund ${bundle.fund_id} - income year ended 30 June ${fy + 1} - DRAFT for auditor hand-off`,
    sections,
    footer:
      "Draft audit pack generated by Looplet Accounting, composing the SMSF financials (operating " +
      "statement, statement of financial position, member statements), the compliance monitors " +
      "(contribution caps, minimum pension drawdown), the per-holding investment evidence, and the " +
      "key reconciliation ties. The audit itself is performed by an independent approved SMSF " +
      "auditor; this is hand-off preparation only and is not an audit opinion or sign-off.",
  };
}
