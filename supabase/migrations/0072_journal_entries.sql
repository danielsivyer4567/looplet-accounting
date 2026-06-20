-- ============================================================================
-- 0072: Journal entries + journal lines (the double-entry ledger).
--
-- A journal_entry is a single balanced transaction (e.g. "raised invoice
-- INV-123"). Its journal_lines debit and credit chart_of_accounts rows. The
-- ledger invariant — total debits = total credits — is enforced at POST time
-- by post_journal_entry() (0073), not by a row constraint, because a draft
-- entry is allowed to be unbalanced while it is being built.
--
-- Per-line invariant (enforced here): a line touches exactly ONE side —
-- exactly one of debit_cents / credit_cents is non-zero, the other is zero.
-- Amounts are non-negative bigint cents (consistent with *_cents columns
-- elsewhere in the schema).
--
-- source_type / source_id are a soft link back to the originating domain row
-- (invoice, bill, payment_run, manual, ...) so we can trace a posting to what
-- produced it without a hard FK to a polymorphic target.
-- ============================================================================

-- -- journal_entry_status enum -----------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.journal_entry_status AS ENUM ('draft', 'posted', 'void');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- journal_entries ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entry_date date NOT NULL DEFAULT CURRENT_DATE,
  memo text,
  source_type text,                 -- 'invoice' | 'bill' | 'payment' | 'manual' | ...
  source_id uuid,                   -- soft link to the originating row
  status public.journal_entry_status NOT NULL DEFAULT 'draft',
  posted_at timestamptz,            -- set by post_journal_entry() (0073)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS journal_entries_org_idx
  ON public.journal_entries (organization_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS journal_entries_status_idx
  ON public.journal_entries (organization_id, status);
CREATE INDEX IF NOT EXISTS journal_entries_source_idx
  ON public.journal_entries (source_type, source_id)
  WHERE source_id IS NOT NULL;

COMMENT ON TABLE public.journal_entries IS
  'Header row for a double-entry transaction. Unbalanced while status=draft; post_journal_entry() (0073) verifies debits=credits and flips status to posted. source_type/source_id soft-link to the domain row that generated the entry.';

-- -- journal_lines -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.chart_of_accounts(id) ON DELETE RESTRICT,
  debit_cents bigint NOT NULL DEFAULT 0,
  credit_cents bigint NOT NULL DEFAULT 0,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Amounts are non-negative.
  CONSTRAINT journal_lines_amounts_nonneg
    CHECK (debit_cents >= 0 AND credit_cents >= 0),
  -- Exactly one side is non-zero (a line is either a debit or a credit).
  CONSTRAINT journal_lines_one_side
    CHECK ((debit_cents > 0)::int + (credit_cents > 0)::int = 1)
);

CREATE INDEX IF NOT EXISTS journal_lines_entry_idx
  ON public.journal_lines (journal_entry_id);
CREATE INDEX IF NOT EXISTS journal_lines_account_idx
  ON public.journal_lines (account_id);

COMMENT ON TABLE public.journal_lines IS
  'Individual debit/credit lines of a journal entry. Constraint journal_lines_one_side guarantees exactly one of debit_cents/credit_cents is non-zero. Sum of debits must equal sum of credits across an entry — enforced at post time, not per row.';

-- -- updated_at trigger on the header ---------------------------------------
DROP TRIGGER IF EXISTS trg_journal_entries_set_updated_at ON public.journal_entries;
CREATE TRIGGER trg_journal_entries_set_updated_at
  BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- RLS
--
-- journal_entries scope directly on organization_id (mirrors every other org
-- table). journal_lines have no organization_id of their own; they inherit
-- scope through their parent entry via an EXISTS on an accessible entry.
-- ============================================================================

ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS journal_entries_select ON public.journal_entries;
CREATE POLICY journal_entries_select ON public.journal_entries
  FOR SELECT USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS journal_entries_insert ON public.journal_entries;
CREATE POLICY journal_entries_insert ON public.journal_entries
  FOR INSERT WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS journal_entries_update ON public.journal_entries;
CREATE POLICY journal_entries_update ON public.journal_entries
  FOR UPDATE USING (organization_id IN (SELECT public.get_accessible_org_ids()))
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS journal_entries_delete ON public.journal_entries;
CREATE POLICY journal_entries_delete ON public.journal_entries
  FOR DELETE USING (organization_id IN (SELECT public.get_accessible_org_ids()));

ALTER TABLE public.journal_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS journal_lines_select ON public.journal_lines;
CREATE POLICY journal_lines_select ON public.journal_lines
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.journal_entries je
       WHERE je.id = journal_lines.journal_entry_id
         AND je.organization_id IN (SELECT public.get_accessible_org_ids())
    )
  );

DROP POLICY IF EXISTS journal_lines_insert ON public.journal_lines;
CREATE POLICY journal_lines_insert ON public.journal_lines
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.journal_entries je
       WHERE je.id = journal_lines.journal_entry_id
         AND je.organization_id IN (SELECT public.get_accessible_org_ids())
    )
  );

DROP POLICY IF EXISTS journal_lines_update ON public.journal_lines;
CREATE POLICY journal_lines_update ON public.journal_lines
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.journal_entries je
       WHERE je.id = journal_lines.journal_entry_id
         AND je.organization_id IN (SELECT public.get_accessible_org_ids())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.journal_entries je
       WHERE je.id = journal_lines.journal_entry_id
         AND je.organization_id IN (SELECT public.get_accessible_org_ids())
    )
  );

DROP POLICY IF EXISTS journal_lines_delete ON public.journal_lines;
CREATE POLICY journal_lines_delete ON public.journal_lines
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.journal_entries je
       WHERE je.id = journal_lines.journal_entry_id
         AND je.organization_id IN (SELECT public.get_accessible_org_ids())
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.journal_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.journal_lines TO authenticated;
