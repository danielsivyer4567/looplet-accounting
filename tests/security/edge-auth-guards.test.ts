import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Wiring checks for the caller guards in four edge functions. The guards' behaviour is tested in Deno
// (supabase/functions/_shared/authGuards.test.ts, orgRole via intake-routing-apply/auth.test.ts and
// ato-lodge/index.test.ts); these tests prove each function calls its guard before it reads data or spends credit.
const source = (fn: string) => readFileSync(`supabase/functions/${fn}/index.ts`, 'utf8');

function at(src: string, needle: string): number {
  const index = src.indexOf(needle);
  expect(index, `expected to find ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('edge functions check the caller before reading data or spending credit', () => {
  it('staged-entities-enrich-sonar needs an accepted accountant-or-higher member and caps batch sizes', () => {
    const src = source('staged-entities-enrich-sonar');
    const guard = at(src, 'authorizeOrgCaller(');
    expect(src.slice(guard, at(src, 'if (!access.ok) return'))).toMatch(/body\.organization_id[\s\S]*'accountant'/);
    expect(guard).toBeLessThan(at(src, ".from('intake_categories')"));
    expect(guard).toBeLessThan(at(src, '.from(\'staged_entities\')'));
    expect(guard).toBeLessThan(src.indexOf('classifyWithSonar(', at(src, 'Deno.serve(')));
    expect(src).toContain('boundedInt(body.batch_size, 15, 1, 25)');
    expect(src).toContain('boundedInt(body.max_batches, 4, 1, 10)');
    expect(src).not.toMatch(/body\.(batch_size|max_batches) \?\?/);
    // Model-returned row ids are limited to the batch, and every write is scoped to the organisation.
    expect(src).toContain('if (!batchIds.has(r.id)) {');
    const writes = [...src.matchAll(/\.from\('staged_entities'\)\s*\.update\([\s\S]*?;/g)].map((m) => m[0]);
    expect(writes.length).toBe(2);
    for (const write of writes) expect(write).toContain(".eq('organization_id', body.organization_id)");
  });

  it('bank-statement-extract needs a signed-in user, not just any Authorization header, and limits the image size', () => {
    const src = source('bank-statement-extract');
    const guard = at(src, 'requireSignedInCaller(');
    expect(src).not.toMatch(/if \(!authHeader\) return/);
    expect(guard).toBeLessThan(at(src, "Deno.env.get('GROQ_API_KEY')"));
    expect(guard).toBeLessThan(at(src, 'await req.json()'));
    expect(at(src, 'body.image_base64.length > MAX_IMAGE_BASE64_CHARS')).toBeLessThan(at(src, 'fetch(`${baseUrl}/chat/completions`'));
  });

  it('crm-pnl-sync-push accepts only the service role, before it reads the organisation or calls the CRM', () => {
    const src = source('crm-pnl-sync-push');
    const guard = at(src, "requireServiceRole(req.headers.get('Authorization'), serviceKey)");
    expect(guard).toBeLessThan(at(src, 'await req.json()'));
    expect(guard).toBeLessThan(at(src, ".from('organizations')"));
    expect(guard).toBeLessThan(at(src, 'fetch(endpointUrl'));
  });

  it('ato-lodge authorises the caller before parsing the request or reporting configuration health', () => {
    const src = source('ato-lodge');
    const handler = at(src, 'export async function handleAtoLodge(');
    const guard = src.indexOf('await authorize(req.headers.get("Authorization"))', handler);
    expect(guard).toBeGreaterThan(handler);
    expect(guard).toBeLessThan(at(src, 'await req.json()'));
    expect(guard).toBeLessThan(at(src, 'atoConfigHealth(env)'));
    expect(src).toMatch(/handleAtoLodge\(req, Deno\.env, \(authorization\) => requireSignedInCaller\(authorization, deps\)\)/);
  });
});
