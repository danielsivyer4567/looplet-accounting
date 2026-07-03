interface MaybeSingleResult {
  data: unknown;
  error: { message?: string } | null;
}

interface GmailBillSelectBuilder {
  select(columns: string): GmailBillQuery;
}

interface GmailBillQuery {
  eq(column: string, value: unknown): GmailBillQuery;
  filter(column: string, operator: string, value: unknown): GmailBillQuery;
  limit(count: number): GmailBillQuery;
  maybeSingle(): PromiseLike<MaybeSingleResult>;
}

interface GmailBillAdmin {
  from(table: string): GmailBillSelectBuilder;
}

interface GmailBillListQuery extends PromiseLike<{ data: unknown; error: { message?: string } | null }> {
  eq(column: string, value: unknown): GmailBillListQuery;
  filter(column: string, operator: string, value: unknown): GmailBillListQuery;
}
interface GmailBillListSelectBuilder {
  select(columns: string): GmailBillListQuery;
}
interface GmailBillListAdmin {
  from(table: string): GmailBillListSelectBuilder;
}

export async function hasExistingGmailBill(
  admin: unknown,
  organizationId: string,
  messageId: string,
): Promise<boolean> {
  const client = admin as GmailBillAdmin;
  const { data, error } = await client
    .from('bills')
    .select('id')
    .eq('organization_id', organizationId)
    .filter('intake_metadata->>gmail_message_id', 'eq', messageId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`gmail duplicate check failed: ${error.message ?? 'unknown error'}`);
  }

  return Boolean(data);
}

/**
 * Per-attachment dedup support. Returns which attachment ids already have a bill for
 * this gmail message, plus whether ANY bill exists. This lets ingestion re-run only
 * the attachments that failed on a prior partial delivery, instead of skipping the
 * whole message. A message ingested by the legacy per-message path has bills but no
 * recorded attachment ids (empty set + hasAnyBill=true) → caller skips it wholesale.
 */
export async function existingGmailAttachmentIds(
  admin: unknown,
  organizationId: string,
  messageId: string,
): Promise<{ hasAnyBill: boolean; attachmentIds: Set<string> }> {
  const client = admin as GmailBillListAdmin;
  const { data, error } = await client
    .from('bills')
    .select('intake_metadata')
    .eq('organization_id', organizationId)
    .filter('intake_metadata->>gmail_message_id', 'eq', messageId);

  if (error) {
    throw new Error(`gmail duplicate check failed: ${error.message ?? 'unknown error'}`);
  }

  const rows = (data ?? []) as {
    intake_metadata?: { gmail_attachment_id?: string | null } | null;
  }[];
  const attachmentIds = new Set<string>();
  for (const r of rows) {
    const aid = r.intake_metadata?.gmail_attachment_id;
    if (aid) attachmentIds.add(String(aid));
  }
  return { hasAnyBill: rows.length > 0, attachmentIds };
}
