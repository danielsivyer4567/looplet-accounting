/**
 * GST figures taken from a bill or receipt. Money is integer cents.
 *
 * The rule here is: never invent a GST credit. GST is only recorded when the document shows it
 * (or shows a subtotal and a total, so the difference is the GST), or when the owner says what it
 * is. A total on its own says nothing about GST: the sale may be GST-free, the supplier may not be
 * registered for GST, or the figure may need a tax invoice before a credit can be claimed. In that
 * case GST stays unknown (null) and the bill is left for review, so no credit reaches the BAS.
 *
 * ATO: you can't claim a GST credit for purchases with no GST in the price, including from a
 * supplier that is not registered for GST, and you need a valid tax invoice for purchases over
 * $82.50 (GST inclusive).
 * https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/claiming-gst-credits/when-you-cannot-claim-a-gst-credit
 */

/** Where the GST figure came from. `unknown` means no GST is recorded and the bill needs review. */
export type GstSource = 'document' | 'subtotal_difference' | 'none' | 'unknown';

export interface DocumentGstInput {
  totalCents: number | null;
  gstCents: number | null;
  subtotalCents: number | null;
  /** false when the owner or the document says the supplier is not registered for GST. */
  supplierGstRegistered?: boolean | null;
}

export interface DocumentGst {
  totalCents: number | null;
  gstCents: number | null;
  subtotalCents: number | null;
  source: GstSource;
}

export function resolveDocumentGst(input: DocumentGstInput): DocumentGst {
  const { totalCents, gstCents, subtotalCents } = input;

  // A supplier that is not registered for GST can't charge GST, so there is no credit to claim.
  if (input.supplierGstRegistered === false) {
    const total = totalCents ?? subtotalCents;
    return { totalCents: total, gstCents: 0, subtotalCents: total, source: 'none' };
  }

  if (gstCents != null) {
    const total = totalCents ?? (subtotalCents != null ? subtotalCents + gstCents : null);
    const subtotal = subtotalCents ?? (total != null ? total - gstCents : null);
    return {
      totalCents: total,
      gstCents,
      subtotalCents: subtotal,
      source: gstCents === 0 ? 'none' : 'document',
    };
  }

  if (totalCents != null && subtotalCents != null && totalCents >= subtotalCents) {
    const gst = totalCents - subtotalCents;
    return {
      totalCents,
      gstCents: gst,
      subtotalCents,
      source: gst === 0 ? 'none' : 'subtotal_difference',
    };
  }

  // Only a total (or nothing): GST is unknown. Do not assume 1/11.
  return { totalCents, gstCents: null, subtotalCents: null, source: 'unknown' };
}

/**
 * GST in a GST-inclusive total that is fully taxable at the standard rate: one-eleventh, rounded to
 * the nearest cent with half a cent rounding up. Only call this when the document says the total
 * includes GST (for example "Total price includes GST"), never as a default for a missing figure.
 * https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/tax-invoices
 */
export function gstIncludedInTotal(totalCents: number): number {
  return Math.round(totalCents / 11);
}
