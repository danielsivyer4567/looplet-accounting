// The BAS quarter block Ask AI reads for context. The column list is checked against v_bas_quarterly's definition
// by bas-query.test.ts, because this query twice named columns the view does not expose (net_gst_owed_cents, then
// sales_inc_gst_cents, which exists only inside the view's subquery) and silently returned nothing.
export const BAS_QUARTER_COLUMNS = [
  'fy_start_year',
  'quarter_num',
  'quarter_start',
  'quarter_end',
  'due_date',
  'sales_ex_gst_cents',
  'gst_collected_cents',
  'gst_paid_cents',
  'net_gst_cents',
] as const;

/** The most recent BAS quarter for one organisation. orgId must already be a validated UUID. */
export function basQuarterSql(orgId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error('basQuarterSql: organisation id must be a UUID');
  return `SELECT ${BAS_QUARTER_COLUMNS.join(', ')}
              FROM v_bas_quarterly WHERE organization_id = '${orgId}'
              ORDER BY fy_start_year DESC, quarter_num DESC LIMIT 1`;
}
