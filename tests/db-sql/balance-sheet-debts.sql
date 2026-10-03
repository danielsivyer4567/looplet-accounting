-- BS-01: credit-card and loan balances appear once on the balance sheet, as liabilities, never also as cash.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/balance-sheet-debts.sql
--
-- Setup runs as postgres; bank accounts are inserted so the 20260702134500 pipeline trigger creates their debt rows
-- exactly as a bank feed would. The balance sheet is read as the org owner (authenticated) so RLS applies.
-- Each check records (name, got, want); one exception at the end lists every mismatch.

BEGIN;

CREATE FUNCTION pg_temp.as_user(p_user uuid, p_sql text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  result jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql INTO result;
  EXCEPTION WHEN others THEN
    result := jsonb_build_object('error', SQLSTATE || ' ' || SQLERRM);
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN result;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
INSERT INTO ids VALUES
  ('org', '0a000000-0000-4000-8000-0000000000e1'), ('owner', '1a000000-0000-4000-8000-0000000000e1'),
  ('conn', '6a000000-0000-4000-8000-0000000000e1'),
  ('everyday', '6b000000-0000-4000-8000-0000000000e1'), ('card', '6b000000-0000-4000-8000-0000000000e2'),
  ('loan', '6b000000-0000-4000-8000-0000000000e3'), ('card_no_debt', '6b000000-0000-4000-8000-0000000000e4'),
  ('card_personal', '6b000000-0000-4000-8000-0000000000e5'), ('closed_card', '6b000000-0000-4000-8000-0000000000e6');
CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;

CREATE TEMP TABLE checks (name text, got text, want text);
CREATE FUNCTION pg_temp.check(p_name text, p_got anyelement, p_want anyelement) RETURNS void
LANGUAGE sql AS $$ INSERT INTO checks VALUES (p_name, p_got::text, p_want::text) $$;

INSERT INTO auth.users (id, email, aud, role) VALUES (pg_temp.id('owner'), 'owner@example.test', 'authenticated', 'authenticated');
INSERT INTO public.organizations (id, name) VALUES (pg_temp.id('org'), 'Balance Sheet Org');
INSERT INTO public.organization_memberships (user_id, organization_id, role, role_enum, accepted_at)
VALUES (pg_temp.id('owner'), pg_temp.id('org'), 'owner', 'owner', now());
INSERT INTO public.bank_connections (id, organization_id, provider, encrypted_access_token, status)
VALUES (pg_temp.id('conn'), pg_temp.id('org'), 'basiq', 'test-only', 'active');

-- Everyday account $10,000. Credit card owes $3,000, loan owes $20,000 (feeds report owed balances as negative).
-- card_no_debt owes $400 and its debt row gets deleted; card_personal owes $100 and its debt is marked personal;
-- closed_card is inactive.
INSERT INTO public.bank_accounts (id, organization_id, bank_connection_id, external_id, name, account_type, current_balance_cents, is_active) VALUES
  (pg_temp.id('everyday'),      pg_temp.id('org'), pg_temp.id('conn'), 'ext-1', 'Everyday',      'checking',    1000000,  true),
  (pg_temp.id('card'),          pg_temp.id('org'), pg_temp.id('conn'), 'ext-2', 'Business card', 'credit_card', -300000,  true),
  (pg_temp.id('loan'),          pg_temp.id('org'), pg_temp.id('conn'), 'ext-3', 'Ute loan',      'loan',        -2000000, true),
  (pg_temp.id('card_no_debt'),  pg_temp.id('org'), pg_temp.id('conn'), 'ext-4', 'Spare card',    'credit_card', -40000,   true),
  (pg_temp.id('card_personal'), pg_temp.id('org'), pg_temp.id('conn'), 'ext-5', 'Personal card', 'credit_card', -10000,   true),
  (pg_temp.id('closed_card'),   pg_temp.id('org'), pg_temp.id('conn'), 'ext-6', 'Closed card',   'credit_card', -99999,   false);

SELECT pg_temp.check('pipeline created a debt per active card/loan',
  (SELECT count(*) FROM public.debts WHERE organization_id = pg_temp.id('org') AND bank_account_id IS NOT NULL), 4::bigint);
UPDATE public.debts SET deleted_at = now() WHERE bank_account_id = pg_temp.id('card_no_debt');
UPDATE public.debts SET is_personal = true WHERE bank_account_id = pg_temp.id('card_personal');

-- Debts entered by hand: an ATO payment plan ($700) and a deleted one ($500, must not count).
INSERT INTO public.debts (organization_id, name, kind, current_balance_cents, is_personal, deleted_at)
SELECT pg_temp.id('org'), 'ATO payment plan', e.enumlabel::public.debt_kind, 70000, false, NULL
  FROM pg_enum e WHERE e.enumtypid = 'public.debt_kind'::regtype ORDER BY e.enumsortorder LIMIT 1;
INSERT INTO public.debts (organization_id, name, kind, current_balance_cents, is_personal, deleted_at)
SELECT pg_temp.id('org'), 'Paid-off loan', e.enumlabel::public.debt_kind, 50000, false, now()
  FROM pg_enum e WHERE e.enumtypid = 'public.debt_kind'::regtype ORDER BY e.enumsortorder LIMIT 1;

CREATE TEMP TABLE bs AS
SELECT * FROM jsonb_to_recordset(pg_temp.as_user(pg_temp.id('owner'), format(
  'SELECT coalesce(jsonb_agg(to_jsonb(b)), ''[]'') FROM public.v_balance_sheet b WHERE organization_id = %L', pg_temp.id('org'))))
  AS x(category text, line_item text, amount_cents numeric);
CREATE FUNCTION pg_temp.line(p text) RETURNS text LANGUAGE sql AS $$ SELECT amount_cents::bigint::text FROM bs WHERE line_item = p $$;

SELECT pg_temp.check('Cash at bank = everyday account only', pg_temp.line('Cash at bank'), '1000000');
SELECT pg_temp.check('Debts = card + loan + ATO plan (not deleted, not personal)', pg_temp.line('Debts (loans / credit)'), '2370000');
SELECT pg_temp.check('card without a debt record shows once as a liability',
  pg_temp.line('Credit cards and loans (bank feed, no debt record)'), '40000');
SELECT pg_temp.check('Net equity', pg_temp.line('Net equity (assets − liabilities)'), '-1410000');
SELECT pg_temp.check('liabilities total', (SELECT sum(amount_cents)::bigint FROM bs WHERE category = 'liability'), 2410000::bigint);
SELECT pg_temp.check('assets total', (SELECT sum(amount_cents)::bigint FROM bs WHERE category = 'asset'), 1000000::bigint);

-- The summary view agrees.
SELECT pg_temp.check('summary liabilities',
  pg_temp.as_user(pg_temp.id('owner'), format(
    'SELECT to_jsonb(total_cents::bigint) FROM public.v_balance_sheet_summary WHERE organization_id = %L AND category = ''liability''',
    pg_temp.id('org')))::text, '2410000');
SELECT pg_temp.check('v_balance_sheet stays security_invoker',
  (SELECT 'security_invoker=on' = ANY (reloptions) FROM pg_class WHERE oid = 'public.v_balance_sheet'::regclass), true);

DO $$
DECLARE
  bad text;
  n int;
BEGIN
  SELECT count(*), string_agg(format('%s: got %s, want %s', name, coalesce(got, 'NULL'), coalesce(want, 'NULL')), E'\n')
    INTO n, bad
    FROM checks WHERE got IS DISTINCT FROM want;
  IF n > 0 THEN
    RAISE EXCEPTION E'Balance sheet debts: % of % checks failed:\n%', n, (SELECT count(*) FROM checks), bad;
  END IF;
  RAISE NOTICE 'Balance sheet debts: % checks passed (cards and loans counted once, deleted debts excluded)',
    (SELECT count(*) FROM checks);
END $$;

ROLLBACK;
