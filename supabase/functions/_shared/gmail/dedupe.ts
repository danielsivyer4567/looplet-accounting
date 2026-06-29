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
