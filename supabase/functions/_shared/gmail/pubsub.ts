export interface GmailPubSubIngestResult {
  rejected: { reason: string }[];
}

const RETRYABLE_REJECTION_PREFIXES = [
  'storage ',
  'bill insert ',
  // A failed job enqueue rolls the bill back (see ingest paths), so a replay must
  // re-create + re-enqueue it rather than treating the message as durably processed.
  'bill_extract enqueue ',
  // A failed intake-rule lookup bails before any insert; replay re-evaluates the rules.
  'rule lookup ',
];
const RETRYABLE_HTTP_STATUSES = new Set([401, 403, 429]);

export function hasRetryableGmailIngestFailure(result: GmailPubSubIngestResult): boolean {
  return result.rejected.some((item) => isRetryableGmailRejection(item.reason));
}

function isRetryableGmailRejection(reason: string): boolean {
  const httpMatch = reason.match(/^(fetch|attachment fetch) (\d{3})$/);
  if (httpMatch) {
    const status = Number(httpMatch[2]);
    return RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
  }
  return RETRYABLE_REJECTION_PREFIXES.some((prefix) => reason.startsWith(prefix));
}
