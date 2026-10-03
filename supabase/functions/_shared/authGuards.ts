// Caller checks for edge functions that are either backend-only or not tied to one organisation's books. Functions
// that act on an organisation use authorizeOrgCaller (orgRole.ts) instead.
import { isExactServiceRoleBearer } from './serviceRole.ts';
import type { OrgAccessDeps } from './orgRole.ts';

export type Caller = { kind: 'service' } | { kind: 'user'; userId: string };

export type CallerCheck =
  | { ok: true; caller: Caller }
  | { ok: false; status: 401 | 403; error: string };

const UNAUTHORIZED: CallerCheck = { ok: false, status: 401, error: 'Unauthorized' };

/** Only the exact service-role key: for functions that backend jobs call and users never should. */
export function requireServiceRole(authorization: string | null, serviceKey: string): CallerCheck {
  if (serviceKey && isExactServiceRoleBearer(authorization, serviceKey)) return { ok: true, caller: { kind: 'service' } };
  return UNAUTHORIZED;
}

/** A signed-in user (a valid user access token, not the public anon key) or the exact service-role key. */
export async function requireSignedInCaller(
  authorization: string | null,
  deps: Pick<OrgAccessDeps, 'serviceKey' | 'userIdFromJwt'>,
): Promise<CallerCheck> {
  if (deps.serviceKey && isExactServiceRoleBearer(authorization, deps.serviceKey)) {
    return { ok: true, caller: { kind: 'service' } };
  }
  const jwt = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return UNAUTHORIZED;
  const userId = await deps.userIdFromJwt(jwt);
  return userId ? { ok: true, caller: { kind: 'user', userId } } : UNAUTHORIZED;
}

/** A caller-supplied count clamped to [min, max]; anything that is not a finite integer uses the fallback. */
export function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
