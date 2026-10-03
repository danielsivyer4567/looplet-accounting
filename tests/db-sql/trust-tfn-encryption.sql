-- TFN-01: trust, beneficiary, family trust election, SMSF fund and SMSF member TFNs are never stored as plain text.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/trust-tfn-encryption.sql
--
-- Setup runs as postgres. Probes switch to `authenticated` (with the user's JWT claims) or `service_role`, run one
-- statement, record ok / none / denied / error, and roll the statement back. The legacy-data section re-creates the
-- pre-migration state (plain TFNs plus their audit_log copies) inside this transaction and runs the same
-- quarantine_plaintext_tfns() the migration ran. Everything is rolled back.

BEGIN;

CREATE FUNCTION pg_temp.probe(p_role text, p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  n bigint := 0;
  result text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', p_role)::text, true);
  PERFORM set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE EXCEPTION 'probe-rollback';
  EXCEPTION
    WHEN insufficient_privilege THEN result := 'denied';
    WHEN raise_exception THEN
      result := CASE WHEN SQLERRM = 'probe-rollback' THEN CASE WHEN n > 0 THEN 'ok' ELSE 'none' END
                     ELSE 'error: ' || SQLERRM END;
    WHEN others THEN result := 'error: ' || SQLSTATE || ' ' || SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN result;
END $$;

CREATE FUNCTION pg_temp.expect(p_label text, p_got text, p_want text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want AND NOT (p_want LIKE '%\%%' AND p_got LIKE p_want) THEN
    RAISE EXCEPTION '%: expected %, got %', p_label, p_want, p_got;
  END IF;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
INSERT INTO ids VALUES
  ('org_a', '0a000000-0000-4000-8000-0000000000c1'), ('org_b', '0b000000-0000-4000-8000-0000000000c1'),
  ('owner', '10000000-0000-4000-8000-0000000000c1'), ('admin', '10000000-0000-4000-8000-0000000000c2'),
  ('outsider', '10000000-0000-4000-8000-0000000000c3'),
  ('trust', 'a1000000-0000-4000-8000-000000000001'), ('trust_b', 'a1000000-0000-4000-8000-0000000000b1'),
  ('beneficiary', 'a2000000-0000-4000-8000-000000000001'),
  ('fte', 'a3000000-0000-4000-8000-000000000001'),
  ('fund', 'a4000000-0000-4000-8000-000000000001'),
  ('member', 'a5000000-0000-4000-8000-000000000001'),
  ('employee', 'a6000000-0000-4000-8000-000000000001');
CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;

-- 52 base64 characters: the shape of _shared/xero/crypto.ts output for a 9-digit TFN (12 + 9 + 16 bytes).
CREATE FUNCTION pg_temp.ciphertext() RETURNS text LANGUAGE sql AS $$
  SELECT encode(decode(md5('a') || md5('b') || substr(md5('c'), 1, 10), 'hex'), 'base64')
$$;

INSERT INTO auth.users (id, email, aud, role)
SELECT v, k || '@example.test', 'authenticated', 'authenticated' FROM ids WHERE k IN ('owner', 'admin', 'outsider');
INSERT INTO public.organizations (id, name) VALUES (pg_temp.id('org_a'), 'Org A'), (pg_temp.id('org_b'), 'Org B');
INSERT INTO public.organization_memberships (user_id, organization_id, role, role_enum, accepted_at) VALUES
  (pg_temp.id('owner'),    pg_temp.id('org_a'), 'owner', 'owner', now()),
  (pg_temp.id('admin'),    pg_temp.id('org_a'), 'admin', 'admin', now()),
  (pg_temp.id('outsider'), pg_temp.id('org_b'), 'owner', 'owner', now());

INSERT INTO public.trusts (id, organization_id, name) VALUES
  (pg_temp.id('trust'), pg_temp.id('org_a'), 'Sivyer Family Trust'),
  (pg_temp.id('trust_b'), pg_temp.id('org_b'), 'Other Trust');
INSERT INTO public.trust_beneficiaries (id, organization_id, trust_id, name)
VALUES (pg_temp.id('beneficiary'), pg_temp.id('org_a'), pg_temp.id('trust'), 'Alex');
INSERT INTO public.family_trust_elections (id, organization_id, trust_id, test_individual_name, election_fy)
VALUES (pg_temp.id('fte'), pg_temp.id('org_a'), pg_temp.id('trust'), 'Daniel', 2020);
INSERT INTO public.smsf_funds (id, organization_id, name) VALUES (pg_temp.id('fund'), pg_temp.id('org_a'), 'Super Fund');
INSERT INTO public.smsf_members (id, organization_id, fund_id, name)
VALUES (pg_temp.id('member'), pg_temp.id('org_a'), pg_temp.id('fund'), 'Member');

-- ---------------------------------------------------------------------------------------------------------------
-- 1. No role can write a plain TFN to any of the five columns; other edits still work.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  w record;
  a uuid := pg_temp.id('admin');
BEGIN
  FOR w IN SELECT * FROM (VALUES
    ('trusts insert', format($q$INSERT INTO public.trusts (organization_id, name, tfn) VALUES (%L, 'T2', '123456782')$q$, pg_temp.id('org_a'))),
    ('trusts update', format($q$UPDATE public.trusts SET tfn = '123 456 782' WHERE id = %L$q$, pg_temp.id('trust'))),
    ('beneficiaries insert', format($q$INSERT INTO public.trust_beneficiaries (organization_id, trust_id, name, tfn) VALUES (%L, %L, 'B2', '123456782')$q$, pg_temp.id('org_a'), pg_temp.id('trust'))),
    ('beneficiaries update', format($q$UPDATE public.trust_beneficiaries SET tfn = '123456782' WHERE id = %L$q$, pg_temp.id('beneficiary'))),
    ('fte update', format($q$UPDATE public.family_trust_elections SET test_individual_tfn = '123456782' WHERE id = %L$q$, pg_temp.id('fte'))),
    ('smsf fund update', format($q$UPDATE public.smsf_funds SET tfn = '123456782' WHERE id = %L$q$, pg_temp.id('fund'))),
    ('smsf member insert', format($q$INSERT INTO public.smsf_members (organization_id, fund_id, name, tfn) VALUES (%L, %L, 'M2', '87654321')$q$, pg_temp.id('org_a'), pg_temp.id('fund'))),
    ('smsf member update', format($q$UPDATE public.smsf_members SET tfn = '87654321' WHERE id = %L$q$, pg_temp.id('member')))
  ) AS t(label, stmt) LOOP
    PERFORM pg_temp.expect('admin ' || w.label, pg_temp.probe('authenticated', a, w.stmt), 'error: 23514%plaintext_forbidden%');
  END LOOP;

  PERFORM pg_temp.expect('admin renames trust', pg_temp.probe('authenticated', a,
    format($q$UPDATE public.trusts SET name = 'Renamed' WHERE id = %L$q$, pg_temp.id('trust'))), 'ok');
  PERFORM pg_temp.expect('admin adds trust without TFN', pg_temp.probe('authenticated', a,
    format($q$INSERT INTO public.trusts (organization_id, name) VALUES (%L, 'T3')$q$, pg_temp.id('org_a'))), 'ok');

  -- The constraint binds the owner of the table too, not just clients.
  BEGIN
    UPDATE public.trusts SET tfn = '123456782' WHERE id = pg_temp.id('trust');
    RAISE EXCEPTION 'postgres wrote a plain trust TFN';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. The vault and the holding table are closed to clients; the service role can use them.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  o uuid := pg_temp.id('owner');
BEGIN
  PERFORM pg_temp.expect('owner reads vault', pg_temp.probe('authenticated', o, 'SELECT * FROM public.entity_tfn_vault'), 'denied');
  PERFORM pg_temp.expect('owner writes vault', pg_temp.probe('authenticated', o, format(
    $q$INSERT INTO public.entity_tfn_vault (organization_id, entity_table, entity_id, tfn_encrypted, tfn_last4)
       VALUES (%L, 'trusts', %L, %L, '6782')$q$, pg_temp.id('org_a'), pg_temp.id('trust'), pg_temp.ciphertext())), 'denied');
  PERFORM pg_temp.expect('owner reads holding table', pg_temp.probe('authenticated', o, 'SELECT * FROM public.entity_tfn_legacy_plaintext'), 'denied');
  PERFORM pg_temp.expect('anon reads vault', pg_temp.probe('anon', NULL, 'SELECT * FROM public.entity_tfn_vault'), 'denied');

  -- What entity-tfn-save does: store ciphertext and last four digits.
  PERFORM pg_temp.expect('service role stores ciphertext', pg_temp.probe('service_role', NULL, format(
    $q$INSERT INTO public.entity_tfn_vault (organization_id, entity_table, entity_id, tfn_encrypted, tfn_last4)
       VALUES (%L, 'trusts', %L, %L, '6782')$q$, pg_temp.id('org_a'), pg_temp.id('trust'), pg_temp.ciphertext())), 'ok');

  -- A plain TFN cannot be put in the ciphertext column, even by the service role.
  PERFORM pg_temp.expect('plain TFN as ciphertext', pg_temp.probe('service_role', NULL, format(
    $q$INSERT INTO public.entity_tfn_vault (organization_id, entity_table, entity_id, tfn_encrypted, tfn_last4)
       VALUES (%L, 'trusts', %L, '123456782', '6782')$q$, pg_temp.id('org_a'), pg_temp.id('trust'))),
    'error: 23514%entity_tfn_vault_ciphertext_only%');
  PERFORM pg_temp.expect('spaced TFN as ciphertext', pg_temp.probe('service_role', NULL, format(
    $q$INSERT INTO public.entity_tfn_vault (organization_id, entity_table, entity_id, tfn_encrypted, tfn_last4)
       VALUES (%L, 'smsf_members', %L, '123 456 782', '6782')$q$, pg_temp.id('org_a'), pg_temp.id('member'))),
    'error: 23514%entity_tfn_vault_ciphertext_only%');
  PERFORM pg_temp.expect('five-digit last4', pg_temp.probe('service_role', NULL, format(
    $q$INSERT INTO public.entity_tfn_vault (organization_id, entity_table, entity_id, tfn_encrypted, tfn_last4)
       VALUES (%L, 'smsf_funds', %L, %L, '56782')$q$, pg_temp.id('org_a'), pg_temp.id('fund'), pg_temp.ciphertext())),
    'error: 23514%');
  -- The record must belong to the same organisation.
  PERFORM pg_temp.expect('other org trust', pg_temp.probe('service_role', NULL, format(
    $q$INSERT INTO public.entity_tfn_vault (organization_id, entity_table, entity_id, tfn_encrypted, tfn_last4)
       VALUES (%L, 'trusts', %L, %L, '6782')$q$, pg_temp.id('org_a'), pg_temp.id('trust_b'), pg_temp.ciphertext())),
    'error: 23503%does not belong to organization%');
  PERFORM pg_temp.expect('unknown table', pg_temp.probe('service_role', NULL, format(
    $q$INSERT INTO public.entity_tfn_vault (organization_id, entity_table, entity_id, tfn_encrypted, tfn_last4)
       VALUES (%L, 'employees', %L, %L, '6782')$q$, pg_temp.id('org_a'), pg_temp.id('trust'), pg_temp.ciphertext())),
    'error: 23514%');

  IF has_function_privilege('authenticated', 'public.quarantine_plaintext_tfns()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.quarantine_plaintext_tfns()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.redact_tfn_jsonb(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'TFN maintenance functions must not be callable by clients or the service role';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Existing plain TFNs (and their audit_log copies) are moved out and redacted, idempotently.
-- ---------------------------------------------------------------------------------------------------------------
-- Re-create the state before the migration: plain TFNs written through the audited tables.
ALTER TABLE public.trusts DROP CONSTRAINT trusts_tfn_plaintext_forbidden;
ALTER TABLE public.trust_beneficiaries DROP CONSTRAINT trust_beneficiaries_tfn_plaintext_forbidden;
ALTER TABLE public.family_trust_elections DROP CONSTRAINT family_trust_elections_tfn_plaintext_forbidden;
ALTER TABLE public.smsf_members DROP CONSTRAINT smsf_members_tfn_plaintext_forbidden;
UPDATE public.trusts SET tfn = '123 456 782' WHERE id = pg_temp.id('trust');
UPDATE public.trust_beneficiaries SET tfn = '87654321' WHERE id = pg_temp.id('beneficiary');
UPDATE public.family_trust_elections SET test_individual_tfn = '11122233' WHERE id = pg_temp.id('fte');
UPDATE public.smsf_members SET tfn = '   ' WHERE id = pg_temp.id('member');
-- An employee audit row from before 0227, with a TFN inside wage_components.
INSERT INTO public.audit_log (organization_id, table_name, record_id, operation, before_data, after_data, before, after, changes)
VALUES (pg_temp.id('org_a'), 'employees', pg_temp.id('employee'), 'UPDATE',
        '{"wage_components": {"tfn": "999888777", "super_pct": 12}}', '{"wage_components": {"super_pct": 12}}',
        '{"wage_components": {"tfn": "999888777", "super_pct": 12}}', '{"wage_components": {"super_pct": 12}}',
        '{"wage_components": [{"tfn": "999888777", "super_pct": 12}, {"super_pct": 12}]}');

CREATE TEMP TABLE audit_rows_before AS SELECT count(*) AS n FROM public.audit_log;

DO $$
DECLARE
  moved integer;
  leaks integer;
  v text;
BEGIN
  SELECT count(*) INTO leaks FROM public.audit_log
   WHERE concat_ws(' ', before_data, after_data, before, after, changes) ~ '123 456 782|87654321|11122233|999888777';
  IF leaks < 4 THEN RAISE EXCEPTION 'setup: expected the audit trigger to have copied the plain TFNs, found %', leaks; END IF;

  moved := public.quarantine_plaintext_tfns();
  IF moved <> 3 THEN RAISE EXCEPTION 'expected 3 TFNs moved (blank values skipped), got %', moved; END IF;

  IF EXISTS (SELECT 1 FROM public.trusts WHERE tfn IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.trust_beneficiaries WHERE tfn IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.family_trust_elections WHERE test_individual_tfn IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.smsf_members WHERE tfn IS NOT NULL) THEN
    RAISE EXCEPTION 'plain TFN columns were not cleared';
  END IF;

  SELECT tfn_plaintext INTO v FROM public.entity_tfn_legacy_plaintext
   WHERE entity_table = 'trusts' AND entity_id = pg_temp.id('trust') AND organization_id = pg_temp.id('org_a');
  PERFORM pg_temp.expect('held trust TFN', v, '123 456 782');
  SELECT tfn_plaintext INTO v FROM public.entity_tfn_legacy_plaintext
   WHERE entity_table = 'family_trust_elections' AND entity_id = pg_temp.id('fte');
  PERFORM pg_temp.expect('held FTE TFN', v, '11122233');

  -- No audit row anywhere still holds a TFN, the rows themselves are kept, and the redaction is visible.
  SELECT count(*) INTO leaks FROM public.audit_log
   WHERE concat_ws(' ', before_data, after_data, before, after, changes) ~ '123 456 782|87654321|11122233|999888777';
  IF leaks <> 0 THEN RAISE EXCEPTION '% audit_log rows still hold a plain TFN', leaks; END IF;
  IF (SELECT count(*) FROM public.audit_log) < (SELECT n FROM audit_rows_before) THEN
    RAISE EXCEPTION 'audit rows were deleted instead of redacted';
  END IF;
  SELECT after ->> 'tfn' INTO v FROM public.audit_log
   WHERE table_name = 'trusts' AND record_id = pg_temp.id('trust') AND operation = 'UPDATE' AND after ? 'tfn'
     AND before ->> 'tfn' IS NULL
   ORDER BY occurred_at LIMIT 1;
  PERFORM pg_temp.expect('redacted audit value', v, '[redacted]');
  SELECT after_data -> 'wage_components' ->> 'super_pct' INTO v FROM public.audit_log
   WHERE table_name = 'employees' AND record_id = pg_temp.id('employee');
  PERFORM pg_temp.expect('other audit data kept', v, '12');

  -- audit_log is append-only again afterwards.
  IF (SELECT tgenabled FROM pg_trigger WHERE tgname = 'audit_log_append_only' AND tgrelid = 'public.audit_log'::regclass) <> 'O' THEN
    RAISE EXCEPTION 'audit_log_append_only was left disabled';
  END IF;
  BEGIN
    DELETE FROM public.audit_log WHERE record_id = pg_temp.id('employee');
    RAISE EXCEPTION 'audit_log accepted a DELETE';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Idempotent: a second run moves nothing and keeps what is waiting.
  moved := public.quarantine_plaintext_tfns();
  IF moved <> 0 THEN RAISE EXCEPTION 'second run moved % TFNs', moved; END IF;
  IF (SELECT count(*) FROM public.entity_tfn_legacy_plaintext) <> 3 THEN
    RAISE EXCEPTION 'second run changed the holding table';
  END IF;
END $$;

-- The constraints validate again over the cleared columns.
ALTER TABLE public.trusts ADD CONSTRAINT trusts_tfn_plaintext_forbidden CHECK (tfn IS NULL);
ALTER TABLE public.trust_beneficiaries ADD CONSTRAINT trust_beneficiaries_tfn_plaintext_forbidden CHECK (tfn IS NULL);
ALTER TABLE public.family_trust_elections ADD CONSTRAINT family_trust_elections_tfn_plaintext_forbidden CHECK (test_individual_tfn IS NULL);
ALTER TABLE public.smsf_members ADD CONSTRAINT smsf_members_tfn_plaintext_forbidden CHECK (tfn IS NULL);

-- What entity-tfn-backfill does per waiting row, as the service role: store the ciphertext, then delete the plain row.
DO $$
BEGIN
  PERFORM pg_temp.expect('backfill stores beneficiary ciphertext', pg_temp.probe('service_role', NULL, format(
    $q$WITH v AS (INSERT INTO public.entity_tfn_vault (organization_id, entity_table, entity_id, tfn_encrypted, tfn_last4)
                  VALUES (%L, 'trust_beneficiaries', %L, %L, '4321') RETURNING 1)
       DELETE FROM public.entity_tfn_legacy_plaintext WHERE entity_table = 'trust_beneficiaries' AND entity_id = %L$q$,
    pg_temp.id('org_a'), pg_temp.id('beneficiary'), pg_temp.ciphertext(), pg_temp.id('beneficiary'))), 'ok');
  -- The service role can read and delete waiting rows but never add plain values.
  PERFORM pg_temp.expect('service role adds plain row', pg_temp.probe('service_role', NULL, format(
    $q$INSERT INTO public.entity_tfn_legacy_plaintext (organization_id, entity_table, entity_id, tfn_plaintext)
       VALUES (%L, 'trusts', %L, '123456782')$q$, pg_temp.id('org_a'), pg_temp.id('trust_b'))), 'denied');
END $$;

DO $$ BEGIN
  RAISE NOTICE 'trust-tfn-encryption: plain TFN columns reject writes for every role; vault is service-only and ciphertext-only; legacy TFNs are held for encryption and audit_log copies redacted, idempotently';
END $$;

ROLLBACK;
