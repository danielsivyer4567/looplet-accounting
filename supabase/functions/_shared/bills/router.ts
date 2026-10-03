/**
 * Bill router — decides what happens to a bill after extraction.
 *
 * Three lanes (matches the diagram in docs/ROADMAP.md → "Phase 3 keystone"):
 *
 *   Exact match (score = 1.0) + decent extraction confidence
 *     → AUTO-ATTACH: set bill.job_id, status='attached', fire Xero push.
 *       This is the "magic" the operator sees — born-digital invoices
 *       with clean job refs land in Xero with zero clicks.
 *
 *   Fuzzy match (0.5 ≤ score < 1.0) OR exact match with low extraction confidence
 *     → SUGGEST: store suggested_job_id + score, leave status='verified'.
 *       Surfaces in the Allocation Portal with "did you mean Job X?".
 *
 *   No match (score < 0.5) OR no job_reference extracted at all
 *     → QUEUE: leave at status='verified' with NULL suggestions.
 *       Surfaces in the Allocation Portal for manual job pick.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { billXeroSyncUpdate, pushBillToXero } from '../xero/adapter.ts';
import type { ExtractedBill } from '../ocr/prompt.ts';

const AUTO_ATTACH_SCORE_THRESHOLD = 1.0;
const SUGGEST_SCORE_THRESHOLD = 0.5;

interface RouterArgs {
  admin: SupabaseClient;
  billId: string;
  organizationId: string;
  jobReferenceRaw: string | null;
  extractedConfidence: ExtractedBill['confidence'];
}

export interface RouterResult {
  outcome: 'auto_attached' | 'suggested' | 'queued';
  matched_job_id?: string;
  matched_job_number?: string;
  match_score?: number;
  /** `synced` only with an id Xero returned; `not_connected` sent nothing. */
  xero_status?: 'synced' | 'not_connected';
  xero_invoice_id?: string;
}

export async function routeBill(args: RouterArgs): Promise<RouterResult> {
  // No job ref → straight to queue
  if (!args.jobReferenceRaw || args.jobReferenceRaw.trim().length === 0) {
    return { outcome: 'queued' };
  }

  // Score every candidate via the SQL function
  const { data: matches, error } = await args.admin.rpc('match_job_for_bill', {
    p_org_id: args.organizationId,
    p_job_ref: args.jobReferenceRaw,
  });

  if (error || !matches || matches.length === 0) {
    return { outcome: 'queued' };
  }

  const top = matches[0] as { matched_job_id: string; score: number; job_number: string };

  // Lane 1 — auto-attach
  // Only if exact match AND extraction confidence is high or medium.
  // Low-confidence extractions are NEVER auto-attached even on exact match —
  // we'd rather have the operator review the numbers.
  if (
    top.score >= AUTO_ATTACH_SCORE_THRESHOLD &&
    args.extractedConfidence !== 'low'
  ) {
    return await autoAttach(args, top);
  }

  // Lane 2 — suggest in Allocation Portal
  if (top.score >= SUGGEST_SCORE_THRESHOLD) {
    await args.admin
      .from('bills')
      .update({
        suggested_job_id: top.matched_job_id,
        suggested_match_score: Number(top.score.toFixed(2)),
        updated_at: new Date().toISOString(),
      })
      .eq('id', args.billId);
    return {
      outcome: 'suggested',
      matched_job_id: top.matched_job_id,
      matched_job_number: top.job_number,
      match_score: top.score,
    };
  }

  // Lane 3 — queue, no suggestion
  return { outcome: 'queued' };
}

async function autoAttach(
  args: RouterArgs,
  match: { matched_job_id: string; score: number; job_number: string },
): Promise<RouterResult> {
  // Read the bill + line items for the Xero push
  const { data: bill, error: billErr } = await args.admin
    .from('bills')
    .select('*, line_items:bill_line_items(*)')
    .eq('id', args.billId)
    .single();
  if (billErr || !bill) {
    // Fall back to suggestion if we can't read the bill (shouldn't happen)
    return {
      outcome: 'suggested',
      matched_job_id: match.matched_job_id,
      match_score: match.score,
    };
  }

  // Mark attached
  const now = new Date().toISOString();
  await args.admin
    .from('bills')
    .update({
      status: 'attached',
      job_id: match.matched_job_id,
      attached_at: now,
      attached_by: null, // null = automated
      suggested_job_id: null,
      suggested_match_score: null,
      updated_at: now,
    })
    .eq('id', args.billId);

  // Push to Xero. Only an id Xero returned marks the bill synced; not connected
  // leaves it pending.
  try {
    const result = await pushBillToXero({
      admin: args.admin,
      organizationId: args.organizationId,
      bill,
      job: { id: match.matched_job_id, job_number: match.job_number, name: '' },
    });

    await args.admin.from('bills').update(billXeroSyncUpdate(result, now)).eq('id', args.billId);

    return {
      outcome: 'auto_attached',
      matched_job_id: match.matched_job_id,
      matched_job_number: match.job_number,
      match_score: match.score,
      xero_status: result.status,
      xero_invoice_id: result.status === 'synced' ? result.xeroInvoiceId : undefined,
    };
  } catch (err) {
    // Xero push failed — bill is still attached locally, mark Xero as failed
    const msg = err instanceof Error ? err.message : String(err);
    await args.admin
      .from('bills')
      .update({
        xero_status: 'failed',
        notes: `Auto-attach succeeded; Xero push failed: ${msg.slice(0, 200)}`,
      })
      .eq('id', args.billId);
    return {
      outcome: 'auto_attached',
      matched_job_id: match.matched_job_id,
      matched_job_number: match.job_number,
      match_score: match.score,
    };
  }
}
