/**
 * Xero adapter — single-shot ACCPAY push on bill attachment.
 *
 * Port target from Loopletnumero `backend/src/services/accounting/XeroAdapter.ts`.
 * Differences in this Deno-edge-fn version:
 *   - Service-role client passed in (no per-request auth bootstrap)
 *   - Crypto via Deno's SubtleCrypto for token encrypt/decrypt
 *   - Idempotency key: SHA-256 of (organization_id, bill_id, version)
 *
 * STATUS: stubbed. v1 minimum to land:
 *   - [ ] Read xero_integrations row for the org
 *   - [ ] Decrypt access token
 *   - [ ] Refresh if expired
 *   - [ ] Build ACCPAY payload (Contact, LineItems with tracking category, Date, DueDate, Reference)
 *   - [ ] POST to /api.xro/2.0/Invoices with Idempotency-Key header
 *   - [ ] Insert xero_sync_log row (success or failure)
 *   - [ ] If XERO_STUB_MODE=true, return STUB-XXXX without calling Xero
 *
 * Acceptance: Phase 3 of docs/ROADMAP.md. Tested against AFGC's real
 * supplier invoices once user fills ADR 0004.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface PushArgs {
  admin: SupabaseClient;
  organizationId: string;
  bill: {
    id: string;
    invoice_number: string | null;
    invoice_date: string | null;
    due_date: string | null;
    total_inc_gst_cents: number | null;
    supplier_name_raw: string | null;
    line_items?: Array<{
      description: string;
      quantity: number;
      unit_price_cents: number;
      total_cents: number;
      gst_cents: number;
    }>;
  };
  job: {
    id: string;
    job_number: string;
    name: string;
  };
}

interface PushResult {
  xeroInvoiceId: string;
  isStub: boolean;
}

export async function pushBillToXero(args: PushArgs): Promise<PushResult> {
  const stubMode = Deno.env.get('XERO_STUB_MODE') === 'true';

  if (stubMode) {
    const stubId = `STUB-${args.bill.id.slice(0, 8).toUpperCase()}`;
    await args.admin.from('xero_sync_log').insert({
      organization_id: args.organizationId,
      record_type: 'bill',
      record_id: args.bill.id,
      xero_id: stubId,
      operation: 'push',
      status: 'success',
      idempotency_key: crypto.randomUUID(),
      request: { stub: true, jobNumber: args.job.job_number },
      response: { stub: true, id: stubId },
    });
    return { xeroInvoiceId: stubId, isStub: true };
  }

  // TODO Phase 3: real Xero push.
  //   1. Load xero_integrations row for organization
  //   2. Decrypt access token; refresh if needed
  //   3. POST to https://api.xero.com/api.xro/2.0/Invoices with payload:
  //      {
  //        Type: 'ACCPAY',
  //        Contact: { Name: bill.supplier_name_raw },
  //        Date: bill.invoice_date,           // ORIGINAL date (BAS quarter correctness)
  //        DueDate: bill.due_date,
  //        LineAmountTypes: 'Inclusive',
  //        Reference: bill.invoice_number,
  //        LineItems: bill.line_items.map(li => ({
  //          Description: li.description,
  //          Quantity: li.quantity,
  //          UnitAmount: li.unit_price_cents / 100,
  //          AccountCode: <default per supplier or org>,
  //          Tracking: [{ Name: 'Job', Option: job.job_number }],   // tracking category for per-job reports
  //        })),
  //      }
  //   4. Insert xero_sync_log row
  //   5. Return Xero's invoice id

  throw new Error(
    'Xero adapter not yet implemented (Phase 3). Set XERO_STUB_MODE=true for now to exercise the wiring.',
  );
}
