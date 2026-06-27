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
  return new Date(d).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}
