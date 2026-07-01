// Small shared display formatters (parallel to money.ts). Keep these dependency-free
// and presentation-only.

/** Capitalise the first letter: "discretionary" -> "Discretionary"; null/"" -> "". */
export function titleCase(s: string | null | undefined): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A date(-time) string -> "30 Jun 2024" (en-AU); null -> em dash. */
export function formatDay(d: string | null | undefined): string {
  if (!d) return '—';
  const dt = new Date(d);
  // A non-empty but unparseable value ('0000-00-00', a malformed timestamp) is
  // truthy, so fall back to the em dash rather than render literal "Invalid Date".
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** The current AU income year as its start year (Jul-Dec => this year; Jan-Jun => prior). */
export function currentFyStartYear(): number {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}
