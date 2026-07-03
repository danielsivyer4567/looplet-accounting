import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

const draftRpc = readFileSync(
  join(root, 'supabase/migrations/20260702110000_bas_lodgement_draft_rpc.sql'),
  'utf8',
);
const basHook = readFileSync(join(root, 'src/hooks/useBasWorksheet.ts'), 'utf8');

describe('BAS lodgement draft contract', () => {
  it('creates a durable lodgement draft and opens approval against that row', () => {
    expect(draftRpc).toMatch(/create or replace function public\.prepare_bas_lodgement_draft/i);
    expect(draftRpc).toMatch(/security definer/i);
    expect(draftRpc).toMatch(/public\.require_role\(p_org, 'accountant'::public\.org_role\)/i);
    expect(draftRpc).toMatch(/v_payload := public\.generate_bas_worksheet\(p_org, p_fy_start_year, p_quarter\)/i);
    expect(draftRpc).toMatch(/v_payload_hash := encode\(extensions\.digest\(v_payload::text, 'sha256'\), 'hex'\)/i);
    expect(draftRpc).toMatch(/insert into public\.lodgements/i);
    expect(draftRpc).toMatch(/'bas'::public\.lodgement_type/i);
    expect(draftRpc).toMatch(/'draft'::public\.lodgement_status/i);
    expect(draftRpc).toMatch(/exception when unique_violation/i);
    expect(draftRpc).toMatch(/public\.request_approval\([\s\S]*'bas_lodgement'[\s\S]*v_lodgement_id[\s\S]*v_payload/i);
    expect(draftRpc).toMatch(/revoke all on function public\.prepare_bas_lodgement_draft[\s\S]*from public, anon/i);
  });

  it('routes the BAS UI approval action through the draft RPC, not raw request_approval', () => {
    expect(basHook).toMatch(/supabase\.rpc\('prepare_bas_lodgement_draft'/);
    expect(basHook).toMatch(/p_fy_start_year: fyStartYear/);
    expect(basHook).toMatch(/p_quarter: quarter/);
    expect(basHook).not.toMatch(/supabase\.rpc\('request_approval'/);
    expect(basHook).not.toMatch(/p_resource_id: currentOrg\.id/);
  });
});
