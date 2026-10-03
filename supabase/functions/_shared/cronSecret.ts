// Scheduled callers (pg_cron via pg_net, operators) authenticate with a scoped secret sent in the
// X-Cron-Secret header. Secrets in URLs end up in function invocation logs, proxy logs and
// cron.job_run_details, so the cron jobs moved to the header in migration 20261003160000.
//
// ROLLOUT: the old ?secret= query form is still accepted for ONE release, so jobs scheduled before
// that migration (or outside migrations, from the dashboard) keep running between the function
// deploy and the migration, and until an operator moves them. Each use logs a warning naming the
// function. Remove the query fallback (LEGACY_QUERY_PARAM) in the release after 2026-10.
import { isExactSecret } from './serviceRole.ts';

export const CRON_SECRET_HEADER = 'X-Cron-Secret';
const LEGACY_QUERY_PARAM = 'secret';

/** The secret a scheduled caller presented: the header if sent, else the legacy query parameter. */
export function presentedCronSecret(req: Request): string | null {
  const header = req.headers.get(CRON_SECRET_HEADER);
  if (header) return header;
  const url = new URL(req.url);
  const legacy = url.searchParams.get(LEGACY_QUERY_PARAM);
  if (legacy) {
    console.warn(
      `[cron] ${url.pathname} was called with the secret in the URL; send it in the ${CRON_SECRET_HEADER} header instead (the URL form is accepted for one more release).`,
    );
  }
  return legacy;
}

/** Constant-time check of the presented cron secret. An unset expected secret never matches. */
export function hasCronSecret(req: Request, expected: string | null | undefined): boolean {
  if (!expected) return false;
  return isExactSecret(presentedCronSecret(req), expected);
}
