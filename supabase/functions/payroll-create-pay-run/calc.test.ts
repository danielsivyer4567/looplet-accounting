import { assertEquals, assertMatch, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { baseHourlyRateCents, grossPay, OVERTIME_MULTIPLIER, sumHours } from './calc.ts';

// The add-employee form's defaults: $45/hr base, 11.5% super, 1.5% WorkCover, 8% leave accrual.
const wage = { base_hourly_rate: 45, super_pct: 11.5, workcover_pct: 1.5, leave_loading_pct: 8, loaded_hourly_rate_cents: 5445 };

Deno.test('wages use the base hourly rate, not the loaded cost rate', () => {
  const rate = baseHourlyRateCents(wage);
  assertEquals(rate, 4500);
  const pay = grossPay({ ordinary: 38, overtime: 0, leave: 0 }, rate);
  assertEquals(pay.totalCents, 171_000); // 38 h x $45.00 = $1,710.00
  // The old calculation paid 38 h x $54.45 = $2,069.10, about 21% too much.
  assertEquals(Math.round(38 * wage.loaded_hourly_rate_cents), 206_910);
});

Deno.test('overtime is loaded on the base rate and excluded from ordinary time earnings', () => {
  const pay = grossPay({ ordinary: 38, overtime: 4, leave: 0 }, 4500);
  assertEquals(OVERTIME_MULTIPLIER, 1.5);
  assertEquals(pay.overtimeCents, 27_000); // 4 h x $45 x 1.5
  assertEquals(pay.totalCents, 198_000);
  assertEquals(pay.ordinaryTimeEarningsCents, 171_000);
});

Deno.test('paid leave is paid at the base rate and counts as ordinary time earnings', () => {
  const pay = grossPay({ ordinary: 30.4, overtime: 0, leave: 7.6 }, 4500);
  assertEquals(pay.ordinaryCents, 136_800);
  assertEquals(pay.leaveCents, 34_200);
  assertEquals(pay.ordinaryTimeEarningsCents, 171_000);
});

Deno.test('hours are summed by entry type; public holidays are ordinary time', () => {
  assertEquals(
    sumHours([
      { hours: 7.6, entry_type: 'ordinary' },
      { hours: '7.6', entry_type: 'public_holiday' },
      { hours: 2, entry_type: 'overtime' },
      { hours: 7.6, entry_type: 'annual_leave' },
      { hours: 3.8, entry_type: 'sick_leave' },
      { hours: 1, entry_type: null },
      { hours: null, entry_type: 'ordinary' },
    ]),
    { ordinary: 16.2, overtime: 2, leave: 11.4 },
  );
});

Deno.test('cents are rounded once per component', () => {
  const pay = grossPay({ ordinary: 7.33, overtime: 1.17, leave: 0 }, 3347);
  assertEquals(pay.ordinaryCents, 24_534); // 24,533.51
  assertEquals(pay.overtimeCents, 5_874); // 5,873.985
  assertEquals(pay.totalCents, 30_408);
});

Deno.test('a missing or invalid base rate stops the payslip instead of paying the loaded rate or zero', () => {
  for (const bad of [{}, { base_hourly_rate: null }, { base_hourly_rate: '' }, { base_hourly_rate: 0 }, { base_hourly_rate: -5 }, { base_hourly_rate: 'abc' }, null]) {
    assertThrows(() => baseHourlyRateCents(bad as never), Error, 'no base hourly rate');
  }
  assertEquals(baseHourlyRateCents({ base_hourly_rate: '45.5' }), 4550);
  assertEquals(baseHourlyRateCents({ base_hourly_rate: 31.255 }), 3126);
});

Deno.test('the pay run prices every payslip with these helpers on the base rate', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  assertMatch(src, /import \{ baseHourlyRateCents, grossPay, sumHours \} from '\.\/calc\.ts';/);
  assertMatch(src, /const baseRate = baseHourlyRateCents\(wage\);/);
  assertMatch(src, /grossPay\(hours, baseRate\)/);
  // The base rate is recorded on the payslip; the loaded cost rate is never used to price wages.
  assertMatch(src, /base_hourly_rate_cents: baseRate/);
  assertEquals(/loaded_hourly_rate_cents \?\? 0|\* loadedRate/.test(src), false);
});
