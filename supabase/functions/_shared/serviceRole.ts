export function isExactServiceRoleBearer(
  authorizationHeader: string | null,
  serviceRoleKey: string,
): boolean {
  const bearer = (authorizationHeader ?? '').replace(/^Bearer\s+/i, '').trim();
  return safeEqual(bearer, serviceRoleKey);
}

export function isExactSecret(value: string | null, expected: string): boolean {
  return safeEqual(value ?? '', expected);
}

function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
