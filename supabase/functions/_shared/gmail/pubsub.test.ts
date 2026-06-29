import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { hasRetryableGmailIngestFailure } from './pubsub.ts';

Deno.test('hasRetryableGmailIngestFailure retries external fetch/storage/write failures', () => {
  assertEquals(
    hasRetryableGmailIngestFailure({
      rejected: [
        { reason: 'no real PDF/image invoice attachments (filtered logos/icons)' },
        { reason: 'fetch 503' },
      ],
    }),
    true,
  );

  assertEquals(
    hasRetryableGmailIngestFailure({
      rejected: [{ reason: 'attachment fetch 429' }],
    }),
    true,
  );

  assertEquals(
    hasRetryableGmailIngestFailure({
      rejected: [{ reason: 'storage bucket unavailable' }],
    }),
    true,
  );

  assertEquals(
    hasRetryableGmailIngestFailure({
      rejected: [{ reason: 'bill insert duplicate key value violates unique constraint' }],
    }),
    true,
  );
});

Deno.test('hasRetryableGmailIngestFailure treats filtered mail as durably processed', () => {
  assertEquals(
    hasRetryableGmailIngestFailure({
      rejected: [
        { reason: 'sender newsletters@example.com not in allowlist' },
        { reason: 'intake_rule says personal — skipped' },
        { reason: 'no real PDF/image invoice attachments (filtered logos/icons)' },
      ],
    }),
    false,
  );

  assertEquals(
    hasRetryableGmailIngestFailure({
      rejected: [{ reason: 'fetch 404' }],
    }),
    false,
  );
});
