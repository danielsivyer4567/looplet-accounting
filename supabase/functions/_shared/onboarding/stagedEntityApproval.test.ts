import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  AUTO_APPROVE_MIN_CONFIDENCE,
  approveStagedEntity,
  isSafeStagedAutoApproval,
  matcherForStagedEntity,
  toEntityKind,
} from './stagedEntityApproval.ts';

interface DbResult {
  data: unknown;
  error: { message: string } | null;
}

interface DbOp {
  table: string;
  op: 'insert' | 'update';
  payload: unknown;
}

class FakeQuery implements PromiseLike<DbResult> {
  private op: 'insert' | 'update' | null = null;
  private payload: unknown = null;

  constructor(
    private readonly table: string,
    private readonly db: FakeDb,
  ) {}

  select(): this {
    return this;
  }
  eq(): this {
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  insert(payload: unknown): this {
    this.op = 'insert';
    this.payload = payload;
    this.db.ops.push({ table: this.table, op: 'insert', payload });
    return this;
  }
  update(payload: unknown): this {
    this.op = 'update';
    this.payload = payload;
    this.db.ops.push({ table: this.table, op: 'update', payload });
    return this;
  }
  maybeSingle(): PromiseLike<DbResult> {
    return this.then();
  }
  single(): PromiseLike<DbResult> {
    return this.then();
  }
  then<TResult1 = DbResult, TResult2 = never>(
    onfulfilled?: ((value: DbResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const result = this.result();
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }

  private result(): DbResult {
    if (this.op === 'insert') return { data: { id: `${this.table}-new` }, error: null };
    if (this.op === 'update') return { data: { id: `${this.table}-updated` }, error: null };
    return { data: null, error: null };
  }
}

class FakeDb {
  readonly ops: DbOp[] = [];

  from(table: string): FakeQuery {
    return new FakeQuery(table, this);
  }
}

Deno.test('matcherForStagedEntity builds sender-domain matchers from domain canonical keys', () => {
  assertEquals(matcherForStagedEntity({
    canonical_key: 'domain:bunnings.com.au',
    primary_email: 'receipts@bunnings.com.au',
  }), {
    matcher_type: 'sender_domain',
    matcher_value: 'bunnings.com.au',
  });
});

Deno.test('matcherForStagedEntity falls back to sender address for free-mail canonical keys', () => {
  assertEquals(matcherForStagedEntity({
    canonical_key: 'email:tradie@gmail.com',
    primary_email: null,
  }), {
    matcher_type: 'sender_address',
    matcher_value: 'tradie@gmail.com',
  });
});

Deno.test('toEntityKind accepts only supported staged entity kinds', () => {
  assertEquals(toEntityKind('supplier'), 'supplier');
  assertEquals(toEntityKind('not_real'), null);
});

Deno.test('isSafeStagedAutoApproval permits only high-confidence business classifications', () => {
  assertEquals(isSafeStagedAutoApproval('supplier', 'materials', AUTO_APPROVE_MIN_CONFIDENCE), true);
  assertEquals(isSafeStagedAutoApproval('customer', 'customer_payment', 0.85), true);
  assertEquals(isSafeStagedAutoApproval('supplier', 'materials', 0.83), false);
  assertEquals(isSafeStagedAutoApproval('unknown', 'materials', 0.95), false);
  assertEquals(isSafeStagedAutoApproval('personal', 'personal_expense', 0.95), false);
  assertEquals(isSafeStagedAutoApproval('supplier', 'uncategorized', 0.95), false);
  assertEquals(isSafeStagedAutoApproval('supplier', null, 0.95), false);
});

Deno.test('approveStagedEntity creates supplier, intake rule, and staged-entity resolution links', async () => {
  const db = new FakeDb();

  const result = await approveStagedEntity(
    db as unknown as Parameters<typeof approveStagedEntity>[0],
    {
      id: 'staged-1',
      organization_id: 'org-1',
      canonical_key: 'domain:bunnings.com.au',
      display_name: 'Bunnings',
      primary_email: 'receipts@bunnings.com.au',
      abn: '12345678901',
      predicted_kind: 'supplier',
      predicted_category: 'materials',
      confidence: 0.85,
      first_seen_at: null,
      last_seen_at: null,
    },
    {
      kind: 'supplier',
      category: 'materials',
      confidence: 0.85,
      source: 'test',
    },
  );

  assertEquals(result, {
    supplier_id: 'suppliers-new',
    customer_id: null,
    rule_id: 'intake_rules-new',
  });

  const supplierInsert = db.ops.find((op) => op.table === 'suppliers' && op.op === 'insert');
  assertEquals(supplierInsert?.payload, {
    organization_id: 'org-1',
    name: 'Bunnings',
    email: 'receipts@bunnings.com.au',
    abn: '12345678901',
  });

  const ruleInsert = db.ops.find((op) => op.table === 'intake_rules' && op.op === 'insert');
  assertEquals(ruleInsert?.payload, {
    organization_id: 'org-1',
    matcher_type: 'sender_domain',
    matcher_value: 'bunnings.com.au',
    matcher_priority: 100,
    category_code: 'materials',
    supplier_id: 'suppliers-new',
    customer_id: null,
    is_personal: false,
    notes: 'Auto Setup auto-approved from test - predicted supplier (0.85)',
    skip_ocr: false,
    is_active: true,
  });

  const stagedUpdate = db.ops.find((op) => op.table === 'staged_entities' && op.op === 'update');
  const stagedPayload = stagedUpdate?.payload as Record<string, unknown>;
  assertEquals(stagedPayload.status, 'approved');
  assertEquals(stagedPayload.user_kind, 'supplier');
  assertEquals(stagedPayload.user_category, 'materials');
  assertEquals(stagedPayload.resolved_supplier_id, 'suppliers-new');
  assertEquals(stagedPayload.resolved_rule_id, 'intake_rules-new');
});
