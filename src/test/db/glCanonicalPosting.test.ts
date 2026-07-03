import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static SQL assertions for migration 0215_gl_canonical_posting.
 *
 * No DB is available in this worktree, so these tests prove the migration text
 * adds the canonical posting RPC, durable idempotency/source provenance, locked
 * period rejection, balanced-line validation, and a date-scoped trial balance
 * surface. Live behavioural proof remains deploy-gated.
 */
const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/0215_gl_canonical_posting.sql',
);
const sql = readFileSync(migrationPath, 'utf8');
const flat = sql.replace(/\s+/g, ' ');

const createPostingFn =
  flat.match(
    /CREATE OR REPLACE FUNCTION public\.create_and_post_journal\([\s\S]*?COMMENT ON FUNCTION public\.create_and_post_journal/,
  )?.[0] ?? '';

const trialBalanceFn =
  flat.match(
    /CREATE OR REPLACE FUNCTION public\.trial_balance_by_period\([\s\S]*?COMMENT ON FUNCTION public\.trial_balance_by_period/,
  )?.[0] ?? '';

describe('0215 GL canonical posting migration', () => {
  it('is wrapped in a single transaction', () => {
    expect(sql).toMatch(/\bBEGIN;/);
    expect(sql).toMatch(/\bCOMMIT;\s*$/);
  });

  it('adds durable journal source-event/idempotency columns and a per-org unique key', () => {
    expect(flat).toMatch(/ADD COLUMN IF NOT EXISTS idempotency_key text/);
    expect(flat).toMatch(/ADD COLUMN IF NOT EXISTS source_event_key text/);
    expect(flat).toMatch(
      /ADD COLUMN IF NOT EXISTS source_metadata jsonb NOT NULL DEFAULT '\{\}'::jsonb/,
    );
    expect(flat).toMatch(/journal_entries_source_event_key_requires_source/);
    expect(flat).toMatch(/journal_entries_source_event_key_matches_fields/);
    expect(flat).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_org_source_event_key_uniq ON public\.journal_entries \(organization_id, source_event_key\) WHERE source_event_key IS NOT NULL/,
    );
  });

  it('defines create_and_post_journal as the canonical invoker RPC with source fields', () => {
    expect(createPostingFn).toMatch(/CREATE OR REPLACE FUNCTION public\.create_and_post_journal\(/);
    expect(createPostingFn).toMatch(/p_organization_id uuid/);
    expect(createPostingFn).toMatch(/p_entry_date date/);
    expect(createPostingFn).toMatch(/p_source_type text/);
    expect(createPostingFn).toMatch(/p_source_id uuid/);
    expect(createPostingFn).toMatch(/p_idempotency_key text/);
    expect(createPostingFn).toMatch(/p_lines jsonb/);
    expect(createPostingFn).toMatch(/SECURITY INVOKER/);
    expect(createPostingFn).not.toMatch(/SECURITY DEFINER/);
  });

  it('guards organization access through get_accessible_org_ids for human and org-claim callers', () => {
    expect(createPostingFn).toMatch(
      /p_organization_id NOT IN \(SELECT public\.get_accessible_org_ids\(\)\)/,
    );
    expect(createPostingFn).toMatch(/not authorized to create journal entry for org/);
    expect(flat).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.create_and_post_journal\(uuid, date, text, uuid, text, jsonb, text, jsonb\) TO authenticated, service_role;/,
    );
  });

  it('rejects locked periods using the existing period_locks predicate', () => {
    expect(createPostingFn).toMatch(/FROM public\.period_locks pl/);
    expect(createPostingFn).toMatch(/pl\.unlocked_at IS NULL/);
    expect(createPostingFn).toMatch(/p_entry_date BETWEEN pl\.period_start AND pl\.period_end/);
    expect(createPostingFn).toMatch(/period is locked/);
    expect(createPostingFn).toMatch(/ERRCODE = 'check_violation'/);
  });

  it('validates line shape and balanced debits before posting', () => {
    expect(createPostingFn).toMatch(/jsonb_to_recordset\(p_lines\)/);
    expect(createPostingFn).toMatch(/SUM\(debit_cents\)/);
    expect(createPostingFn).toMatch(/SUM\(credit_cents\)/);
    expect(createPostingFn).toMatch(/v_debits <> v_credits/);
    expect(createPostingFn).toMatch(/journal entry is unbalanced/);
    expect(createPostingFn).toMatch(
      /\(debit_cents > 0\)::integer \+ \(credit_cents > 0\)::integer\) <> 1/,
    );
  });

  it('dedupes retries by source_event_key instead of duplicating journal entries', () => {
    expect(createPostingFn).toMatch(
      /v_source_event_key := v_source_type \|\| ':' \|\| COALESCE\(p_source_id::text, 'no-source-id'\) \|\| ':' \|\| v_idempotency_key/,
    );
    expect(createPostingFn).toMatch(
      /source_type, source_id, idempotency_key, source_event_key, source_metadata, status/,
    );
    expect(createPostingFn).toMatch(
      /ON CONFLICT \(organization_id, source_event_key\) WHERE source_event_key IS NOT NULL DO NOTHING/,
    );
    expect(createPostingFn).toMatch(
      /WHERE organization_id = p_organization_id AND source_event_key = v_source_event_key FOR UPDATE/,
    );
  });

  it('delegates final posting to the existing post_journal_entry primitive', () => {
    expect(createPostingFn).toMatch(/v_entry := public\.post_journal_entry\(v_entry\.id\)/);
    expect(flat).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.post_journal_entry\(uuid\) TO authenticated, service_role;/,
    );
  });

  it('extends posted-entry immutability to the new provenance columns', () => {
    expect(flat).toMatch(/CREATE OR REPLACE FUNCTION public\.guard_posted_journal_entry\(\)/);
    expect(flat).toMatch(/NEW\.idempotency_key IS DISTINCT FROM OLD\.idempotency_key/);
    expect(flat).toMatch(/NEW\.source_event_key IS DISTINCT FROM OLD\.source_event_key/);
    expect(flat).toMatch(/NEW\.source_metadata IS DISTINCT FROM OLD\.source_metadata/);
  });

  it('adds a date-scoped trial balance function without replacing v_trial_balance', () => {
    expect(trialBalanceFn).toMatch(/CREATE OR REPLACE FUNCTION public\.trial_balance_by_period\(/);
    expect(trialBalanceFn).toMatch(/p_period_start date DEFAULT NULL/);
    expect(trialBalanceFn).toMatch(/p_period_end date DEFAULT CURRENT_DATE/);
    expect(trialBalanceFn).toMatch(/SECURITY INVOKER/);
    expect(flat).not.toMatch(/CREATE OR REPLACE VIEW public\.v_trial_balance\b/);
  });

  it('trial_balance_by_period supports opening, period movement, and as-of closing balances', () => {
    expect(trialBalanceFn).toMatch(/je\.status = 'posted'/);
    expect(trialBalanceFn).toMatch(
      /p\.period_start IS NOT NULL AND je\.entry_date < p\.period_start/,
    );
    expect(trialBalanceFn).toMatch(
      /\(p\.period_start IS NULL OR je\.entry_date >= p\.period_start\) AND je\.entry_date <= p\.period_end/,
    );
    expect(trialBalanceFn).toMatch(/je\.entry_date <= p\.period_end/);
    expect(trialBalanceFn).toMatch(/opening_net_cents/);
    expect(trialBalanceFn).toMatch(/period_net_cents/);
    expect(trialBalanceFn).toMatch(/closing_net_cents/);
  });

  it('reloads PostgREST schema cache for the new RPC/function surfaces', () => {
    expect(flat).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});
