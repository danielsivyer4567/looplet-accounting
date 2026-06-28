import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { hasExistingGmailBill } from './dedupe.ts';

class FakeQuery {
  readonly calls: unknown[][];

  constructor(
    calls: unknown[][],
    private readonly result: { data: unknown; error: { message?: string } | null },
  ) {
    this.calls = calls;
  }

  select(columns: string): FakeQuery {
    this.calls.push(['select', columns]);
    return this;
  }

  eq(column: string, value: unknown): FakeQuery {
    this.calls.push(['eq', column, value]);
    return this;
  }

  filter(column: string, operator: string, value: unknown): FakeQuery {
    this.calls.push(['filter', column, operator, value]);
    return this;
  }

  limit(count: number): FakeQuery {
    this.calls.push(['limit', count]);
    return this;
  }

  async maybeSingle(): Promise<{ data: unknown; error: { message?: string } | null }> {
    this.calls.push(['maybeSingle']);
    return this.result;
  }
}

class FakeAdmin {
  readonly calls: unknown[][] = [];

  constructor(private readonly result: { data: unknown; error: { message?: string } | null }) {}

  from(table: string): FakeQuery {
    this.calls.push(['from', table]);
    return new FakeQuery(this.calls, this.result);
  }
}

Deno.test('hasExistingGmailBill queries the per-org gmail message id', async () => {
  const admin = new FakeAdmin({ data: { id: 'bill-1' }, error: null });

  const exists = await hasExistingGmailBill(admin, 'org-1', 'gmail-message-1');

  assertEquals(exists, true);
  assertEquals(admin.calls, [
    ['from', 'bills'],
    ['select', 'id'],
    ['eq', 'organization_id', 'org-1'],
    ['filter', 'intake_metadata->>gmail_message_id', 'eq', 'gmail-message-1'],
    ['limit', 1],
    ['maybeSingle'],
  ]);
});

Deno.test('hasExistingGmailBill returns false when no row exists', async () => {
  const admin = new FakeAdmin({ data: null, error: null });

  assertEquals(await hasExistingGmailBill(admin, 'org-1', 'gmail-message-2'), false);
});

Deno.test('hasExistingGmailBill fails closed when the lookup errors', async () => {
  const admin = new FakeAdmin({ data: null, error: { message: 'permission denied' } });

  await assertRejects(
    () => hasExistingGmailBill(admin, 'org-1', 'gmail-message-3'),
    Error,
    'gmail duplicate check failed: permission denied',
  );
});
