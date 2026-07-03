// E2 — GST/BAS control account posting. See docs/gl-posting-interface.md.
//
// Resolves the org's designated GST control account (system_accounts, 0118)
// and posts a GST-inclusive journal entry through postJournalEntry() (E1).
// This is the first write-side consumer of system_accounts — until now only
// the read-side v_gst_reconciliation view (0119) used it; every posting path
// (coding-classifier's buildLines, for example) still hardcodes a chart-of-
// accounts code for its GST line. This module does NOT change those existing
// callers — it publishes the control-account-aware alternative for lanes to
// adopt when ready.

import type { GlAdminClient } from "./client.ts";
import { postJournalEntry, type PostJournalEntryDeps, type PostJournalEntryResult } from "./postJournalEntry.ts";

export type GstControlRole = "gst_collected" | "gst_paid";

export class GstControlAccountNotConfiguredError extends Error {
  constructor(public readonly organizationId: string, public readonly role: GstControlRole) {
    super(`no live system_accounts designation for org ${organizationId} role ${role}`);
    this.name = "GstControlAccountNotConfiguredError";
  }
}

/**
 * Resolve the org's live (non-deleted) control account for a GST role.
 * Throws GstControlAccountNotConfiguredError if the org hasn't designated one
 * (0118: at most one live row per org+role, none is a valid, expected state
 * for an org that hasn't set up GST control accounts yet).
 */
export async function resolveGstControlAccount(
  admin: GlAdminClient,
  organizationId: string,
  role: GstControlRole,
): Promise<string> {
  const { data, error } = await admin
    .from<{ account_id: string }>("system_accounts")
    .select("account_id")
    .eq("organization_id", organizationId)
    .eq("role", role)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`resolve system account (${role}): ${error.message}`);
  if (!data) throw new GstControlAccountNotConfiguredError(organizationId, role);
  return data.account_id;
}

export type GstEntryKind = "sale" | "purchase";

export interface PostGstControlEntryParams {
  organizationId: string;
  kind: GstEntryKind;
  /** revenue account (sale) or expense account (purchase); amount excl. GST */
  netAccountId: string;
  netCents: number;
  /** AR/bank (sale) or AP/bank (purchase); amount = netCents + gstCents */
  counterAccountId: string;
  gstCents: number;
  description: string;
  memo?: string;
  sourceType?: string;
  sourceId?: string;
  entryDate?: string;
}

export interface PostGstControlEntryResult extends PostJournalEntryResult {
  gstAccountId: string | null;
}

/**
 * Post a GST-inclusive journal entry using the org's designated control
 * account (resolved via resolveGstControlAccount) instead of a hardcoded
 * chart-of-accounts code. Fails the same way postJournalEntry does — no
 * partial/dangling draft rows are left behind on any error path.
 *
 * kind='sale'     → Dr counter (total) / Cr net (net) / Cr GST (gst)   [gst_collected]
 * kind='purchase' → Dr net (net) / Dr GST (gst) / Cr counter (total)  [gst_paid]
 */
export async function postGstControlEntry(
  deps: PostJournalEntryDeps,
  params: PostGstControlEntryParams,
): Promise<PostGstControlEntryResult> {
  const { organizationId, kind, netAccountId, netCents, counterAccountId, gstCents, description } = params;

  if (netCents <= 0) return { posted: false, journalEntryId: null, gstAccountId: null, reason: "netCents must be > 0" };
  if (gstCents < 0) return { posted: false, journalEntryId: null, gstAccountId: null, reason: "gstCents must be >= 0" };

  const role: GstControlRole = kind === "sale" ? "gst_collected" : "gst_paid";
  let gstAccountId: string;
  try {
    gstAccountId = await resolveGstControlAccount(deps.admin, organizationId, role);
  } catch (err) {
    if (err instanceof GstControlAccountNotConfiguredError) {
      return { posted: false, journalEntryId: null, gstAccountId: null, reason: err.message };
    }
    throw err;
  }

  const totalCents = netCents + gstCents;
  const lines = kind === "sale"
    ? [
      { account_id: counterAccountId, debit_cents: totalCents, credit_cents: 0, description },
      { account_id: netAccountId, debit_cents: 0, credit_cents: netCents, description },
      ...(gstCents > 0
        ? [{ account_id: gstAccountId, debit_cents: 0, credit_cents: gstCents, description: "GST collected" }]
        : []),
    ]
    : [
      { account_id: netAccountId, debit_cents: netCents, credit_cents: 0, description },
      ...(gstCents > 0
        ? [{ account_id: gstAccountId, debit_cents: gstCents, credit_cents: 0, description: "GST paid" }]
        : []),
      { account_id: counterAccountId, debit_cents: 0, credit_cents: totalCents, description },
    ];

  const result = await postJournalEntry(deps, {
    organizationId,
    lines,
    memo: params.memo,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    entryDate: params.entryDate,
  });

  return { ...result, gstAccountId };
}
