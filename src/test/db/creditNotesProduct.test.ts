import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const sql = readFileSync(join(root, 'supabase/migrations/0229_credit_notes_product.sql'), 'utf8');
const hook = readFileSync(join(root, 'src/hooks/useCreditNotes.ts'), 'utf8');
const page = readFileSync(join(root, 'src/pages/CreditNotes.tsx'), 'utf8');
const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');
const layout = readFileSync(join(root, 'src/components/Layout.tsx'), 'utf8');

describe('0229 credit notes product workflow', () => {
  it('adds source-linked AR/AP credit-note document tables', () => {
    expect(sql).toMatch(/CREATE TYPE public\.credit_note_status/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.customer_credit_notes/);
    expect(sql).toMatch(/invoice_id uuid NOT NULL REFERENCES public\.invoices/);
    expect(sql).toMatch(/journal_entry_id uuid REFERENCES public\.journal_entries/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.supplier_credit_notes/);
    expect(sql).toMatch(/bill_id uuid NOT NULL REFERENCES public\.bills/);
    expect(sql).toMatch(/counter_account_type public\.account_type NOT NULL/);
  });

  it('keeps writes on RPC-only role-gated posting paths', () => {
    expect(sql).toMatch(
      /REVOKE ALL ON public\.customer_credit_notes FROM PUBLIC, anon, authenticated/,
    );
    expect(sql).toMatch(/GRANT SELECT ON public\.customer_credit_notes TO authenticated/);
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/require_role\(p_organization_id, 'accountant'::public\.org_role\)/);
    expect(sql).toMatch(/post_customer_credit_note_journal/);
    expect(sql).toMatch(/post_supplier_credit_note_journal/);
    expect(sql).toMatch(/journal_entry_id = v_entry\.id/);
  });

  it('exposes the credit-note UI route and sidebar entry', () => {
    expect(hook).toMatch(/from\('customer_credit_notes'/);
    expect(hook).toMatch(/rpc\('create_customer_credit_note'/);
    expect(hook).toMatch(/rpc\('create_supplier_credit_note'/);
    expect(page).toMatch(/Post credit note/);
    expect(app).toMatch(/path="credit-notes"/);
    expect(layout).toMatch(/to: '\/credit-notes', label: 'Credits'/);
  });
});
