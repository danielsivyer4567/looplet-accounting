import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const sql = readFileSync(join(root, 'supabase/migrations/0228_superstream_transport.sql'), 'utf8');
const sendFn = readFileSync(join(root, 'supabase/functions/super-batch-send/index.ts'), 'utf8');

describe('0228 SuperStream transport migration', () => {
  it('adds employee fund accounts and enriches super batch lines', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.employee_super_fund_accounts/);
    expect(sql).toMatch(/fund_usi text NOT NULL/);
    expect(sql).toMatch(/member_number text NOT NULL/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS employee_super_fund_one_default_idx/);
    expect(sql).toMatch(/WHERE is_default IS TRUE/);
    expect(sql).toMatch(/ALTER TABLE public\.super_batch_lines/);
    expect(sql).toMatch(/validation_errors jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
    expect(sql).toMatch(/employee_super_fund_accounts_select/);
  });

  it('rebuilds generate_super_batch with fund-detail validation', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.generate_super_batch/);
    expect(sql).toMatch(/LEFT JOIN public\.employee_super_fund_accounts/);
    expect(sql).toMatch(/missing default super fund account/);
    expect(sql).toMatch(/missing fund USI/);
    expect(sql).toMatch(/missing member number/);
  });

  it('builds a documented clearing-house payload without pretending live dispatch', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.build_superstream_payload/);
    expect(sql).toMatch(/'mode', 'clearing_house_file'/);
    expect(sql).toMatch(/'live_dispatch_enabled', false/);
    expect(sql).toMatch(/ready_for_external_upload/);
    expect(sql).toMatch(/build_superstream_payload:v1/);
  });

  it('updates super-batch-send from mark-sent stub to approved export lifecycle', () => {
    expect(sendFn).toMatch(/build_superstream_payload/);
    expect(sendFn).toMatch(/ready_for_external_upload/);
    expect(sendFn).toMatch(/transport_payload_hash/);
    expect(sendFn).toMatch(/clearing_house_file/);
    expect(sendFn).not.toMatch(/MARK-SENT STUB/);
  });
});
