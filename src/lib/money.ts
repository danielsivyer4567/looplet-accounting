/**
 * Money formatting helpers. Internally everything is BIGINT cents.
 * Use these for display only — never do math on the formatted strings.
 */

const fmt = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function centsToDollars(cents: number | null | undefined): number {
  if (cents == null) return 0;
  return cents / 100;
}

export function formatMoney(cents: number | null | undefined): string {
  return fmt.format(centsToDollars(cents));
}

/** Compact form for cards: $12.3k, $1.2M etc. Falls back to full when small. */
export function formatMoneyCompact(cents: number | null | undefined): string {
  const dollars = centsToDollars(cents);
  if (Math.abs(dollars) < 1000) return formatMoney(cents);
  if (Math.abs(dollars) < 1_000_000) return `$${(dollars / 1000).toFixed(1)}k`;
  return `$${(dollars / 1_000_000).toFixed(2)}M`;
}
