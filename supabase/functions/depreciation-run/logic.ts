// Pure logic for depreciation-run (SC-1.G.02), split out of index.ts so it is
// unit-testable without a Deno.serve/Supabase runtime — mirrors the
// payroll-export-stp/stp.ts split. Auth compare lives in _shared/serviceRole.ts
// (isExactServiceRoleBearer / isExactSecret), not here — that's already the
// shared primitive 10+ other cron-driven functions use.

// depreciation_schedules row with its parent asset embedded (inner-joined so the
// status='active' filter prunes the parent rows; name is only for the memo).
export interface ScheduleRow {
  id: string;
  organization_id: string;
  fixed_asset_id: string;
  fixed_assets: { name: string | null } | { name: string | null }[] | null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Last day of the given UTC month as YYYY-MM-DD. Day 0 of the next month is the
// last day of this one; this is the canonical per-(schedule, month) idempotency key.
export function monthEndISO(year: number, monthIndex0: number): string {
  const d = new Date(Date.UTC(year, monthIndex0 + 1, 0));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// Resolve the target month-end date: the month of an explicit `period`, else the
// PREVIOUS calendar month (post the month that just closed). Throws on a malformed
// period so the caller gets a 400 rather than a silently-wrong posting date.
// `now` defaults to the real clock; tests pass a fixed Date for determinism.
export function resolveTargetDate(period: string | undefined, now: Date = new Date()): string {
  if (period && period.trim() !== "") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(period.trim());
    if (!m) throw new Error(`invalid period (want YYYY-MM-DD): ${period}`);
    const year = Number(m[1]);
    const month = Number(m[2]); // 1-12
    if (month < 1 || month > 12) throw new Error(`invalid period month: ${period}`);
    return monthEndISO(year, month - 1);
  }
  return monthEndISO(now.getUTCFullYear(), now.getUTCMonth() - 1);
}

export function assetName(row: ScheduleRow): string | null {
  const fa = Array.isArray(row.fixed_assets) ? row.fixed_assets[0] : row.fixed_assets;
  return fa?.name ?? null;
}
