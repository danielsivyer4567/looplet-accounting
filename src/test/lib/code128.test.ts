import { describe, expect, it } from 'vitest';
import { code128Bars, code128Checksum } from '@/lib/code128';

describe('Code 128 receipt pass barcode', () => {
  it('computes the Code B checksum for printable checkout identity text', () => {
    expect(code128Checksum('ABC')).toBe(1);
  });

  it('builds drawable bars with a quiet zone', () => {
    const barcode = code128Bars('rhp_customer.receiptsecret');
    const firstBar = barcode.bars[0];
    const lastBar = barcode.bars.at(-1);

    expect(barcode.width).toBeGreaterThan(0);
    expect(barcode.bars.length).toBeGreaterThan(20);
    expect(firstBar?.x).toBe(10);
    expect(lastBar?.x).toBeLessThan(barcode.width);
  });

  it('rejects values that retail scanners should not receive in a Code 128 pass', () => {
    expect(() => code128Bars('rhp_bad\nsecret')).toThrow(/printable ASCII/);
    expect(() => code128Bars('')).toThrow(/required/);
  });
});
