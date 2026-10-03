// Which organisations may use the Redbark bank feed.
//
// Redbark is read with one server key (REDBARK_API_KEY), so every account on it is visible to whoever can list or link
// it. Redbark's terms allow an account holder's own business accounts, not supplying feeds to other businesses, so the
// feed is limited to the organisations named in REDBARK_ORGANIZATION_IDS (comma-separated UUIDs). Unset means none:
// listing, linking, syncing and webhook dispatch all refuse, which fails closed.
// https://redbark.com/docs/help-center/business-and-customer-data

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function feedOrganizationIds(value: string | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const part of (value ?? '').split(',')) {
    const id = part.trim().toLowerCase();
    if (UUID.test(id)) ids.add(id);
  }
  return ids;
}

export function isFeedOrganization(allowed: ReadonlySet<string>, organizationId: string): boolean {
  return allowed.has(organizationId.trim().toLowerCase());
}

export const FEED_NOT_ENABLED = 'Bank feeds are not enabled for this organisation.';
