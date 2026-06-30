const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function resolveXeroIdempotencyKey(
  candidate: unknown,
  fallbackParts: string[],
): Promise<string> {
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (UUID_RE.test(trimmed)) return trimmed;
  }

  return await stableUuid(fallbackParts.join(':'));
}

async function stableUuid(input: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)),
  ).slice(0, 16);

  // UUID-shaped deterministic key for DB compatibility and Xero retry safety.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
