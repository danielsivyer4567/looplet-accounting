import { describe, expect, it } from 'vitest';
import { parseBillHeaders } from '../supabase/functions/_shared/ocr/headerParser.ts';

describe('OCR header parser', () => {
  it('parses ungrouped four-digit invoice totals from born-digital PDF text', () => {
    const result = parseBillHeaders(`
      ACME Plumbing Pty Ltd
      ABN 12 345 678 901
      Tax Invoice INV-12345
      Date 30/06/2026
      Subtotal 1122.33
      GST 112.23
      Total Inc GST 1234.56
      Job Ref JB-445
    `);

    expect(result.data.supplier_name).toBe('ACME Plumbing Pty Ltd');
    expect(result.data.supplier_abn).toBe('12345678901');
    expect(result.data.invoice_number).toBe('INV-12345');
    expect(result.data.invoice_date).toBe('2026-06-30');
    expect(result.data.subtotal_ex_gst).toBe(1122.33);
    expect(result.data.gst_amount).toBe(112.23);
    expect(result.data.total_inc_gst).toBe(1234.56);
    expect(result.data.job_reference).toBe('JB-445');
    expect(result.mathConsistent).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.data.confidence).toBe('high');
  });

  it('parses AU currency prefixes and space-separated thousands', () => {
    const result = parseBillHeaders(`
      Northside Electrical
      Tax Invoice INV-992
      ABN 98 765 432 109
      Date 01 Jul 2026
      Total ex GST AUD 11 223.34
      GST Amount AUD 1 122.33
      Amount Due AUD 12 345.67
    `);

    expect(result.data.invoice_date).toBe('2026-07-01');
    expect(result.data.subtotal_ex_gst).toBe(11223.34);
    expect(result.data.gst_amount).toBe(1122.33);
    expect(result.data.total_inc_gst).toBe(12345.67);
    expect(result.mathConsistent).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });
});
