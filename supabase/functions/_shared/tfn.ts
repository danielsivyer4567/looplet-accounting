// Tax file number helpers shared by the TFN edge functions (pure, no I/O).
//
// A full TFN is only ever handled server-side: it is validated and encrypted on the way into a vault, and only the
// masked form (last four digits) is returned to the browser or written to an export.

/** The digits of a TFN as entered (spaces, dashes and other separators removed); null when there are none. */
export function normaliseTfn(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

/** True for an 8- or 9-digit TFN, the shapes the ATO issues. */
export function isTfnShape(digits: string | null | undefined): digits is string {
  return typeof digits === 'string' && /^\d{8,9}$/.test(digits);
}

export function tfnLast4(digits: string): string {
  return digits.slice(-4);
}

/** The masked form shown to people: five stars and the last four digits. */
export function maskTfnLast4(last4: string): string {
  return `*****${last4}`;
}
