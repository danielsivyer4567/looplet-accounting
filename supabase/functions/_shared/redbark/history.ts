// Date windows for reading a linked account's bank-feed history, ported from the clean-room rebuild
// (server/bankfeed-sync.ts).
//
// Each account keeps a checkpoint: the date through which its history has been imported (`coveredThrough`). The first
// read starts at the account's import-from date; later reads re-read a seven-day overlap so late-posted rows settle.
// A window the provider truncates, or that runs past the row or page limits, is too large: the overlap is dropped
// first, then the new days are halved until the window fits, so every run makes progress. A single day that still
// cannot fit is refused with its date rather than imported in part. Pending rows are counted and never returned.

import { RedbarkError, type FeedTransaction, type RedbarkClient } from './client.ts';

export const OVERLAP_DAYS = 7;
export const MAX_WINDOW_ROWS = 5000;
export const MAX_WINDOW_PAGES = 60;

export interface FeedCheckpoint {
  externalAccountId: string;
  connectionId: string;
  /** The import-from date chosen when the account was linked (YYYY-MM-DD). Nothing earlier is read. */
  syncFrom: string;
  /** The last date whose history is fully imported, or null before the first import. */
  coveredThrough: string | null;
}

export interface FeedWindow {
  from: string;
  to: string;
  /** Posted, nonzero rows dated `from` to `to`. */
  transactions: FeedTransaction[];
  pending: number;
  skipped: number;
  /** The checkpoint after this window commits; never earlier than the one it started from. */
  coveredThrough: string | null;
  caughtUp: boolean;
}

export interface WindowLimits {
  maxRows?: number;
  maxPages?: number;
}

class WindowTooLarge extends Error {}

const DAY_MS = 86_400_000;

/** Today's bank date in AEST (UTC+10), the date a sync judges completeness against. */
export function feedToday(nowMs: number = Date.now()): string {
  return new Date(nowMs + 10 * 3600 * 1000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS);
}

/** Every posted row dated `from` to `to`, read page by page. Pending rows are counted, not returned. */
export async function readPostedWindow(
  client: RedbarkClient,
  account: { externalAccountId: string; connectionId: string },
  from: string,
  to: string,
  limits: WindowLimits = {},
): Promise<{ transactions: FeedTransaction[]; pending: number; skipped: number }> {
  const maxRows = limits.maxRows ?? MAX_WINDOW_ROWS, maxPages = limits.maxPages ?? MAX_WINDOW_PAGES;
  const transactions: FeedTransaction[] = [];
  const seen = new Set<string>();
  let pending = 0, skipped = 0;
  for (let offset = 0, page = 0; ; page++) {
    let result;
    try {
      result = await client.transactions(account.externalAccountId, account.connectionId, from, offset, to);
    } catch (error) {
      if (error instanceof RedbarkError && error.truncated) throw new WindowTooLarge();
      throw error;
    }
    skipped += result.skipped;
    for (const transaction of result.transactions) {
      // Offset paging is not a snapshot: a row seen on an earlier page means the pages shifted underneath us.
      if (seen.has(transaction.id)) throw new RedbarkError('The bank feed provider repeated a transaction across pages.');
      seen.add(transaction.id);
      if (transaction.status === 'pending') {
        pending++;
        continue;
      }
      transactions.push(transaction);
      if (transactions.length > maxRows) throw new WindowTooLarge();
    }
    if (!result.hasMore) break;
    if (page + 1 >= maxPages) throw new WindowTooLarge();
    offset += result.transactions.length + result.skipped;
  }
  return { transactions, pending, skipped };
}

/**
 * Reads the next window of history for one linked account. Returns the rows to import and the checkpoint to store
 * once they are imported. The caller repeats until `caughtUp`.
 */
export async function readNextWindow(
  client: RedbarkClient,
  checkpoint: FeedCheckpoint,
  today: string,
  limits: WindowLimits = {},
): Promise<FeedWindow> {
  const { syncFrom } = checkpoint;
  const covered = checkpoint.coveredThrough;
  const resume = covered ? addDays(covered, 1) : syncFrom;
  const overlapStart = covered ? addDays(covered, -OVERLAP_DAYS) : syncFrom;
  let from = overlapStart < syncFrom ? syncFrom : overlapStart;
  let to = today;
  while (from <= to) {
    try {
      const window = await readPostedWindow(client, checkpoint, from, to, limits);
      const coveredThrough = covered && covered > to ? covered : to;
      return { from, to, ...window, coveredThrough, caughtUp: coveredThrough >= today };
    } catch (error) {
      if (!(error instanceof WindowTooLarge)) throw error;
      if (from < resume) {
        from = resume < syncFrom ? syncFrom : resume;
        continue;
      }
      if (from === to) {
        throw new RedbarkError(`The bank feed history for ${from} is too large to import in one go; it needs review.`);
      }
      to = addDays(from, Math.floor(daysBetween(from, to) / 2));
    }
  }
  // Nothing new to read: the import-from date is in the future, or only an oversized overlap remained.
  return { from, to, transactions: [], pending: 0, skipped: 0, coveredThrough: covered, caughtUp: covered !== null && covered >= today };
}
