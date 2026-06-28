export interface GmailPubSubIngestResult {
  rejected: { reason: string }[];
}

const RETRYABLE_REJECTION_PREFIXES = ['storage ', 'bill insert '];
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
