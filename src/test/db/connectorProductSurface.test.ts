import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function readRepoFile(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

describe('connector product surface contract', () => {
  it('keeps the Settings UI on the RPC lifecycle and away from stored secrets', () => {
    const component = readRepoFile('src/components/settings/ApiKeys.tsx');
    const settings = readRepoFile('src/pages/Settings.tsx');

    expect(settings).toMatch(/<ApiKeys \/>/);
    expect(component).toMatch(/from\('api_keys'\)/);
    expect(component).toMatch(/from\('api_request_log'\)/);
    expect(component).toMatch(/rpc\('issue_api_key'/);
    expect(component).toMatch(/rpc\('revoke_api_key'/);
    expect(component).toMatch(/API_KEY_COLUMNS[\s\S]*key_prefix/);
    expect(component).not.toMatch(/hashed_key/);
  });

  it('documents the connector JWT as SELECT-only role=connector, not authenticated', () => {
    const openapi = readRepoFile('docs/openapi.yaml');
    const gateway = readRepoFile('supabase/functions/api-gateway/index.ts');
    const ingest = readRepoFile('supabase/functions/ingest/index.ts');

    expect(openapi).toMatch(/role=connector/);
    expect(openapi).toMatch(/SELECT-only connector role denies\s+direct PostgREST writes/);
    expect(openapi).not.toMatch(/role=authenticated/);
    expect(gateway).toMatch(/export const CONNECTOR_ROLE = "connector"/);
    expect(ingest).toMatch(/api-gateway mints a `role=connector`/);
    expect(ingest).not.toMatch(/mints a `role=authenticated`/);
  });

  it('keeps API-key storage hardened behind grants and admin issuance', () => {
    const hardening = readRepoFile('supabase/migrations/0208_api_key_hardening.sql');
    const connectorRole = readRepoFile('supabase/migrations/0205_connector_hardening.sql');

    expect(connectorRole).toMatch(/CREATE ROLE connector NOLOGIN NOINHERIT/);
    expect(connectorRole).toMatch(/GRANT SELECT ON ALL TABLES IN SCHEMA public TO connector/);
    expect(connectorRole).toMatch(/REVOKE INSERT, UPDATE, DELETE/);
    expect(hardening).toMatch(
      /REVOKE SELECT \(hashed_key\) ON public\.api_keys FROM authenticated/,
    );
    expect(hardening).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON public\.api_keys FROM authenticated/,
    );
    expect(hardening).toMatch(/require_role\(p_organization_id, 'admin'::org_role\)/);
  });
});
