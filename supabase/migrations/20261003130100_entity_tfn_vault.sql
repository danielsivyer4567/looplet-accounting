-- ============================================================================
-- Migration: 20261003130100_entity_tfn_vault
-- Purpose:   Trust, beneficiary, family trust election, SMSF fund and SMSF member
--            TFNs are no longer stored in plain text or readable from the browser.
--
-- Before:    trusts.tfn, trust_beneficiaries.tfn, family_trust_elections
--            .test_individual_tfn, smsf_funds.tfn and smsf_members.tfn were plain
--            text columns readable by every org member under RLS, and the audit
--            trigger copied each value into audit_log (before/after/changes),
--            which every org member can also read.
--
-- After:
--   1. entity_tfn_vault holds those TFNs AES-GCM encrypted (by the entity-tfn-save
--      edge function, with the same helper and key as employee_tfn_vault) plus the
--      last four digits. No client access; service role only. A CHECK rejects
--      anything that is not ciphertext-shaped, so a plain TFN cannot be written to it.
--   2. The SQL here cannot encrypt (the key lives only in the edge runtime), so
--      quarantine_plaintext_tfns() moves existing plain values into
--      entity_tfn_legacy_plaintext (service role only, not audited) and clears the
--      columns. The entity-tfn-backfill edge function then encrypts each one into
--      the vault and deletes it; run it once after deploying. Idempotent.
--   3. quarantine_plaintext_tfns() also redacts TFN values already copied into
--      audit_log. audit_log is append-only; its guard trigger is disabled only for
--      that UPDATE inside this transaction and re-enabled before it ends.
--   4. CHECK constraints keep the five plain columns NULL from now on, for every
--      role, so plain text cannot be written again.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Encrypted vault
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entity_tfn_vault (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_table    text NOT NULL CHECK (entity_table IN (
                    'trusts', 'trust_beneficiaries', 'family_trust_elections', 'smsf_funds', 'smsf_members')),
  entity_id       uuid NOT NULL,
  -- base64(iv || ciphertext || tag) from _shared/xero/crypto.ts: at least 40 base64 characters. A TFN is 8 or 9
  -- digits, so a plain TFN (with or without spaces) can never satisfy this.
  tfn_encrypted   text NOT NULL CONSTRAINT entity_tfn_vault_ciphertext_only
                    CHECK (tfn_encrypted ~ '^[A-Za-z0-9+/]{40,}={0,2}$'),
  tfn_last4       text NOT NULL CHECK (tfn_last4 ~ '^[0-9]{4}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id),
  updated_by      uuid REFERENCES auth.users(id),
  CONSTRAINT entity_tfn_vault_one_per_entity UNIQUE (entity_table, entity_id)
);

COMMENT ON TABLE public.entity_tfn_vault IS
  'Encrypted TFNs for trusts, beneficiaries, family trust election test individuals, SMSF funds and members. '
  'Written only by the entity-tfn-save and entity-tfn-backfill edge functions; no client access.';

CREATE INDEX IF NOT EXISTS entity_tfn_vault_org_idx
  ON public.entity_tfn_vault (organization_id, entity_table, entity_id);

-- The entity must exist in the named table and belong to the same organisation.
CREATE OR REPLACE FUNCTION public.entity_tfn_vault_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ok boolean;
BEGIN
  -- BEFORE triggers run ahead of CHECK constraints: refuse any other table before looking anything up.
  IF NEW.entity_table IS NULL OR NEW.entity_table NOT IN (
       'trusts', 'trust_beneficiaries', 'family_trust_elections', 'smsf_funds', 'smsf_members') THEN
    RAISE EXCEPTION 'entity_tfn_vault cannot hold a TFN for %', coalesce(NEW.entity_table, 'NULL')
      USING ERRCODE = 'check_violation';
  END IF;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1 AND organization_id = $2)', NEW.entity_table
  ) INTO v_ok USING NEW.entity_id, NEW.organization_id;
  IF NOT v_ok THEN
    RAISE EXCEPTION '% % does not belong to organization %', NEW.entity_table, NEW.entity_id, NEW.organization_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS entity_tfn_vault_guard ON public.entity_tfn_vault;
CREATE TRIGGER entity_tfn_vault_guard
  BEFORE INSERT OR UPDATE ON public.entity_tfn_vault
  FOR EACH ROW EXECUTE FUNCTION public.entity_tfn_vault_guard();

ALTER TABLE public.entity_tfn_vault ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entity_tfn_vault_service_only ON public.entity_tfn_vault;
CREATE POLICY entity_tfn_vault_service_only ON public.entity_tfn_vault
  FOR ALL USING (false) WITH CHECK (false);
REVOKE ALL ON public.entity_tfn_vault FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.entity_tfn_vault TO service_role;
REVOKE ALL ON FUNCTION public.entity_tfn_vault_guard() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Temporary holding table for plain values awaiting encryption
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entity_tfn_legacy_plaintext (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_table    text NOT NULL CHECK (entity_table IN (
                    'trusts', 'trust_beneficiaries', 'family_trust_elections', 'smsf_funds', 'smsf_members')),
  entity_id       uuid NOT NULL,
  tfn_plaintext   text NOT NULL,
  moved_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_tfn_legacy_plaintext_one_per_entity UNIQUE (entity_table, entity_id)
);

COMMENT ON TABLE public.entity_tfn_legacy_plaintext IS
  'TEMPORARY. Plain TFNs moved out of client-readable columns by 20261003130100, awaiting encryption by the '
  'entity-tfn-backfill edge function, which deletes each row once its TFN is in entity_tfn_vault. Service role only '
  'and deliberately not audited. Drop this table once it is empty.';

ALTER TABLE public.entity_tfn_legacy_plaintext ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entity_tfn_legacy_plaintext_service_only ON public.entity_tfn_legacy_plaintext;
CREATE POLICY entity_tfn_legacy_plaintext_service_only ON public.entity_tfn_legacy_plaintext
  FOR ALL USING (false) WITH CHECK (false);
-- The service role (entity-tfn-backfill, entity-tfn-save) can read and clear waiting rows, never add plain values.
REVOKE ALL ON public.entity_tfn_legacy_plaintext FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, DELETE ON public.entity_tfn_legacy_plaintext TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Redaction of TFN values inside JSON (used on audit_log copies)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redact_tfn_jsonb(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text;
  v_val jsonb;
  v_out jsonb;
BEGIN
  IF p IS NULL THEN
    RETURN NULL;
  ELSIF jsonb_typeof(p) = 'array' THEN
    SELECT coalesce(jsonb_agg(public.redact_tfn_jsonb(e) ORDER BY i), '[]'::jsonb)
      INTO v_out FROM jsonb_array_elements(p) WITH ORDINALITY AS t(e, i);
    RETURN v_out;
  ELSIF jsonb_typeof(p) <> 'object' THEN
    RETURN p;
  END IF;
  v_out := '{}'::jsonb;
  FOR v_key, v_val IN SELECT key, value FROM jsonb_each(p) LOOP
    IF v_key IN ('tfn', 'test_individual_tfn', 'tax_file_number', 'taxFileNumber')
       AND v_val <> 'null'::jsonb THEN
      v_out := v_out || jsonb_build_object(v_key, '[redacted]');
    ELSE
      v_out := v_out || jsonb_build_object(v_key, public.redact_tfn_jsonb(v_val));
    END IF;
  END LOOP;
  RETURN v_out;
END $$;

COMMENT ON FUNCTION public.redact_tfn_jsonb(jsonb) IS
  'Replaces every non-null tfn / test_individual_tfn / tax_file_number / taxFileNumber value in a JSON document '
  '(at any depth) with "[redacted]".';

REVOKE ALL ON FUNCTION public.redact_tfn_jsonb(jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Move plain values out of the client-readable columns (idempotent)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.quarantine_plaintext_tfns()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_moved integer := 0;
  v_n integer;
  v_src record;
BEGIN
  FOR v_src IN
    SELECT * FROM (VALUES
      ('trusts', 'tfn'),
      ('trust_beneficiaries', 'tfn'),
      ('family_trust_elections', 'test_individual_tfn'),
      ('smsf_funds', 'tfn'),
      ('smsf_members', 'tfn')
    ) AS s(entity_table, col)
  LOOP
    -- If a value for the same entity is already waiting, the column's newer value replaces it.
    EXECUTE format(
      'INSERT INTO public.entity_tfn_legacy_plaintext (organization_id, entity_table, entity_id, tfn_plaintext)
       SELECT organization_id, %L, id, %I FROM public.%I WHERE nullif(btrim(%I), '''') IS NOT NULL
       ON CONFLICT (entity_table, entity_id) DO UPDATE SET tfn_plaintext = EXCLUDED.tfn_plaintext, moved_at = now()',
      v_src.entity_table, v_src.col, v_src.entity_table, v_src.col);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved + v_n;
    EXECUTE format('UPDATE public.%I SET %I = NULL WHERE %I IS NOT NULL', v_src.entity_table, v_src.col, v_src.col);
  END LOOP;

  -- Redact the copies the audit trigger made (including of the UPDATEs just above), and old employee
  -- wage_components TFN keys from before 0227. audit_log is append-only; lift that guard for this statement only.
  ALTER TABLE public.audit_log DISABLE TRIGGER audit_log_append_only;
  UPDATE public.audit_log
     SET before_data = public.redact_tfn_jsonb(before_data),
         after_data  = public.redact_tfn_jsonb(after_data),
         before      = public.redact_tfn_jsonb(before),
         after       = public.redact_tfn_jsonb(after),
         changes     = public.redact_tfn_jsonb(changes)
   WHERE table_name IN ('trusts', 'trust_beneficiaries', 'family_trust_elections', 'smsf_funds', 'smsf_members',
                        'employees')
     AND concat_ws(' ', before_data::text, after_data::text, before::text, after::text, changes::text)
         ~ '"(tfn|test_individual_tfn|tax_file_number|taxFileNumber)": *[^n ]';
  ALTER TABLE public.audit_log ENABLE TRIGGER audit_log_append_only;

  RETURN v_moved;
END $$;

COMMENT ON FUNCTION public.quarantine_plaintext_tfns() IS
  'Moves plain TFNs from trusts/trust_beneficiaries/family_trust_elections/smsf_funds/smsf_members into '
  'entity_tfn_legacy_plaintext, clears the columns and redacts audit_log copies. Owner-only; idempotent.';

REVOKE ALL ON FUNCTION public.quarantine_plaintext_tfns() FROM PUBLIC, anon, authenticated, service_role;

-- The constraints below need the columns empty; the audit trigger is not disabled, so the audit_log rows it writes
-- for these UPDATEs are redacted in the same call.
SELECT public.quarantine_plaintext_tfns();

-- ---------------------------------------------------------------------------
-- 5. The plain columns stay empty
-- ---------------------------------------------------------------------------
ALTER TABLE public.trusts
  ADD CONSTRAINT trusts_tfn_plaintext_forbidden CHECK (tfn IS NULL);
ALTER TABLE public.trust_beneficiaries
  ADD CONSTRAINT trust_beneficiaries_tfn_plaintext_forbidden CHECK (tfn IS NULL);
ALTER TABLE public.family_trust_elections
  ADD CONSTRAINT family_trust_elections_tfn_plaintext_forbidden CHECK (test_individual_tfn IS NULL);
ALTER TABLE public.smsf_funds
  ADD CONSTRAINT smsf_funds_tfn_plaintext_forbidden CHECK (tfn IS NULL);
ALTER TABLE public.smsf_members
  ADD CONSTRAINT smsf_members_tfn_plaintext_forbidden CHECK (tfn IS NULL);

COMMENT ON COLUMN public.trusts.tfn IS
  'Always NULL. TFNs are stored encrypted in entity_tfn_vault through the entity-tfn-save edge function.';
COMMENT ON COLUMN public.trust_beneficiaries.tfn IS
  'Always NULL. TFNs are stored encrypted in entity_tfn_vault through the entity-tfn-save edge function.';
COMMENT ON COLUMN public.family_trust_elections.test_individual_tfn IS
  'Always NULL. TFNs are stored encrypted in entity_tfn_vault through the entity-tfn-save edge function.';
COMMENT ON COLUMN public.smsf_funds.tfn IS
  'Always NULL. TFNs are stored encrypted in entity_tfn_vault through the entity-tfn-save edge function.';
COMMENT ON COLUMN public.smsf_members.tfn IS
  'Always NULL. TFNs are stored encrypted in entity_tfn_vault through the entity-tfn-save edge function.';

NOTIFY pgrst, 'reload schema';

COMMIT;
