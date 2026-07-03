export type ErrorKind = 'auth' | 'rls' | 'network' | 'validation' | 'database';

export function classifyError(message: string): ErrorKind {
  const m = message.toLowerCase();
  if (/(jwt|auth|not signed|permission denied|401|403|unauthorized|forbidden)/.test(m)) {
    return 'auth';
  }
  if (/(row-level security|rls|policy|violates row-level)/.test(m)) {
    return 'rls';
  }
  if (/(network|failed to fetch|fetch failed|timeout|timed out|connection|offline)/.test(m)) {
    return 'network';
  }
  if (
    /(invalid|validation|constraint|not-null|null value|check violation|23502|23503|23505)/.test(m)
  ) {
    return 'validation';
  }
  return 'database';
}

const PREFIX_BY_KIND: Record<ErrorKind, string> = {
  auth: 'Authentication or permission issue',
  rls: 'Access policy blocked this request',
  network: 'Network or server connection issue',
  validation: 'Data validation issue',
  database: 'Database query failed',
};

export function formatLoadError(resource: string, error: string): string {
  const detail = error.trim() || 'No error detail returned.';
  return `Could not load ${resource}. ${PREFIX_BY_KIND[classifyError(detail)]}: ${detail}`;
}

export function formatActionError(action: string, error: string): string {
  const detail = error.trim() || 'No error detail returned.';
  return `Could not ${action}. ${PREFIX_BY_KIND[classifyError(detail)]}: ${detail}`;
}
