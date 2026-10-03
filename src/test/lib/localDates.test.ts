/**
 * src/lib/localDates.ts — default dates in the organisation's Australian time zone.
 *
 * The bug these guard against: `new Date().toISOString().slice(0, 10)` is the UTC
 * date, which from 10 am AEST is still yesterday. Every case here fixes `now` as
 * an instant (a `Z` timestamp) so the result cannot depend on the machine's zone.
 */

import { describe, expect, it } from 'vitest';
import {
  AU_STATE_TIME_ZONES,
  DEFAULT_TIME_ZONE,
  addDays,
  addMonths,
  daysInMonth,
  endOfFinancialYear,
  endOfMonth,
  financialYearQuarter,
  financialYearStartYear,
  formatDateAu,
  formatTimestampAu,
  isIsoDate,
  localDateParts,
  orgTimeZone,
  parseIsoDate,
  startOfCalendarQuarter,
  startOfCalendarYear,
  startOfFinancialYear,
  startOfMonth,
  todayLocal,
  weekdayOf,
} from '@/lib/localDates';

describe('todayLocal', () => {
  it('rolls over to the next day at 10 am UTC in Brisbane while the UTC date is still yesterday', () => {
    // 30 June 15:30 UTC = 1 July 01:30 AEST.
    const eveningUtc = new Date('2026-06-30T15:30:00Z');
    expect(eveningUtc.toISOString().slice(0, 10)).toBe('2026-06-30');
    expect(todayLocal(DEFAULT_TIME_ZONE, eveningUtc)).toBe('2026-07-01');
    expect(todayLocal(undefined, eveningUtc)).toBe('2026-07-01');
  });

  it('is still 30 June just before midnight Brisbane time', () => {
    expect(todayLocal(DEFAULT_TIME_ZONE, new Date('2026-06-30T13:59:00Z'))).toBe('2026-06-30');
  });

  it('uses the given zone: Perth is two hours behind Brisbane', () => {
    const eveningUtc = new Date('2026-06-30T15:30:00Z'); // 23:30 AWST
    expect(todayLocal('Australia/Perth', eveningUtc)).toBe('2026-06-30');
  });

  it('respects daylight saving in Sydney (AEDT, UTC+11) where Brisbane stays on UTC+10', () => {
    const lateJanuary = new Date('2026-01-31T13:30:00Z'); // 00:30 AEDT 1 Feb, 23:30 AEST 31 Jan
    expect(todayLocal('Australia/Sydney', lateJanuary)).toBe('2026-02-01');
    expect(todayLocal('Australia/Brisbane', lateJanuary)).toBe('2026-01-31');
  });
});

describe('localDateParts', () => {
  it('returns the wall-clock year, month, day and weekday in the zone', () => {
    // 2026-07-01 is a Wednesday.
    expect(localDateParts(new Date('2026-06-30T15:30:00Z'), 'Australia/Brisbane')).toEqual({
      year: 2026,
      month: 7,
      day: 1,
      weekday: 3,
    });
    expect(localDateParts(new Date('2026-06-30T15:30:00Z'), 'Australia/Perth').weekday).toBe(2);
  });
});

describe('orgTimeZone', () => {
  it('maps the organisation state to its zone and defaults to Brisbane', () => {
    expect(orgTimeZone({ state_code: 'WA' })).toBe('Australia/Perth');
    expect(orgTimeZone({ state_code: 'nsw' })).toBe('Australia/Sydney');
    expect(orgTimeZone({ state_code: 'ACT' })).toBe('Australia/Sydney');
    expect(orgTimeZone({ state_code: null })).toBe('Australia/Brisbane');
    expect(orgTimeZone({ state_code: 'XX' })).toBe('Australia/Brisbane');
    expect(orgTimeZone(null)).toBe('Australia/Brisbane');
    expect(orgTimeZone(undefined)).toBe(DEFAULT_TIME_ZONE);
  });

  it('covers every state and territory the database CHECK allows', () => {
    for (const code of ['QLD', 'NSW', 'VIC', 'WA', 'SA', 'TAS', 'NT', 'ACT']) {
      expect(AU_STATE_TIME_ZONES[code]).toMatch(/^Australia\//);
    }
  });
});

describe('financial year (1 July to 30 June)', () => {
  it('names the year by its start year', () => {
    expect(financialYearStartYear('2026-07-01')).toBe(2026);
    expect(financialYearStartYear('2026-06-30')).toBe(2025);
    expect(financialYearStartYear('2027-01-15')).toBe(2026);
  });

  it('gives the 1 July and 30 June bounds', () => {
    expect(startOfFinancialYear('2026-10-03')).toBe('2026-07-01');
    expect(endOfFinancialYear('2026-10-03')).toBe('2027-06-30');
    expect(startOfFinancialYear('2026-03-01')).toBe('2025-07-01');
    expect(endOfFinancialYear('2026-03-01')).toBe('2026-06-30');
  });

  it('rolls the financial year over at Brisbane midnight on 30 June, not UTC midnight', () => {
    const before = todayLocal(DEFAULT_TIME_ZONE, new Date('2026-06-30T13:59:00Z'));
    const after = todayLocal(DEFAULT_TIME_ZONE, new Date('2026-06-30T14:00:00Z'));
    expect(startOfFinancialYear(before)).toBe('2025-07-01');
    expect(startOfFinancialYear(after)).toBe('2026-07-01');
  });

  it('places dates in FY quarters Q1 Jul–Sep … Q4 Apr–Jun', () => {
    expect(financialYearQuarter('2026-07-01')).toEqual({ fyStartYear: 2026, quarter: 1 });
    expect(financialYearQuarter('2026-10-03')).toEqual({ fyStartYear: 2026, quarter: 2 });
    expect(financialYearQuarter('2027-02-14')).toEqual({ fyStartYear: 2026, quarter: 3 });
    expect(financialYearQuarter('2027-06-30')).toEqual({ fyStartYear: 2026, quarter: 4 });
  });
});

describe('calendar arithmetic', () => {
  it('adds and subtracts days across month and year ends', () => {
    expect(addDays('2026-06-30', 1)).toBe('2026-07-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-07-01', 14)).toBe('2026-07-15');
    expect(addDays('2026-03-01', -30)).toBe('2026-01-30');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); // leap year
  });

  it('adds months and clamps the day to the target month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-10-03', -12)).toBe('2025-10-03');
    expect(addMonths('2026-10-03', -24)).toBe('2024-10-03');
    expect(addMonths('2026-11-15', 2)).toBe('2027-01-15');
  });

  it('finds month, quarter and year starts and month ends', () => {
    expect(startOfMonth('2026-10-03')).toBe('2026-10-01');
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(startOfCalendarQuarter('2026-11-20')).toBe('2026-10-01');
    expect(startOfCalendarQuarter('2026-02-20')).toBe('2026-01-01');
    expect(startOfCalendarYear('2026-10-03')).toBe('2026-01-01');
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  it('knows the weekday (0 = Sunday)', () => {
    expect(weekdayOf('2026-10-03')).toBe(6); // Saturday
    expect(weekdayOf('2026-10-05')).toBe(1); // Monday
    expect(weekdayOf('2026-10-04')).toBe(0); // Sunday
  });

  it('parses the date part only and rejects other strings', () => {
    expect(parseIsoDate('2026-10-03T23:59:00+10:00')).toEqual({ year: 2026, month: 10, day: 3 });
    expect(() => parseIsoDate('3/10/2026')).toThrow(/YYYY-MM-DD/);
    expect(isIsoDate('2026-10-03')).toBe(true);
    expect(isIsoDate('')).toBe(false); // a cleared <input type="date">
    expect(isIsoDate(null)).toBe(false);
  });
});

describe('formatting', () => {
  // en-AU abbreviates most months ("Oct") but spells June, July and Sept in full,
  // so the fixtures avoid those months.
  it('formats a YYYY-MM-DD date for Australia without shifting it by the host zone', () => {
    expect(formatDateAu('2026-10-03')).toBe('03 Oct 2026');
    expect(formatDateAu('2026-12-25', { day: 'numeric', month: 'long', year: 'numeric' })).toBe(
      '25 December 2026',
    );
    expect(formatDateAu(null)).toBe('—');
    expect(formatDateAu('not a date')).toBe('—');
  });

  it('formats a timestamp as the organisation-local date', () => {
    // 31 Oct 15:30 UTC = 1 Nov 01:30 AEST, 31 Oct 23:30 AWST.
    expect(formatTimestampAu('2026-10-31T15:30:00Z')).toBe('01 Nov 2026');
    expect(formatTimestampAu('2026-10-31T15:30:00Z', 'Australia/Perth')).toBe('31 Oct 2026');
    expect(formatTimestampAu('0000-00-00')).toBe('—');
    expect(formatTimestampAu(null)).toBe('—');
  });
});
