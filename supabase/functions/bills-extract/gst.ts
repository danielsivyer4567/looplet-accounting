/**
 * GST on an OCR'd bill, taken only from what the document shows. Money is integer cents.
 *   - GST read off the document → use it verbatim (estimated=false).
 *   - total + subtotal both present → GST = total − subtotal (estimated=true, so review checks it).
 *   - subtotal equal to the total → no GST (GST-free, input-taxed or an unregistered supplier).
 *   - total only → GST unknown: gst and subtotal stay null. No 1/11 is assumed, because the sale
 *     may be GST-free or the supplier may not be registered for GST, and either way there is no
 *     credit to claim. The BAS coverage check counts the bill as incomplete until GST is entered.
 *   - no total → leave null (nothing to derive from).
 * https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/claiming-gst-credits/when-you-cannot-claim-a-gst-credit
 */
export function deriveGstCents(
  totalCents: number | null,
  gstCents: number | null,
  subtotalCents: number | null,
): { gstCents: number | null; subtotalCents: number | null; estimated: boolean } {
  if (gstCents != null) {
    return {
      gstCents,
      subtotalCents: subtotalCents ?? (totalCents != null ? totalCents - gstCents : null),
      estimated: false,
    };
  }
  if (totalCents == null) {
    return { gstCents: null, subtotalCents, estimated: false };
  }
  if (subtotalCents != null && totalCents > subtotalCents) {
    return { gstCents: totalCents - subtotalCents, subtotalCents, estimated: true };
  }
  if (subtotalCents != null) {
    // Document supplied a subtotal that equals (or exceeds) the total → the
    // supply carries NO GST (GST-free: fresh food, bank fees, overseas, rent).
    return { gstCents: 0, subtotalCents, estimated: false };
  }
  // Total only: the document does not show GST. Leave it unknown rather than invent a credit.
  return { gstCents: null, subtotalCents: null, estimated: false };
}
