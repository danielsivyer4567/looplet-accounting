import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AdvisoryFactsClient,
  type AdvisoryFactsQuery,
  loadAdvisoryFacts,
  type QueryResult,
} from "./advisoryFacts.ts";

interface StubRelation {
  single?: Record<string, unknown> | null;
  rows?: Record<string, unknown>[];
  error?: { message: string } | null;
}

interface RecordedQuery {
  relation: string;
  ops: { name: string; args: unknown[] }[];
}

class StubQuery implements AdvisoryFactsQuery {
  readonly ops: { name: string; args: unknown[] }[] = [];

  constructor(
    private readonly relation: string,
    private readonly source: StubRelation,
    private readonly recorder: RecordedQuery[],
  ) {
    this.recorder.push({ relation, ops: this.ops });
  }

  select(columns: string): AdvisoryFactsQuery {
    this.ops.push({ name: "select", args: [columns] });
    return this;
  }

  eq(column: string, value: unknown): AdvisoryFactsQuery {
    this.ops.push({ name: "eq", args: [column, value] });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): AdvisoryFactsQuery {
    this.ops.push({ name: "order", args: [column, options ?? null] });
    return this;
  }

  limit(count: number): AdvisoryFactsQuery {
    this.ops.push({ name: "limit", args: [count] });
    return this;
  }

  maybeSingle(): Promise<QueryResult<unknown>> {
    return Promise.resolve({
      data: this.source.single ?? null,
      error: this.source.error ?? null,
    });
  }

  then<TResult1 = QueryResult<unknown>, TResult2 = never>(
    onfulfilled?:
      | ((value: QueryResult<unknown>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve({
      data: this.source.rows ?? [],
      error: this.source.error ?? null,
    }).then(onfulfilled, onrejected);
  }
}

function stubClient(relations: Record<string, StubRelation>) {
  const queries: RecordedQuery[] = [];
  const client: AdvisoryFactsClient = {
    from(relation: string) {
      return new StubQuery(relation, relations[relation] ?? {}, queries);
    },
  };
  return { client, queries };
}

Deno.test("loadAdvisoryFacts maps profile, P&L, BAS, and advisory signals", async () => {
  const { client, queries } = stubClient({
    v_business_context: {
      single: {
        entity_type: "company",
        aggregated_turnover_bracket: "under_2m",
        estimated_annual_turnover_cents: "15000000",
        is_gst_registered: true,
        employees_count: 2,
        live_employees_count: 3,
        subbies_count: 4,
        vehicle_count: 1,
        primary_vehicle_business_use_pct: 80,
        has_logbook: false,
        live_active_jobs_count: 5,
      },
    },
    v_organization_realtime_pnl: {
      single: {
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
    },
    v_bas_quarterly: {
      rows: [
        {
          fy_start_year: 2025,
          quarter_num: 4,
          quarter_start: "2026-04-01",
          quarter_end: "2026-06-30",
          due_date: "2026-07-28",
          gst_collected_cents: 1200000,
          gst_paid_cents: 300000,
          net_gst_owed_cents: 900000,
        },
      ],
    },
  });

  const facts = await loadAdvisoryFacts(client, "org-1");

  assertEquals(facts.organization_id, "org-1");
  assertEquals(facts.profile.entity_type, "company");
  assertEquals(facts.profile.turnover_bracket, "under_2m");
  assertEquals(facts.profile.estimated_annual_turnover_cents, 15000000);
  assertEquals(facts.financials.revenue_inc_gst_cents, 22000000);
  assertEquals(facts.financials.gross_profit_cents, 13000000);
  assertEquals(facts.latest_bas?.fy_start_year, 2025);
  assertEquals(facts.latest_bas?.quarter_num, 4);
  assertEquals(facts.latest_bas?.net_gst_cents, 900000);
  assertEquals(facts.signals.wages_vs_drawings, "wages_recorded");
  assertEquals(facts.signals.vehicle_without_logbook, true);
  assertEquals(facts.signals.active_jobs_present, true);
  assertEquals(facts.signals.active_asset_review_possible, true);
  assertEquals(facts.source_errors, []);

  const basQuery = queries.find((q) => q.relation === "v_bas_quarterly");
  assertEquals(
    basQuery?.ops.map((op) => op.name),
    ["select", "eq", "order", "order", "limit"],
  );
  assertEquals(basQuery?.ops[1], {
    name: "eq",
    args: ["organization_id", "org-1"],
  });
  assertEquals(basQuery?.ops[4], { name: "limit", args: [1] });
});

Deno.test(
  "loadAdvisoryFacts keeps missing/error sources explicit instead of fabricating zeros",
  async () => {
    const { client } = stubClient({
      v_business_context: {
        error: { message: "profile view unavailable" },
      },
      v_organization_realtime_pnl: {
        single: null,
      },
      v_bas_quarterly: {
        rows: [],
      },
    });

    const facts = await loadAdvisoryFacts(client, "org-2");

    assertEquals(facts.profile.entity_type, null);
    assertEquals(facts.financials.revenue_inc_gst_cents, null);
    assertEquals(facts.latest_bas, null);
    assertEquals(facts.signals.wages_vs_drawings, "unknown");
    assertEquals(facts.signals.has_vehicle_profile, false);
    assertEquals(facts.source_errors, [
      "v_business_context: profile view unavailable",
    ]);
  },
);
