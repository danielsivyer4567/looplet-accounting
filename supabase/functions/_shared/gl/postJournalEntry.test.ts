import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type PostJournalEntryDeps, postJournalEntry } from "./postJournalEntry.ts";
import type { GlAdminClient, GlQuery, QueryResult } from "./client.ts";

interface Row {
  table: string;
  op: "insert" | "delete";
  payload?: unknown;
}

class StubQuery implements PromiseLike<QueryResult<unknown>> {
  private op: "insert" | "delete" | null = null;
  private eqId: string | null = null;

  constructor(
    private readonly table: string,
    private readonly log: Row[],
    private readonly opts: { insertedId: string; insertError?: string; linesError?: string; deleted: string[] },
  ) {}

  select(_columns: string): StubQuery {
    return this;
  }
  eq(_column: string, value: unknown): StubQuery {
    this.eqId = String(value);
    return this;
  }
  is(_column: string, _value: unknown): StubQuery {
    return this;
  }
  insert(payload: unknown): StubQuery {
    this.op = "insert";
    this.log.push({ table: this.table, op: "insert", payload });
    return this;
  }
  delete(): StubQuery {
    this.op = "delete";
    return this;
  }
  single(): PromiseLike<QueryResult<unknown>> {
    return this.then();
  }
  maybeSingle(): PromiseLike<QueryResult<unknown>> {
    return this.then();
  }
  then<TResult1 = QueryResult<unknown>, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<unknown>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    let result: QueryResult<unknown>;
    if (this.op === "insert" && this.table === "journal_entries") {
      result = this.opts.insertError
        ? { data: null, error: { message: this.opts.insertError } }
        : { data: { id: this.opts.insertedId }, error: null };
    } else if (this.op === "insert" && this.table === "journal_lines") {
      result = this.opts.linesError ? { data: null, error: { message: this.opts.linesError } } : { data: null, error: null };
    } else if (this.op === "delete") {
      if (this.eqId) this.opts.deleted.push(this.eqId);
      this.log.push({ table: this.table, op: "delete" });
      result = { data: null, error: null };
    } else {
      result = { data: null, error: null };
    }
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}

function stubAdmin(opts: { insertedId: string; insertError?: string; linesError?: string }) {
  const log: Row[] = [];
  const deleted: string[] = [];
  const admin: GlAdminClient = {
    from<T>(table: string) {
      return new StubQuery(table, log, { ...opts, deleted }) as unknown as GlQuery<T>;
    },
  };
  return { admin, log, deleted };
}

const baseParams = {
  organizationId: "org-1",
  lines: [
    { account_id: "acct-expense", debit_cents: 1000, credit_cents: 0, description: "x" },
    { account_id: "acct-bank", debit_cents: 0, credit_cents: 1000, description: "x" },
  ],
};

Deno.test("postJournalEntry posts via the injected postRpc seam and returns the entry id", async () => {
  const { admin } = stubAdmin({ insertedId: "entry-1" });
  const calls: unknown[] = [];
  const deps: PostJournalEntryDeps = {
    admin,
    supabaseUrl: "https://x.supabase.co",
    anonKey: "anon",
    connectorJwtSecret: "secret",
    postRpc: (orgId, entryId) => {
      calls.push([orgId, entryId]);
      return Promise.resolve({ error: null });
    },
  };
  const result = await postJournalEntry(deps, baseParams);
  assertEquals(result, { posted: true, journalEntryId: "entry-1", reason: null });
  assertEquals(calls, [["org-1", "entry-1"]]);
});

Deno.test("postJournalEntry rejects an empty line set without touching the DB", async () => {
  const { admin, log } = stubAdmin({ insertedId: "entry-1" });
  const deps: PostJournalEntryDeps = {
    admin,
    supabaseUrl: "https://x.supabase.co",
    anonKey: "anon",
    connectorJwtSecret: "secret",
    postRpc: () => Promise.resolve({ error: null }),
  };
  const result = await postJournalEntry(deps, { ...baseParams, lines: [] });
  assertEquals(result.posted, false);
  assertEquals(result.reason, "no journal lines supplied");
  assertEquals(log.length, 0);
});

Deno.test("postJournalEntry deletes the draft entry and fails when post_journal_entry rejects", async () => {
  const { admin, deleted } = stubAdmin({ insertedId: "entry-2" });
  const deps: PostJournalEntryDeps = {
    admin,
    supabaseUrl: "https://x.supabase.co",
    anonKey: "anon",
    connectorJwtSecret: "secret",
    postRpc: () => Promise.resolve({ error: { message: "debits != credits" } }),
  };
  const result = await postJournalEntry(deps, baseParams);
  assertEquals(result.posted, false);
  assertEquals(result.journalEntryId, null);
  assertEquals(result.reason, "post_journal_entry: debits != credits");
  assertEquals(deleted, ["entry-2"]);
});

Deno.test("postJournalEntry fails closed (no post attempt) when CONNECTOR_JWT_SECRET is unset and no postRpc override is given", async () => {
  const { admin, deleted } = stubAdmin({ insertedId: "entry-3" });
  const deps: PostJournalEntryDeps = {
    admin,
    supabaseUrl: "https://x.supabase.co",
    anonKey: "anon",
    connectorJwtSecret: undefined,
  };
  const result = await postJournalEntry(deps, baseParams);
  assertEquals(result.posted, false);
  assertEquals(result.reason, "CONNECTOR_JWT_SECRET unset; cannot post");
  assertEquals(deleted, ["entry-3"]);
});

Deno.test("postJournalEntry cleans up the draft when the lines insert fails", async () => {
  const { admin, deleted } = stubAdmin({ insertedId: "entry-4", linesError: "constraint violation" });
  const deps: PostJournalEntryDeps = {
    admin,
    supabaseUrl: "https://x.supabase.co",
    anonKey: "anon",
    connectorJwtSecret: "secret",
    postRpc: () => Promise.resolve({ error: null }),
  };
  const result = await postJournalEntry(deps, baseParams);
  assertEquals(result.posted, false);
  assertEquals(result.reason, "create lines: constraint violation");
  assertEquals(deleted, ["entry-4"]);
});
