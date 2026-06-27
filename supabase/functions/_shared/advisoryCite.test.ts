import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { citeForAdvice } from "./advisoryCite.ts";
import type { AdvisoryFacts } from "./advisoryFacts.ts";

const facts: AdvisoryFacts = {
  organization_id: "org-1",
  profile: {
    entity_type: "company",
    turnover_bracket: "under_2m",
    estimated_annual_turnover_cents: 15000000,
    is_gst_registered: true,
    employees_count: 2,
    live_employees_count: 2,
    subbies_count: 1,
    vehicle_count: 1,
    primary_vehicle_business_use_pct: 80,
    has_logbook: false,
    live_active_jobs_count: 3,
  },
  financials: {
    revenue_inc_gst_cents: 22000000,
    revenue_ex_gst_cents: 20000000,
    total_cost_cents: 9000000,
    cost_bills_cents: 5000000,
    cost_wages_cents: 3000000,
    cost_overhead_cents: 1000000,
    gross_profit_cents: 13000000,
    gst_set_aside_cents: 900000,
    tax_set_aside_cents: 3250000,
    really_yours_cents: 8850000,
  },
  latest_bas: {
    fy_start_year: 2025,
    quarter_num: 4,
    quarter_start: "2026-04-01",
    quarter_end: "2026-06-30",
    due_date: "2026-07-28",
    gst_collected_cents: 1200000,
    gst_paid_cents: 300000,
    net_gst_cents: 900000,
  },
  signals: {
    wages_vs_drawings: "wages_recorded",
    has_vehicle_profile: true,
    vehicle_without_logbook: true,
    active_jobs_present: true,
    active_asset_review_possible: true,
  },
  source_errors: [],
};

Deno.test("citeForAdvice fails open when the Sonar key is absent", async () => {
  let called = false;
  const result = await citeForAdvice(
    "Can I claim ute costs?",
    facts,
    "",
    (() => {
      called = true;
      throw new Error("fetch should not run");
    }) as typeof fetch,
  );

  assertEquals(result, { text: "", citations: [] });
  assertEquals(called, false);
});

Deno.test("citeForAdvice extracts Sonar text and top-level citations without network", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await citeForAdvice(
    "Can I claim ute costs?",
    facts,
    "sonar_test_key",
    ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              message: { content: "Vehicle costs may be deductible [1]." },
            }],
            citations: ["https://www.ato.gov.au/example"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch,
  );

  assertEquals(result, {
    text: "Vehicle costs may be deductible [1].",
    citations: ["https://www.ato.gov.au/example"],
  });
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.url, "https://api.perplexity.ai/chat/completions");
  const body = JSON.parse(String(calls[0]?.init?.body));
  assertEquals(body.model, "sonar-pro");
  assertEquals(body.messages[1].content, "Can I claim ute costs?");
});

Deno.test("citeForAdvice also accepts message-level citations and fails open on HTTP errors", async () => {
  const messageLevel = await citeForAdvice(
    "What are BAS due dates?",
    facts,
    "sonar_test_key",
    (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: "Quarterly BAS dates depend on the period [1].",
                citations: ["https://www.ato.gov.au/bas-due-dates"],
              },
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as typeof fetch,
  );

  assertEquals(messageLevel.citations, [
    "https://www.ato.gov.au/bas-due-dates",
  ]);

  const failed = await citeForAdvice(
    "What are BAS due dates?",
    facts,
    "sonar_test_key",
    (() =>
      Promise.resolve(
        new Response("rate limited", { status: 429 }),
      )) as typeof fetch,
  );
  assertEquals(failed, { text: "", citations: [] });
});
