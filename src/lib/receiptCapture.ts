/**
 * Builds the receipt-webhook payloads for in-app capture on the Receipt Hub: a receipt typed in by
 * the owner, or one read from an uploaded photo or PDF. Money is integer cents.
 *
 * GST is only sent when the receipt shows it (or shows a subtotal); otherwise it is left out and
 * receipt-webhook records the receipt with GST unknown, for review, instead of assuming 1/11.
 */
import { resolveDocumentGst } from '@/lib/gst';

export type ReceiptSyncTarget = 'xero' | 'myob' | 'quickbooks' | 'generic_api';

const SYNC_TARGETS: ReceiptSyncTarget[] = ['xero', 'myob', 'quickbooks', 'generic_api'];

export interface ExtractedBillData {
  supplier_name: string | null;
  supplier_abn: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  subtotal_ex_gst: number | null;
  gst_amount: number | null;
  total_inc_gst: number | null;
  currency: string;
  job_reference: string | null;
  line_items: {
    description: string;
    quantity: number;
    unit_price: number;
    total: number;
  }[];
}

export interface ManualReceiptInput {
  merchant: string;
  totalCents: number;
  /** The GST shown on the receipt, or null when the field was left blank. */
  gstCents: number | null;
  purchaseAt: string;
  receiptNumber: string;
  jobReference: string;
  organizationId: string;
}

export function dollarsToCents(value: number | null | undefined): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 100);
}

export function buildManualReceiptPayload(input: ManualReceiptInput) {
  const gst = resolveDocumentGst({
    totalCents: input.totalCents,
    gstCents: input.gstCents,
    subtotalCents: null,
  });
  return {
    merchant: { name: input.merchant },
    receipt: {
      number: input.receiptNumber,
      event_type: 'sale',
      purchase_at: input.purchaseAt,
      currency: 'AUD',
      ...(gst.gstCents != null
        ? { subtotal_ex_gst_cents: gst.subtotalCents, gst_cents: gst.gstCents }
        : {}),
      total_inc_gst_cents: input.totalCents,
      tender_status: 'completed',
    },
    classification: {
      business_use: 'business',
      job_reference: input.jobReference,
      sync_targets: SYNC_TARGETS,
      source_org_id: input.organizationId,
    },
    line_items: [
      {
        description: input.merchant,
        quantity: 1,
        unit_price_cents: input.totalCents,
        total_inc_gst_cents: input.totalCents,
        ...(gst.gstCents != null ? { gst_cents: gst.gstCents } : {}),
      },
    ],
  };
}

export function buildReceiptPayloadFromExtraction(
  extracted: ExtractedBillData,
  orgId: string,
  originalStorageKey: string,
) {
  const totalCents = dollarsToCents(extracted.total_inc_gst);
  // GST and subtotal only as printed on the document; a bare total leaves GST unknown.
  const gst = resolveDocumentGst({
    totalCents,
    gstCents: dollarsToCents(extracted.gst_amount),
    subtotalCents: dollarsToCents(extracted.subtotal_ex_gst),
  });
  const receiptNumber = extracted.invoice_number || `PHOTO-${Date.now().toString().slice(-8)}`;
  return {
    merchant: {
      name: extracted.supplier_name || 'Unknown merchant',
      abn: extracted.supplier_abn || undefined,
    },
    receipt: {
      number: receiptNumber,
      event_type: 'sale',
      purchase_at: extracted.invoice_date
        ? new Date(extracted.invoice_date).toISOString()
        : new Date().toISOString(),
      currency: extracted.currency || 'AUD',
      subtotal_ex_gst_cents: gst.subtotalCents ?? undefined,
      gst_cents: gst.gstCents ?? undefined,
      total_inc_gst_cents: totalCents ?? 0,
      tender_status: 'completed',
      // Preserve the original uploaded file for provenance — receipt-webhook
      // keeps the full payload in raw_extracted, so the link survives.
      original_storage_key: originalStorageKey,
    },
    classification: {
      business_use: 'business',
      job_reference: extracted.job_reference || '',
      sync_targets: SYNC_TARGETS,
      source_org_id: orgId,
    },
    // OCR line items carry no GST figure, so none is sent per line.
    line_items: (extracted.line_items ?? []).map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unit_price_cents: dollarsToCents(line.unit_price) ?? 0,
      total_inc_gst_cents: dollarsToCents(line.total) ?? 0,
    })),
  };
}
