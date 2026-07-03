import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const sql = readFileSync(join(root, 'supabase/migrations/0230_advisor_work_proofs.sql'), 'utf8');

describe('0230 advisor work proofs', () => {
  it('creates a durable proof table with org/user lookup indexes and RLS', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.advisor_work_proofs/i);
    expect(sql).toMatch(/snapshot_hash text NOT NULL/i);
    expect(sql).toMatch(/advisor_work_proofs_org_time_idx/i);
    expect(sql).toMatch(/advisor_work_proofs_user_time_idx/i);
    expect(sql).toMatch(/ALTER TABLE public\.advisor_work_proofs ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/CREATE POLICY advisor_work_proofs_select/i);
  });

  it('keeps internal saves server-compiled instead of direct client inserts', () => {
    expect(sql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON public\.advisor_work_proofs FROM authenticated/i,
    );
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.finish_advisor_work_session/i);
    expect(sql).toMatch(/SECURITY DEFINER/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.finish_advisor_work_session/i);
  });

  it('gates the finish proof to external-advisor-capable roles', () => {
    expect(sql).toMatch(/v_role NOT IN \('accountant', 'admin', 'owner'\)/i);
    expect(sql).toMatch(/accountant role required/i);
    expect(sql).toMatch(/m\.accepted_at IS NOT NULL/i);
  });

  it('persists a hashable snapshot from sessions, activity, and audit rows', () => {
    expect(sql).toMatch(/FROM public\.accountant_sessions/i);
    expect(sql).toMatch(/FROM public\.accountant_activity_log/i);
    expect(sql).toMatch(/FROM public\.audit_log/i);
    expect(sql).toMatch(/jsonb_build_object\(\s*'schema_version', 1/i);
    expect(sql).toMatch(/digest\(v_snapshot::text, 'sha256'\)/i);
    expect(sql).toMatch(/INSERT INTO public\.advisor_work_proofs/i);
  });

  it('adds a smarter proof summary for path counts, risk flags, and billing evidence', () => {
    expect(sql).toMatch(/'path_counts', v_path_counts/i);
    expect(sql).toMatch(/'event_type_counts', v_event_type_counts/i);
    expect(sql).toMatch(/'risk_flags', v_risk_flags/i);
    expect(sql).toMatch(/'invoice_seed'/i);
    expect(sql).toMatch(/Advisor work proof/i);
  });
});
