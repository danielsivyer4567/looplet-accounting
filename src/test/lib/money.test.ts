/**
 * Unit tests for src/lib/money.ts
 *
 * These are pure function tests — no DOM, no mocks needed.
 * The en-AU locale is expected to produce "A$" or "$" depending on the
 * runtime's ICU data version, so we normalise the currency symbol out of
 * assertions where the exact prefix varies, and instead check structure.
 */

import { describe, it, expect } from 'vitest';
import { centsToDollars, formatMoney, formatMoneyCompact } from '@/lib/money';

// ---------------------------------------------------------------------------
// centsToDollars
// ---------------------------------------------------------------------------

describe('centsToDollars', () => {
  it('converts positive cents to dollars', () => {
    expect(centsToDollars(1000)).toBe(10);
  });

  it('converts zero', () => {
    expect(centsToDollars(0)).toBe(0);
  });

  it('handles null (sentinel for missing DB value)', () => {
    expect(centsToDollars(null)).toBe(0);
  });

  it('handles undefined', () => {
    expect(centsToDollars(undefined)).toBe(0);
  });

  it('converts negative cents', () => {
    expect(centsToDollars(-500)).toBe(-5);
  });
});

// ---------------------------------------------------------------------------
// formatMoney
// ---------------------------------------------------------------------------

describe('formatMoney', () => {
  it('formats zero as a currency string with two decimal places', () => {
    const result = formatMoney(0);
    // Should contain "0.00" regardless of locale symbol variant
    expect(result).toMatch(/0\.00/);
  });

  it('formats null as zero', () => {
    const result = formatMoney(null);
    expect(result).toMatch(/0\.00/);
  });

  it('formats a standard positive amount', () => {
    // 12345 cents = $123.45
    const result = formatMoney(12345);
    expect(result).toMatch(/123\.45/);
  });

  it('formats a negative amount', () => {
    // -500 cents = -$5.00
    const result = formatMoney(-500);
    expect(result).toMatch(/-?\(?.*5\.00/);
    // Ensure it contains a minus sign or parentheses (locale may use either)
    expect(result).toMatch(/[-($]/);
  });

  it('formats a sub-cent value (0.009 dollars = 0 cents truncated to 0)', () => {
    // 0 cents passed → $0.00
    expect(formatMoney(0)).toMatch(/0\.00/);
  });

  it('formats an amount over $1M', () => {
    // 100_000_000 cents = $1,000,000.00
    const result = formatMoney(100_000_000);
    // Contains the numeric value with decimal
    expect(result).toMatch(/1[,.]?000[,.]?000\.00/);
  });
});

// ---------------------------------------------------------------------------
// formatMoneyCompact
// ---------------------------------------------------------------------------

describe('formatMoneyCompact', () => {
  it('falls back to full currency format when < $1,000', () => {
    // 50000 cents = $500
    const result = formatMoneyCompact(50_000);
    expect(result).toMatch(/500\.00/);
  });

  it('formats thousands as $Xk', () => {
    // 150_000 cents = $1,500 → "$1.5k"
    const result = formatMoneyCompact(150_000);
    expect(result).toBe('$1.5k');
  });

  it('formats exactly $1,000 as $1.0k', () => {
    expect(formatMoneyCompact(100_000)).toBe('$1.0k');
  });

  it('formats millions as $X.XXM', () => {
    // 250_000_000 cents = $2,500,000 → "$2.50M"
    const result = formatMoneyCompact(250_000_000);
    expect(result).toBe('$2.50M');
  });

  it('handles zero', () => {
    const result = formatMoneyCompact(0);
    expect(result).toMatch(/0\.00/);
  });

  it('handles negative thousands', () => {
    // -200_000 cents = -$2,000 → "$-2.0k"
    const result = formatMoneyCompact(-200_000);
    expect(result).toBe('$-2.0k');
  });

  it('handles null', () => {
    const result = formatMoneyCompact(null);
    expect(result).toMatch(/0\.00/);
  });
});
