import type { AdvisoryFacts } from "./advisoryFacts.ts";

const SONAR_URL = "https://api.perplexity.ai/chat/completions";
const SONAR_MODEL = "sonar-pro";

export interface AdviceCitationResult {
  text: string;
  citations: string[];
}

type FetchLike = typeof fetch;

const EMPTY: AdviceCitationResult = { text: "", citations: [] };

function money(cents: number | null): string {
  if (cents == null) return "unknown";
  return `$${
    (cents / 100).toLocaleString("en-AU", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })
  }`;
}

function compactFacts(facts: AdvisoryFacts): string {
  const p = facts.profile;
  const f = facts.financials;
  const bas = facts.latest_bas;
  const lines = [
    `Entity: ${p.entity_type ?? "unknown"}`,
    `Turnover bracket: ${p.turnover_bracket ?? "unknown"}`,
    `Estimated annual turnover: ${money(p.estimated_annual_turnover_cents)}`,
    `GST registered: ${
      p.is_gst_registered == null
        ? "unknown"
        : p.is_gst_registered
        ? "yes"
        : "no"
    }`,
    `Employees: ${p.employees_count ?? p.live_employees_count ?? "unknown"}`,
    `Vehicles: ${p.vehicle_count ?? 0}; logbook: ${
      p.has_logbook == null ? "unknown" : p.has_logbook ? "yes" : "no"
    }`,
    `Revenue inc GST: ${money(f.revenue_inc_gst_cents)}`,
    `Gross profit: ${money(f.gross_profit_cents)}`,
    `Latest BAS: ${
      bas
        ? `FY${bas.fy_start_year ?? "?"} Q${bas.quarter_num ?? "?"}, net GST ${
          money(bas.net_gst_cents)
        }`
        : "unknown"
    }`,
    `Signals: ${JSON.stringify(facts.signals)}`,
  ];
  if (facts.source_errors.length > 0) {
    lines.push(`Unavailable sources: ${facts.source_errors.join("; ")}`);
  }
  return lines.join("\n");
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0
  );
}

function extractCitations(data: Record<string, unknown>): string[] {
  const topLevel = stringArray(data["citations"]);
  if (topLevel.length > 0) return topLevel;

  const choices = data["choices"];
  if (!Array.isArray(choices)) return [];
  const first = choices[0];
  if (!first || typeof first !== "object") return [];
  const message = (first as Record<string, unknown>)["message"];
  if (!message || typeof message !== "object") return [];
  return stringArray((message as Record<string, unknown>)["citations"]);
}

function extractText(data: Record<string, unknown>): string {
  const choices = data["choices"];
  if (!Array.isArray(choices)) return "";
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const message = (first as Record<string, unknown>)["message"];
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>)["content"];
  return typeof content === "string" ? content : "";
}

export async function citeForAdvice(
  question: string,
  facts: AdvisoryFacts,
  sonarKey?: string | null,
  fetchImpl: FetchLike = fetch,
): Promise<AdviceCitationResult> {
  const key = sonarKey?.trim();
  if (!key) return EMPTY;

  try {
    const system =
      `You are an Australian small-business compliance/tax research assistant. Ground the answer in Australian law, ATO guidance, ASIC/business.gov.au/Fair Work sources where relevant, and return web citations. Tailor the research to these business facts:\n\n${
        compactFacts(facts)
      }\n\nRules: Australian sources only; never invent section numbers; keep the result concise; include inline [n] markers where the source supports a claim.`;
    const resp = await fetchImpl(SONAR_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: SONAR_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: question },
        ],
        temperature: 0.1,
        max_tokens: 600,
      }),
    });
    if (!resp.ok) return EMPTY;

    const raw = await resp.json();
    const data = raw && typeof raw === "object"
      ? raw as Record<string, unknown>
      : {};
    return {
      text: extractText(data),
      citations: extractCitations(data),
    };
  } catch {
    return EMPTY;
  }
}
