import { assertEquals, assertMatch, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { effectiveSuperRate, statutorySuperRatePct } from './super.ts';

// Charge percentages from SGAA 1992 s 19(2) (to 30 June 2026) and s 17A(2) (from 1 July 2026). See super.ts.

Deno.test('the statutory rate follows the pay date, changing on 1 July', () => {
  assertEquals(statutorySuperRatePct('2025-06-30'), 11.5);
  assertEquals(statutorySuperRatePct('2025-07-01'), 12);
  assertEquals(statutorySuperRatePct('2026-07-01'), 12); // payday super: s 17A(2) "charge percentage means 12"
  assertEquals(statutorySuperRatePct('2027-03-15'), 12);
  assertEquals(statutorySuperRatePct('2024-07-01'), 11.5);
  assertEquals(statutorySuperRatePct('2023-07-01'), 11);
  assertEquals(statutorySuperRatePct('2022-07-01'), 10.5);
  assertEquals(statutorySuperRatePct('2021-07-01'), 10);
  assertEquals(statutorySuperRatePct('2021-06-30'), 9.5);
  assertEquals(statutorySuperRatePct('2014-07-01'), 9.5);
  assertEquals(statutorySuperRatePct('2013-07-01'), 9.25);
});

Deno.test('a malformed or unsupported pay date fails loudly instead of guessing a rate', () => {
  for (const bad of ['', '2025-7-1', '01/07/2025', '2025-13-01', '2025-07-32', 'today']) {
    assertThrows(() => statutorySuperRatePct(bad), Error, 'YYYY-MM-DD');
  }
  assertThrows(() => statutorySuperRatePct('2013-06-30'), Error, 'before 1 July 2013');
});

Deno.test('an employee rate below the SG rate is raised to it', () => {
  // The old add-employee default: 11.5% on a pay date when SG is 12%.
  assertEquals(effectiveSuperRate({ payDate: '2025-10-03', employeePct: 11.5 }), {
    pct: 12,
    statutoryPct: 12,
    configuredPct: 11.5,
    source: 'employee',
    raisedToStatutory: true,
  });
  assertEquals(effectiveSuperRate({ payDate: '2026-07-14', employeePct: 0 }).pct, 12);
  // An organisation default below SG is raised too.
  assertEquals(effectiveSuperRate({ payDate: '2025-10-03', organisationPct: '10' }).pct, 12);
});

Deno.test('a rate above the SG rate is honoured, employee before organisation', () => {
  assertEquals(effectiveSuperRate({ payDate: '2025-10-03', employeePct: 15, organisationPct: 13 }), {
    pct: 15,
    statutoryPct: 12,
    configuredPct: 15,
    source: 'employee',
    raisedToStatutory: false,
  });
  const org = effectiveSuperRate({ payDate: '2025-10-03', employeePct: null, organisationPct: '13.5' });
  assertEquals([org.pct, org.source], [13.5, 'organisation']);
  // A rate that was correct for its own pay date is kept: 11.5% paid in June 2025.
  assertEquals(effectiveSuperRate({ payDate: '2025-06-30', employeePct: 11.5 }).pct, 11.5);
});

Deno.test('with no rate set, the pay date statutory rate applies', () => {
  for (const blank of [undefined, null, '', 'abc', -1]) {
    const r = effectiveSuperRate({ payDate: '2025-10-03', employeePct: blank, organisationPct: blank });
    assertEquals(r, { pct: 12, statutoryPct: 12, configuredPct: null, source: 'statutory', raisedToStatutory: false });
  }
});

Deno.test('the pay run uses the floored rate for every payslip and validates the pay date up front', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  assertMatch(src, /import \{ effectiveSuperRate, statutorySuperRatePct \} from '\.\/super\.ts';/);
  assertMatch(src, /effectiveSuperRate\(\{\s*payDate: pay_date,/);
  assertMatch(src, /p_rate_pct: superRate\.pct/);
  assertMatch(src, /super_rate_pct: superRate\.pct/);
  // The old local table (and its unfloored "employee rate wins" rule) is gone.
  assertEquals(/function statutorySuperRatePct/.test(src), false);
  assertEquals(/empSuperPct \?\? defaultSuperPct/.test(src), false);
  // A bad pay date is rejected before the pay run row is written.
  const check = src.indexOf('statutorySuperRatePct(pay_date)');
  const insert = src.indexOf(".from('pay_runs')");
  assertEquals(check > 0 && check < insert, true);
});
