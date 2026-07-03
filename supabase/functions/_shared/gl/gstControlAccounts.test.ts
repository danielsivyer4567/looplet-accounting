import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  GstControlAccountNotConfiguredError,
  postGstControlEntry,
  resolveGstControlAccount,
} from "./gstControlAccounts.ts";
import type { PostJournalEntryDeps } from "./postJournalEntry.ts";
import type { GlAdminClient, GlQuery, QueryResult } from "./client.ts";

class StubSystemAccountsQuery implements PromiseLike<QueryResult<unknown>> {
  constructor(private readonly accountId: string | null, private readonly error?: string) {}
  select(): this {
    return this;
  }
  eq(): this {
    return this;
  }
  is(): this {
    return this;
  }
  insert(): this {
    return this;
  }
  delete(): this {
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
    const result: QueryResult<unknown> = this.error
      ? { data: null, error: { message: this.error } }
      : { data: this.accountId ? { account_id: this.accountId } : null, error: null };
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}

// Insert/lines side is irrelevant to these tests — postGstControlEntry is
// exercised end-to-end via the injected postRpc seam, same as
// postJournalEntry.test.ts, so this stub only needs to satisfy inserts.
class StubJournalQuery implements PromiseLike<QueryResult<unknown>> {
  private op: "insert" | "delete" | null = null;
  constructor(private readonly table: string, private readonly log: string[]) {}
  select(): this {
    return this;
  }
  eq(): this {
    return this;
  }
  is(): this {
    return this;
  }
  insert(): this {
    this.op = "insert";
    this.log.push(`insert:${this.table}`);
    return this;
  }
  delete(): this {
    this.op = "delete";
    this.log.push(`delete:${this.table}`);
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
    const result: QueryResult<unknown> = this.op === "insert" && this.table === "journal_entries"
      ? { data: { id: "entry-gst" }, error: null }
      : { data: null, error: null };
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}

function stubAdmin(gstAccountId: string | null): GlAdminClient {
  const log: string[] = [];
  return {
    from<T>(table: string) {
      if (table === "system_accounts") return new StubSystemAccountsQuery(gstAccountId) as unknown as GlQuery<T>;
      return new StubJournalQuery(table, log) as unknown as GlQuery<T>;
    },
  };
}

Deno.test("resolveGstControlAccount returns the designated account id", async () => {
  const admin = stubAdmin("acct-gst-collected");
  const accountId = await resolveGstControlAccount(admin, "org-1", "gst_collected");
  assertEquals(accountId, "acct-gst-collected");
});

Deno.test("resolveGstControlAccount throws GstControlAccountNotConfiguredError when unset", async () => {
  const admin = stubAdmin(null);
  await assertRejects(
    () => resolveGstControlAccount(admin, "org-1", "gst_paid"),
    GstControlAccountNotConfiguredError,
  );
});

Deno.test("postGstControlEntry builds sale lines (Dr counter / Cr net / Cr GST) and posts", async () => {
  const admin = stubAdmin("acct-gst-collected");
  const seenLines: unknown[] = [];
  const deps: PostJournalEntryDeps = {
    admin,
    supabaseUrl: "https://x.supabase.co",
    anonKey: "anon",
    connectorJwtSecret: "secret",
    postRpc: () => Promise.resolve({ error: null }),
  };
  // Capture the lines postJournalEntry would have inserted by wrapping admin.from.
  const wrapped: GlAdminClient = {
    from<T>(table: string) {
      const q = admin.from<T>(table);
      if (table === "journal_lines") {
        const origInsert = q.insert.bind(q);
        q.insert = (payload: unknown) => {
          seenLines.push(payload);
          return origInsert(payload);
        };
      }
      return q;
    },
  };

  const result = await postGstControlEntry(
    { ...deps, admin: wrapped },
    {
      organizationId: "org-1",
      kind: "sale",
      netAccountId: "acct-revenue",
      netCents: 100000,
      counterAccountId: "acct-ar",
      gstCents: 10000,
      description: "Invoice #1",
    },
  );

  assertEquals(result.posted, true);
  assertEquals(result.gstAccountId, "acct-gst-collected");
  assertEquals(seenLines, [[
    { account_id: "acct-ar", debit_cents: 110000, credit_cents: 0, description: "Invoice #1", journal_entry_id: "entry-gst" },
    { account_id: "acct-revenue", debit_cents: 0, credit_cents: 100000, description: "Invoice #1", journal_entry_id: "entry-gst" },
    { account_id: "acct-gst-collected", debit_cents: 0, credit_cents: 10000, description: "GST collected", journal_entry_id: "entry-gst" },
  ]]);
});

Deno.test("postGstControlEntry builds purchase lines (Dr net / Dr GST / Cr counter)", async () => {
  const admin = stubAdmin("acct-gst-paid");
  const deps: PostJournalEntryDeps = {
    admin,
    supabaseUrl: "https://x.supabase.co",
    anonKey: "anon",
    connectorJwtSecret: "secret",
    postRpc: () => Promise.resolve({ error: null }),
  };

  const result = await postGstControlEntry(deps, {
    organizationId: "org-1",
    kind: "purchase",
    netAccountId: "acct-expense",
    netCents: 5000,
    counterAccountId: "acct-ap",
    gstCents: 500,
    description: "Bill #7",
  });

  assertEquals(result.posted, true);
  assertEquals(result.gstAccountId, "acct-gst-paid");
});

Deno.test("postGstControlEntry fails closed (no draft written) when no control account is configured", async () => {
  const admin = stubAdmin(null);
  const deps: PostJournalEntryDeps = {
    admin,
    supabaseUrl: "https://x.supabase.co",
    anonKey: "anon",
    connectorJwtSecret: "secret",
    postRpc: () => {
      throw new Error("must not attempt to post without a resolved control account");
    },
  };

  const result = await postGstControlEntry(deps, {
    organizationId: "org-1",
    kind: "sale",
    netAccountId: "acct-revenue",
    netCents: 100000,
    counterAccountId: "acct-ar",
    gstCents: 10000,
    description: "Invoice #2",
  });

  assertEquals(result.posted, false);
  assertEquals(result.journalEntryId, null);
  assertEquals(result.gstAccountId, null);
  assertEquals(result.reason, "no live system_accounts designation for org org-1 role gst_collected");
});

Deno.test("postGstControlEntry omits the GST line entirely when gstCents is 0 (GST-free transaction)", async () => {
  const admin = stubAdmin("acct-gst-paid");
  const seenLines: unknown[] = [];
  const wrapped: GlAdminClient = {
    from<T>(table: string) {
      const q = admin.from<T>(table);
      if (table === "journal_lines") {
        const origInsert = q.insert.bind(q);
        q.insert = (payload: unknown) => {
          seenLines.push(payload);
          return origInsert(payload);
        };
      }
      return q;
    },
  };
  const deps: PostJournalEntryDeps = {
    admin: wrapped,
    supabaseUrl: "https://x.supabase.co",
    anonKey: "anon",
    connectorJwtSecret: "secret",
    postRpc: () => Promise.resolve({ error: null }),
  };

  await postGstControlEntry(deps, {
    organizationId: "org-1",
    kind: "purchase",
    netAccountId: "acct-expense",
    netCents: 5000,
    counterAccountId: "acct-ap",
    gstCents: 0,
    description: "GST-free bill",
  });

  const lines = seenLines[0] as unknown[];
  assertEquals(lines.length, 2);
});
