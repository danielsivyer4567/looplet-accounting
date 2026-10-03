// Dates for the bank-feed settings, in AEST (UTC+10): the bank date the bank-feed functions check an import-from
// date against (_shared/redbark/history.ts feedToday).

/** Today's date in AEST (UTC+10), the bank date the server checks the import-from date against. */
export function todayAest(now: Date = new Date()): string {
  return new Date(now.getTime() + 10 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 1 July of the current Australian financial year (1 July to 30 June), in AEST.
 * https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/coming-to-australia/tax-in-australia-what-you-need-to-know */
export function defaultImportFrom(now: Date = new Date()): string {
  const aest = new Date(now.getTime() + 10 * 3600 * 1000);
  const year = aest.getUTCMonth() >= 6 ? aest.getUTCFullYear() : aest.getUTCFullYear() - 1;
  return `${year}-07-01`;
}
