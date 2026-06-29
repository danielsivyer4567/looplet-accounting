import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const runFunction = readFileSync(
  join(root, 'supabase/functions/legal-horizon-run/index.ts'),
  'utf8',
);
const config = readFileSync(join(root, 'supabase/config.toml'), 'utf8');

describe('legal-horizon-run security posture', () => {
  it('keeps JWT verification enabled for the browser-invoked scan trigger', () => {
    expect(config).toMatch(/\[functions\.legal-horizon-run\][\s\S]*verify_jwt\s*=\s*true/i);
  });

  it('requires a signed-in accountant, admin, or owner before proxying the scan', () => {
    expect(runFunction).toMatch(/auth\.getUser\(\)/i);
    expect(runFunction).toMatch(/organization_memberships/i);
    expect(runFunction).toMatch(/\.not\('accepted_at',\s*'is',\s*null\)/i);
    expect(runFunction).toMatch(/accountant/i);
    expect(runFunction).toMatch(/admin/i);
    expect(runFunction).toMatch(/owner/i);
  });

  it('does not forward user-supplied scanner overrides to the backend-only scan function', () => {
    expect(runFunction).toMatch(/body:\s*JSON\.stringify\(\{\}\)/i);
    expect(runFunction).not.toMatch(/await req\.json/i);
    expect(runFunction).not.toMatch(/Deno\.env\.get\(["']LEGAL_SCAN_SECRET["']\)/i);
  });
});
