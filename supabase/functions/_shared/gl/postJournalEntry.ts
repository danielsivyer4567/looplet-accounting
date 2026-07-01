// FROZEN INTERFACE — Lane E (General Ledger). See docs/gl-posting-interface.md.
//
// postJournalEntry() is the ONE sanctioned way to write a balanced journal
// entry through the immutable-journal engine (0071-0075): insert a draft
// journal_entries row, insert its journal_lines, then call the DB's
// post_journal_entry(uuid) RPC through an org-scoped client so
// get_accessible_org_ids() authorises it. On any failure before posting, the
// still-draft entry is deleted (0075 only freezes POSTED rows, so a draft
// delete is always allowed — never attempts to mutate a posted row).
//
// This generalises the pattern every existing caller (coding-classifier,
// depreciation-run, accrue_recurring_bill, close_period) already implements
// inline. Existing callers are NOT changed by this file — this is a new,
// additive entry point for callers that don't have their own copy yet
// (GST/BAS control posting in gstControlAccounts.ts is the first consumer).
//
// Signature and payload shape are FROZEN as of this commit. Extend by adding
// optional fields — do not change existing field names/types/positions.

import type { GlAdminClient } from "./client.ts";
import { createOrgScopedClient, mintOrgToken } from "./orgToken.ts";

export interface JournalLineInput {
  account_id: string;
  debit_cents: number;
  credit_cents: number;
  description: string;
}

export interface PostJournalEntryParams {
  organizationId: string;
  lines: JournalLineInput[];
  memo?: string;
  sourceType?: string;
  sourceId?: string;
  entryDate?: string;
}

export interface PostJournalEntryResult {
  posted: boolean;
  journalEntryId: string | null;
  reason: string | null;
}

export interface PostJournalEntryDeps {
  /** service-role client — bypasses RLS to write the draft entry + lines */
  admin: GlAdminClient;
  supabaseUrl: string;
  anonKey: string;
  /** CONNECTOR_JWT_SECRET — required to mint the org-scoped token post_journal_entry() needs */
  connectorJwtSecret: string | undefined;
  /**
   * Test seam: override the mint-token + org-client + rpc("post_journal_entry")
   * step. Production callers omit this — it defaults to the real flow. Unit
   * tests supply a stub so they never touch djwt/network.
   */
  postRpc?: (organizationId: string, entryId: string) => Promise<{ error: { message: string } | null }>;
}

/**
 * Write and post a balanced journal entry. Validates nothing beyond what the
 * DB already enforces (>=1 line, debits == credits, same-org accounts,
 * active accounts) — post_journal_entry() (0073) is the source of truth for
 * those checks and this function surfaces its rejection reason verbatim.
 */
export async function postJournalEntry(
  deps: PostJournalEntryDeps,
  params: PostJournalEntryParams,
): Promise<PostJournalEntryResult> {
  const { admin, supabaseUrl, anonKey, connectorJwtSecret, postRpc } = deps;
  const { organizationId, lines, memo, sourceType, sourceId, entryDate } = params;

  if (lines.length === 0) {
    return { posted: false, journalEntryId: null, reason: "no journal lines supplied" };
  }

  const entryPayload: Record<string, unknown> = {
    organization_id: organizationId,
    status: "draft",
  };
  if (memo !== undefined) entryPayload.memo = memo;
  if (sourceType !== undefined) entryPayload.source_type = sourceType;
  if (sourceId !== undefined) entryPayload.source_id = sourceId;
  if (entryDate !== undefined) entryPayload.entry_date = entryDate;

  const { data: entry, error: entryErr } = await admin
    .from<{ id: string }>("journal_entries")
    .insert(entryPayload)
    .select("id")
    .single();
  if (entryErr || !entry) {
    return { posted: false, journalEntryId: null, reason: `create entry: ${entryErr?.message ?? "no row"}` };
  }
  const entryId = entry.id;

  const cleanupAndFail = async (reason: string): Promise<PostJournalEntryResult> => {
    await admin.from("journal_entries").delete().eq("id", entryId);
    return { posted: false, journalEntryId: null, reason };
  };

  const { error: linesErr } = await admin
    .from("journal_lines")
    .insert(lines.map((l) => ({ ...l, journal_entry_id: entryId })));
  if (linesErr) return cleanupAndFail(`create lines: ${linesErr.message}`);

  let postErr: { message: string } | null;
  if (postRpc) {
    ({ error: postErr } = await postRpc(organizationId, entryId));
  } else {
    const token = await mintOrgToken(organizationId, connectorJwtSecret);
    if (!token) return cleanupAndFail("CONNECTOR_JWT_SECRET unset; cannot post");
    const orgClient = createOrgScopedClient(supabaseUrl, anonKey, token);
    ({ error: postErr } = await orgClient.rpc("post_journal_entry", { p_entry_id: entryId }));
  }
  if (postErr) return cleanupAndFail(`post_journal_entry: ${postErr.message}`);

  return { posted: true, journalEntryId: entryId, reason: null };
}
