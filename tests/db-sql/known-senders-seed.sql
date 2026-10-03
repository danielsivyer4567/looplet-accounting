-- SEED-01: new organisations do not inherit the pilot business's 723 seeded known senders; the pilot keeps them.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/known-senders-seed.sql
--
-- In this disposable database the pilot organisation does not exist when the migrations run, so the 0015 seed rows
-- stay unowned. The test then creates the pilot (its real id) and two new organisations, assigns the unowned rows to
-- the pilot the same way the migration does in production, and checks lookups and RLS as each tenant.
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

-- Runs a lookup as the service role (how gmail-mine calls it) and returns the matched brand, or NULL.
CREATE FUNCTION pg_temp.lookup(p_email text, p_org uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  brand text;
BEGIN
  EXECUTE 'SET LOCAL ROLE service_role';
  BEGIN
    EXECUTE format('SELECT brand_name FROM public.lookup_known_sender(%L, %L)', p_email, p_org) INTO brand;
  EXCEPTION WHEN undefined_function THEN
    -- Old signature lookup_known_sender(text): no organisation argument at all.
    EXECUTE format('SELECT brand_name FROM public.lookup_known_sender(%L)', p_email) INTO brand;
  END;
  EXECUTE 'RESET ROLE';
  RETURN brand;
END $$;

-- The claim function, or NULL when it does not exist (old code), so the run still lists every failing check.
CREATE FUNCTION pg_temp.claim(p_org uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  EXECUTE format('SELECT public.claim_unowned_known_senders(%L)', p_org) INTO n;
  RETURN n;
EXCEPTION WHEN undefined_function THEN
  RETURN NULL;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
INSERT INTO ids VALUES
  ('pilot', '9d5c9b9a-a576-458d-913a-fa822d33320d'),
  ('org_b', '0b000000-0000-4000-8000-0000000000d1'), ('org_c', '0c000000-0000-4000-8000-0000000000d1'),
  ('pilot_owner', '1a000000-0000-4000-8000-0000000000d1'), ('owner_b', '1b000000-0000-4000-8000-0000000000d1');
CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;

CREATE TEMP TABLE checks (name text, got text, want text);
CREATE FUNCTION pg_temp.check(p_name text, p_got anyelement, p_want anyelement) RETURNS void
LANGUAGE sql AS $$ INSERT INTO checks VALUES (p_name, p_got::text, p_want::text) $$;

-- Nothing was deleted: the 723 seed rows are still there.
SELECT pg_temp.check('seed rows kept', (SELECT count(*) FROM public.intake_known_senders), 723::bigint);

INSERT INTO auth.users (id, email, aud, role)
SELECT v, k || '@example.test', 'authenticated', 'authenticated' FROM ids WHERE k IN ('pilot_owner', 'owner_b');
INSERT INTO public.organizations (id, name) VALUES
  (pg_temp.id('pilot'), 'Affordable Fencing Gold Coast'), (pg_temp.id('org_b'), 'New Org B'), (pg_temp.id('org_c'), 'New Org C');
INSERT INTO public.organization_memberships (user_id, organization_id, role, role_enum, accepted_at) VALUES
  (pg_temp.id('pilot_owner'), pg_temp.id('pilot'), 'owner', 'owner', now()),
  (pg_temp.id('owner_b'), pg_temp.id('org_b'), 'owner', 'owner', now());

-- A brand-new organisation gets no classification from the pilot's list (seed row: bunnings.com.au, ljhooker customer).
SELECT pg_temp.check('new org: Bunnings not inherited', pg_temp.lookup('orders@bunnings.com.au', pg_temp.id('org_b')), NULL::text);
SELECT pg_temp.check('new org: pilot customer not inherited', pg_temp.lookup('accounts@ap.ljhooker.com.au', pg_temp.id('org_b')), NULL::text);
SELECT pg_temp.check('no org: nothing matched', pg_temp.lookup('orders@bunnings.com.au', NULL), NULL::text);

-- Production path: the pilot exists, so the unowned seed rows are assigned to it (as the migration's DO block does).
SELECT pg_temp.check('rows assigned to the pilot',
  pg_temp.claim(pg_temp.id('pilot')), 723);
SELECT pg_temp.check('pilot keeps its classification', pg_temp.lookup('orders@bunnings.com.au', pg_temp.id('pilot')), 'Bunnings');
SELECT pg_temp.check('new org still inherits nothing', pg_temp.lookup('orders@bunnings.com.au', pg_temp.id('org_b')), NULL::text);

-- A new organisation's own known sender is used for it and for no one else.
INSERT INTO public.intake_known_senders (organization_id, domain, brand_name, kind, category_code, arm)
SELECT pg_temp.id('org_b'), 'bunnings.com.au', 'Bunnings (org B)', 'supplier', code, 'invoice'
  FROM public.intake_categories WHERE code = 'materials';
SELECT pg_temp.check('org B uses its own row', pg_temp.lookup('orders@bunnings.com.au', pg_temp.id('org_b')), 'Bunnings (org B)');
SELECT pg_temp.check('org C sees neither list', pg_temp.lookup('orders@bunnings.com.au', pg_temp.id('org_c')), NULL::text);
SELECT pg_temp.check('pilot unaffected by org B', pg_temp.lookup('orders@bunnings.com.au', pg_temp.id('pilot')), 'Bunnings');

-- RLS: a signed-in member reads only their own organisation's list.
SELECT pg_temp.check('org B member reads only org B rows',
  pg_temp.as_user(pg_temp.id('owner_b'), 'SELECT to_jsonb(count(*)) FROM public.intake_known_senders')::text, '1');
SELECT pg_temp.check('pilot member reads the pilot list',
  pg_temp.as_user(pg_temp.id('pilot_owner'), 'SELECT to_jsonb(count(*)) FROM public.intake_known_senders')::text, '723');
SELECT pg_temp.check('authenticated cannot claim unowned rows',
  pg_temp.as_user(pg_temp.id('owner_b'), format('SELECT to_jsonb(public.claim_unowned_known_senders(%L))', pg_temp.id('org_b'))) ->> 'error' LIKE '42501%',
  true);

DO $$
DECLARE
  bad text;
  n int;
BEGIN
  SELECT count(*), string_agg(format('%s: got %s, want %s', name, coalesce(got, 'NULL'), coalesce(want, 'NULL')), E'\n')
    INTO n, bad
    FROM checks WHERE got IS DISTINCT FROM want;
  IF n > 0 THEN
    RAISE EXCEPTION E'Known senders seed: % of % checks failed:\n%', n, (SELECT count(*) FROM checks), bad;
  END IF;
  RAISE NOTICE 'Known senders seed: % checks passed (new orgs inherit nothing, pilot keeps its 723 rows, RLS per org)',
    (SELECT count(*) FROM checks);
END $$;

ROLLBACK;
