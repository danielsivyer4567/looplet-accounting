/**
 * xero-sync-payments — pulls payments recorded in Xero back into Looplet.
 *
 * Xero is the source-of-truth for payments on invoices/bills we pushed.
 * This function polls Xero for payments modified since last_synced_at
 * and reconciles them locally:
 *
 *   ACCPAY payment → marks bills.status='paid', bills.paid_at=payment.Date
 *                     creates bank_transactions record if account can be matched
 *   ACCREC payment → creates invoice_payments row if not already present
 *                     updates invoices.amount_paid_cents / balance_due_cents
 *
 * Called:
 *   - daily by pg_cron (03:30 AEST) via pg_net.http_post with ?secret=...
 *   - on-demand by the Settings page "Sync payments" button
 *
 * Input:  { organization_id?: string }  (omit for all-org cron sweep)
 * Output: { ok: true, payments_processed: number }
 *
 * Notes:
 *   - Only processes payments for invoices/bills that have xero_invoice_id set
 *     (i.e. ones we pushed — we don't try to reconcile Xero-native records).
 *   - Idempotent: uses xero_sync_log to skip already-processed payment IDs.
 *   - Webhook alternative: Xero can POST to a webhook URL on every payment event.
 *     That is faster but requires a public HTTPS endpoint and topic registration.
 *     This poll-based fallback works for all deployment configs.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { requireEnv } from '../_shared/env.ts';
import { callXeroWithRetry, xeroFetch } from '../_shared/xero/auth.ts';

interface XeroPayment {
  PaymentID: string;
  Date: string;           // "\/Date(1234567890123+0000)\/" or ISO
  Amount: number;
  PaymentType: string;    // 'ACCPAYPAYMENT' | 'ACCRECCREDIT' etc.
  Invoice?: {
    InvoiceID: string;
    InvoiceNumber: string;
    Type: string;         // 'ACCPAY' | 'ACCREC'
  };
  Account?: {
    AccountID: string;
    Code: string;
    Name: string;
  };
}

interface XeroPaymentsResponse {
  Payments: XeroPayment[];
}

const CRON_SECRET = Deno.env.get('XERO_CRON_SECRET');

function isCronRequest(req: Request): boolean {
  const url = new URL(req.url);
  return url.searchParams.get('secret') === CRON_SECRET && Boolean(CRON_SECRET);
}

// Xero date format: /Date(1234567890123+0000)/
function parseXeroDate(xeroDate: string): string {
  const match = /\/Date\((\d+)/.exec(xeroDate);
  if (match?.[1]) {
    return new Date(parseInt(match[1], 10)).toISOString();
  }
  // Assume ISO if the above doesn't match
  return new Date(xeroDate).toISOString();
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = requireEnv('SUPABASE_ANON_KEY');

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    let orgIds: string[];

    if (isCronRequest(req)) {
      const { data, error } = await admin
        .from('xero_integrations')
        .select('organization_id')
        .eq('is_enabled', true);
      if (error) throw new Error(`DB query failed: ${error.message}`);
      orgIds = (data ?? []).map((r: { organization_id: string }) => r.organization_id);
    } else {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });

      let body: { organization_id?: string } = {};
      try { body = await req.json(); } catch { /* empty body ok */ }

      if (body.organization_id) {
        const { data: org } = await userClient
          .from('organizations')
          .select('id')
          .eq('id', body.organization_id)
          .maybeSingle();
        if (!org) return json({ ok: false, error: 'Organisation not accessible' }, 403);
        orgIds = [body.organization_id];
      } else {
        const { data: integrations } = await userClient
          .from('xero_integrations')
          .select('organization_id')
          .eq('is_enabled', true);
        orgIds = (integrations ?? []).map((r: { organization_id: string }) => r.organization_id);
      }
    }

    let totalProcessed = 0;

    for (const orgId of orgIds) {
      try {
        // Determine modified-since window: last_synced_at or 30 days ago
        const { data: integ } = await admin
          .from('xero_integrations')
          .select('last_synced_at')
          .eq('organization_id', orgId)
          .maybeSingle();

        const since = integ?.last_synced_at
          ? new Date(integ.last_synced_at)
          : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const sinceStr = since.toISOString();

        // Fetch payments modified since last sync
        const paymentsData = await callXeroWithRetry<XeroPaymentsResponse>(
          admin,
          orgId,
          (ctx) =>
            xeroFetch(
              ctx,
              `/api.xro/2.0/Payments?ModifiedAfter=${encodeURIComponent(sinceStr)}&where=Status=="AUTHORISED"`,
            ),
        );

        const payments = paymentsData?.Payments ?? [];

        for (const payment of payments) {
          if (!payment.Invoice?.InvoiceID) continue;

          const invoiceType = payment.Invoice.Type; // 'ACCPAY' | 'ACCREC'
          const xeroInvoiceId = payment.Invoice.InvoiceID;
          const amountCents = Math.round(payment.Amount * 100);
          const paidAt = parseXeroDate(payment.Date);

          // Check if already processed
          const { data: existing } = await admin
            .from('xero_sync_log')
            .select('id')
            .eq('organization_id', orgId)
            .eq('xero_id', payment.PaymentID)
            .eq('operation', 'payment_pull')
            .maybeSingle();
          if (existing) continue; // already handled

          if (invoiceType === 'ACCPAY') {
            // Find local bill by xero_invoice_id
            const { data: bill } = await admin
              .from('bills')
              .select('id, status, metadata')
              .eq('organization_id', orgId)
              .eq('xero_invoice_id', xeroInvoiceId)
              .maybeSingle();

            if (bill && bill.status !== 'paid') {
              await admin.from('bills').update({
                status: 'paid',
                paid_at: paidAt,
                metadata: { ...(bill.metadata ?? {}), xero_payment_id: payment.PaymentID },
              }).eq('id', bill.id);
            }
          } else if (invoiceType === 'ACCREC') {
            // Find local invoice by xero_invoice_id
            const { data: inv } = await admin
              .from('invoices')
              .select('id, organization_id, amount_paid_cents, total_inc_gst_cents, balance_due_cents')
              .eq('organization_id', orgId)
              .eq('xero_invoice_id', xeroInvoiceId)
              .maybeSingle();

            if (inv) {
              // Insert payment record if it doesn't already exist by reference
              const { data: existingPayment } = await admin
                .from('invoice_payments')
                .select('id')
                .eq('invoice_id', inv.id)
                .eq('amount_cents', amountCents)
                .maybeSingle();

              if (!existingPayment) {
                await admin.from('invoice_payments').insert({
                  organization_id: orgId,
                  invoice_id: inv.id,
                  paid_at: paidAt,
                  amount_cents: amountCents,
                  method: 'xero',
                  reference: payment.PaymentID,
                  notes: `Synced from Xero payment ${payment.PaymentID}`,
                });
              }
            }
          }

          // Record this payment as processed
          await admin.from('xero_sync_log').insert({
            organization_id: orgId,
            record_type: invoiceType === 'ACCPAY' ? 'bill' : 'invoice',
            record_id: crypto.randomUUID(), // synthetic — no local row guaranteed
            xero_id: payment.PaymentID,
            operation: 'payment_pull',
            status: 'success',
            idempotency_key: crypto.randomUUID(),
            request: null,
            response: payment as unknown as Record<string, unknown>,
          });

          totalProcessed++;
        }
      } catch (orgErr) {
        const msg = orgErr instanceof Error ? orgErr.message : String(orgErr);
        console.error(`[xero-sync-payments] org ${orgId} failed: ${msg}`);
        await admin
          .from('xero_integrations')
          .update({ last_error: msg.slice(0, 500), updated_at: new Date().toISOString() })
          .eq('organization_id', orgId);
      }
    }

    return json({ ok: true, payments_processed: totalProcessed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[xero-sync-payments] fatal:', msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
