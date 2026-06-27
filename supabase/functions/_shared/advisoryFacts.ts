export interface QueryResult<T> {
  data: T | null;
  error: { message: string } | null;
}

export interface AdvisoryFactsQuery extends PromiseLike<QueryResult<unknown>> {
  select(columns: string): AdvisoryFactsQuery;
  eq(column: string, value: unknown): AdvisoryFactsQuery;
  order(column: string, options?: { ascending?: boolean }): AdvisoryFactsQuery;
  limit(count: number): AdvisoryFactsQuery;
  maybeSingle(): Promise<QueryResult<unknown>>;
}

export interface AdvisoryFactsClient {
  from(relation: string): AdvisoryFactsQuery;
}

export type WagesVsDrawingsSignal = 'wages_recorded' | 'no_wages_recorded' | 'unknown';

export interface AdvisoryFacts {
  organization_id: string;
  profile: {
    entity_type: string | null;
    turnover_bracket: string | null;
    estimated_annual_turnover_cents: number | null;
    is_gst_registered: boolean | null;
    employees_count: number | null;
    live_employees_count: number | null;
    subbies_count: number | null;
    vehicle_count: number | null;
    primary_vehicle_business_use_pct: number | null;
    has_logbook: boolean | null;
    live_active_jobs_count: number | null;
  };
  financials: {
    revenue_inc_gst_cents: number | null;
    revenue_ex_gst_cents: number | null;
    total_cost_cents: number | null;
    cost_bills_cents: number | null;
    cost_wages_cents: number | null;
    cost_overhead_cents: number | null;
    gross_profit_cents: number | null;
    gst_set_aside_cents: number | null;
    tax_set_aside_cents: number | null;
    really_yours_cents: number | null;
  };
  latest_bas: {
    fy_start_year: number | null;
    quarter_num: number | null;
    quarter_start: string | null;
    quarter_end: string | null;
    due_date: string | null;
    gst_collected_cents: number | null;
    gst_paid_cents: number | null;
    net_gst_cents: number | null;
  } | null;
  signals: {
    wages_vs_drawings: WagesVsDrawingsSignal;
    has_vehicle_profile: boolean;
    vehicle_without_logbook: boolean;
    active_jobs_present: boolean;
    active_asset_review_possible: boolean;
  };
  source_errors: string[];
}

type Row = Record<string, unknown>;

function row(value: unknown): Row | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  return value as Row;
}

function firstRow(value: unknown): Row | null {
  if (Array.isArray(value)) return row(value[0]);
  return row(value);
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function errorMessage(source: string, result: QueryResult<unknown>): string | null {
  return result.error ? `${source}: ${result.error.message}` : null;
}

function wagesSignal(costWagesCents: number | null): WagesVsDrawingsSignal {
  if (costWagesCents == null) return 'unknown';
  return costWagesCents > 0 ? 'wages_recorded' : 'no_wages_recorded';
}

export async function loadAdvisoryFacts(
  client: AdvisoryFactsClient,
  orgId: string,
): Promise<AdvisoryFacts> {
  const [profileR, pnlR, basR] = await Promise.all([
    client.from('v_business_context').select('*').eq('organization_id', orgId).maybeSingle(),
    client
      .from('v_organization_realtime_pnl')
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle(),
    client
      .from('v_bas_quarterly')
      .select('*')
      .eq('organization_id', orgId)
      .order('fy_start_year', { ascending: false })
      .order('quarter_num', { ascending: false })
      .limit(1),
  ]);

  const profile = row(profileR.data);
  const pnl = row(pnlR.data);
  const bas = firstRow(basR.data);
  const costWagesCents = numberOrNull(pnl?.['cost_wages_cents']);
  const vehicleCount = numberOrNull(profile?.['vehicle_count']);
  const hasLogbook = booleanOrNull(profile?.['has_logbook']);
  const activeJobs = numberOrNull(profile?.['live_active_jobs_count']);
  const grossProfit = numberOrNull(pnl?.['gross_profit_cents']);
  const sourceErrors = [
    errorMessage('v_business_context', profileR),
    errorMessage('v_organization_realtime_pnl', pnlR),
    errorMessage('v_bas_quarterly', basR),
  ].filter((message): message is string => message !== null);

  return {
    organization_id: orgId,
    profile: {
      entity_type: stringOrNull(profile?.['entity_type']),
      turnover_bracket: stringOrNull(profile?.['aggregated_turnover_bracket']),
      estimated_annual_turnover_cents: numberOrNull(profile?.['estimated_annual_turnover_cents']),
      is_gst_registered: booleanOrNull(profile?.['is_gst_registered']),
      employees_count: numberOrNull(profile?.['employees_count']),
      live_employees_count: numberOrNull(profile?.['live_employees_count']),
      subbies_count: numberOrNull(profile?.['subbies_count']),
      vehicle_count: vehicleCount,
      primary_vehicle_business_use_pct: numberOrNull(profile?.['primary_vehicle_business_use_pct']),
      has_logbook: hasLogbook,
      live_active_jobs_count: activeJobs,
    },
    financials: {
      revenue_inc_gst_cents: numberOrNull(pnl?.['revenue_inc_gst_cents']),
      revenue_ex_gst_cents: numberOrNull(pnl?.['revenue_ex_gst_cents']),
      total_cost_cents: numberOrNull(pnl?.['total_cost_cents']),
      cost_bills_cents: numberOrNull(pnl?.['cost_bills_cents']),
      cost_wages_cents: costWagesCents,
      cost_overhead_cents: numberOrNull(pnl?.['cost_overhead_cents']),
      gross_profit_cents: grossProfit,
      gst_set_aside_cents: numberOrNull(pnl?.['gst_set_aside_cents']),
      tax_set_aside_cents: numberOrNull(pnl?.['tax_set_aside_cents']),
      really_yours_cents: numberOrNull(pnl?.['really_yours_cents']),
    },
    latest_bas: bas
      ? {
          fy_start_year: numberOrNull(bas['fy_start_year']),
          quarter_num: numberOrNull(bas['quarter_num']),
          quarter_start: stringOrNull(bas['quarter_start']),
          quarter_end: stringOrNull(bas['quarter_end']),
          due_date: stringOrNull(bas['due_date']),
          gst_collected_cents: numberOrNull(bas['gst_collected_cents']),
          gst_paid_cents: numberOrNull(bas['gst_paid_cents']),
          net_gst_cents: numberOrNull(bas['net_gst_cents'] ?? bas['net_gst_owed_cents']),
        }
      : null,
    signals: {
      wages_vs_drawings: wagesSignal(costWagesCents),
      has_vehicle_profile: (vehicleCount ?? 0) > 0,
      vehicle_without_logbook: (vehicleCount ?? 0) > 0 && hasLogbook === false,
      active_jobs_present: (activeJobs ?? 0) > 0,
      active_asset_review_possible: (activeJobs ?? 0) > 0 || (grossProfit ?? 0) > 0,
    },
    source_errors: sourceErrors,
  };
}
