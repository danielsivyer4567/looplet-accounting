## What

<!-- One-liner: what changes does this PR introduce? -->

## Why

<!-- Link to ADR, roadmap phase, or issue. If neither applies, state the
reason this is needed. -->

## Tenant isolation impact

<!-- Required. Tick exactly one. -->

- [ ] No new business tables, no RLS changes — N/A
- [ ] New table: RLS policy added, follows the canonical preamble pattern
      (`organization_id`, `currency_code`, cents, audit trigger, RLS via
      `get_accessible_org_ids()`)
- [ ] Touches existing RLS policies — explicit reasoning below

## Testing

- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm test` clean
- [ ] If touching financial tables: `npm run test:tenant-isolation` clean
- [ ] Manual smoke test in dev: <!-- describe -->

## Rollback plan

<!-- If this lands and breaks production, what's the path back? -->
