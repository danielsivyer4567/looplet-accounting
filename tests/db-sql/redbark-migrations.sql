-- BANK-06: the Redbark migrations apply, and a Redbark connection belongs to exactly one organisation.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/redbark-migrations.sql
--
-- Setup runs as postgres (table owner, so RLS does not apply). Each probe switches to a role (authenticated with the
-- user's JWT claims, or service_role), runs one statement, records ok (rows changed), none (no rows visible to
-- change), denied (RLS or same-organisation check) or unique (unique violation), and always rolls the statement back
-- so probes do not affect each other.

BEGIN;

CREATE FUNCTION pg_temp.probe(p_role text, p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  n bigint := 0;
  result text;
BEGIN
  IF p_user IS NOT NULL THEN
    -- Both forms: older auth.uid() reads request.jwt.claim.sub, newer reads request.jwt.claims.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', p_role)::text, true);
    PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  END IF;
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE EXCEPTION 'probe-rollback';
  EXCEPTION
    WHEN insufficient_privilege THEN result := 'denied';
    WHEN unique_violation THEN result := 'unique';
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

-- Fixed ids: org A links a Redbark connection; org B belongs to an outsider.
CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
INSERT INTO ids VALUES
  ('org_a', '0a000000-0000-4000-8000-0000000000f1'), ('org_b', '0b000000-0000-4000-8000-0000000000f1'),
  ('owner', '10000000-0000-4000-8000-0000000000f1'), ('accountant', '10000000-0000-4000-8000-0000000000f2'),
  ('viewer', '10000000-0000-4000-8000-0000000000f3'), ('outsider', '10000000-0000-4000-8000-0000000000f4'),
  ('feed_conn', 'c0000000-0000-4000-8000-0000000000f1'), ('manual_conn', 'c0000000-0000-4000-8000-0000000000f2'),
  ('manual_conn_b', 'c0000000-0000-4000-8000-0000000000f3'),
  ('feed_acct', 'a0000000-0000-4000-8000-0000000000f1'), ('manual_acct', 'a0000000-0000-4000-8000-0000000000f2');
CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;

INSERT INTO auth.users (id, email, aud, role)
SELECT v, k || '@example.test', 'authenticated', 'authenticated' FROM ids
 WHERE k IN ('owner', 'accountant', 'viewer', 'outsider');

INSERT INTO public.organizations (id, name) VALUES (pg_temp.id('org_a'), 'Feed Org A'), (pg_temp.id('org_b'), 'Feed Org B');

INSERT INTO public.organization_memberships (user_id, organization_id, role, role_enum, accepted_at) VALUES
  (pg_temp.id('owner'),      pg_temp.id('org_a'), 'owner',  'owner',      now()),
  (pg_temp.id('accountant'), pg_temp.id('org_a'), 'member', 'accountant', now()),
  (pg_temp.id('viewer'),     pg_temp.id('org_a'), 'member', 'viewer',     now()),
  (pg_temp.id('outsider'),   pg_temp.id('org_b'), 'owner',  'owner',      now());

-- What bank-feed-link writes (as the service role in production), plus a manual CSV connection in each organisation.
-- Manual connections have no external_item_id; two NULLs must not collide under the new global unique key.
INSERT INTO public.bank_connections (id, organization_id, provider, external_item_id, institution_name, status, encrypted_access_token) VALUES
  (pg_temp.id('feed_conn'),     pg_temp.id('org_a'), 'redbark', 'rb-conn-1', 'Commonwealth Bank', 'active', ''),
  (pg_temp.id('manual_conn'),   pg_temp.id('org_a'), 'manual',  NULL,        'CSV import',        'active', ''),
  (pg_temp.id('manual_conn_b'), pg_temp.id('org_b'), 'manual',  NULL,        'CSV import',        'active', '');
INSERT INTO public.bank_accounts (id, organization_id, bank_connection_id, external_id, name, feed_sync_from) VALUES
  (pg_temp.id('feed_acct'),   pg_temp.id('org_a'), pg_temp.id('feed_conn'),   'rb-acct-1',        'Business Transaction', DATE '2026-07-01'),
  (pg_temp.id('manual_acct'), pg_temp.id('org_a'), pg_temp.id('manual_conn'), 'manual:operating', 'Operating',            NULL);

-- Schema: the enum label and the feed window columns exist with the right types.
CREATE TEMP TABLE schema_checks (name text, ok boolean);
INSERT INTO schema_checks VALUES
  ('bank_provider has redbark', EXISTS (
     SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'bank_provider' AND e.enumlabel = 'redbark')),
  ('bank_accounts.feed_sync_from is a date', EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'bank_accounts' AND column_name = 'feed_sync_from' AND data_type = 'date')),
  ('bank_accounts.feed_covered_through is a date', EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'bank_accounts' AND column_name = 'feed_covered_through' AND data_type = 'date'));

-- Expected outcome of each statement, per role. Even the service role cannot give one Redbark connection to two
-- organisations, or put an account in a different organisation from its connection.
CREATE TEMP TABLE cases (name text, who text, expected text, sql text);
INSERT INTO cases (name, who, expected, sql) VALUES
  -- One organisation per Redbark connection, whoever writes.
  ('same Redbark connection linked to another org', 'service', 'unique',
   format($q$INSERT INTO public.bank_connections (organization_id, provider, external_item_id, status, encrypted_access_token) VALUES (%L, 'redbark', 'rb-conn-1', 'active', '')$q$, pg_temp.id('org_b'))),
  ('same Redbark connection linked twice in one org', 'service', 'unique',
   format($q$INSERT INTO public.bank_connections (organization_id, provider, external_item_id, status, encrypted_access_token) VALUES (%L, 'redbark', 'rb-conn-1', 'active', '')$q$, pg_temp.id('org_a'))),
  ('another Redbark connection for org B', 'service', 'ok',
   format($q$INSERT INTO public.bank_connections (organization_id, provider, external_item_id, status, encrypted_access_token) VALUES (%L, 'redbark', 'rb-conn-2', 'active', '')$q$, pg_temp.id('org_b'))),
  ('the same id under another provider', 'service', 'ok',
   format($q$INSERT INTO public.bank_connections (organization_id, provider, external_item_id, status, encrypted_access_token) VALUES (%L, 'manual', 'rb-conn-1', 'active', '')$q$, pg_temp.id('org_b'))),
  ('org B account under org A Redbark connection', 'service', 'denied',
   format($q$INSERT INTO public.bank_accounts (organization_id, bank_connection_id, external_id, name) VALUES (%L, %L, 'rb-acct-2', 'Stolen')$q$, pg_temp.id('org_b'), pg_temp.id('feed_conn'))),
  ('move a linked account to org B', 'service', 'denied',
   format($q$UPDATE public.bank_accounts SET organization_id = %L WHERE id = %L$q$, pg_temp.id('org_b'), pg_temp.id('feed_acct'))),
  ('move a connection with accounts to org B', 'service', 'denied',
   format($q$UPDATE public.bank_connections SET organization_id = %L WHERE id = %L$q$, pg_temp.id('org_b'), pg_temp.id('feed_conn'))),
  ('feed functions update the checkpoint', 'service', 'ok',
   format($q$UPDATE public.bank_accounts SET feed_covered_through = DATE '2026-07-31' WHERE id = %L$q$, pg_temp.id('feed_acct'))),
  ('feed functions unlink the connection', 'service', 'ok',
   format($q$UPDATE public.bank_connections SET status = 'revoked' WHERE id = %L$q$, pg_temp.id('feed_conn'))),

  -- Signed-in users cannot create, change or delete Redbark links through the API, whatever their role.
  ('owner inserts a Redbark connection', 'owner', 'denied',
   format($q$INSERT INTO public.bank_connections (organization_id, provider, external_item_id, status, encrypted_access_token) VALUES (%L, 'redbark', 'rb-conn-9', 'active', '')$q$, pg_temp.id('org_a'))),
  ('owner re-points the Redbark connection', 'owner', 'none',
   format($q$UPDATE public.bank_connections SET external_item_id = 'rb-conn-9' WHERE id = %L$q$, pg_temp.id('feed_conn'))),
  ('owner turns a manual connection into Redbark', 'owner', 'denied',
   format($q$UPDATE public.bank_connections SET provider = 'redbark', external_item_id = 'rb-conn-9' WHERE id = %L$q$, pg_temp.id('manual_conn'))),
  ('owner deletes the Redbark connection', 'owner', 'none',
   format($q$DELETE FROM public.bank_connections WHERE id = %L$q$, pg_temp.id('feed_conn'))),
  ('owner adds an account under the Redbark connection', 'owner', 'denied',
   format($q$INSERT INTO public.bank_accounts (organization_id, bank_connection_id, external_id, name) VALUES (%L, %L, 'rb-acct-9', 'Other')$q$, pg_temp.id('org_a'), pg_temp.id('feed_conn'))),
  ('owner moves the import-from date', 'owner', 'none',
   format($q$UPDATE public.bank_accounts SET feed_sync_from = DATE '2020-01-01' WHERE id = %L$q$, pg_temp.id('feed_acct'))),
  ('owner moves a manual account under the Redbark connection', 'owner', 'denied',
   format($q$UPDATE public.bank_accounts SET bank_connection_id = %L WHERE id = %L$q$, pg_temp.id('feed_conn'), pg_temp.id('manual_acct'))),
  ('owner deletes the Redbark account', 'owner', 'none',
   format($q$DELETE FROM public.bank_accounts WHERE id = %L$q$, pg_temp.id('feed_acct'))),
  ('accountant adds an account under the Redbark connection', 'accountant', 'denied',
   format($q$INSERT INTO public.bank_accounts (organization_id, bank_connection_id, external_id, name) VALUES (%L, %L, 'rb-acct-9', 'Other')$q$, pg_temp.id('org_a'), pg_temp.id('feed_conn'))),
  ('outsider adds an account under org A Redbark connection', 'outsider', 'denied',
   format($q$INSERT INTO public.bank_accounts (organization_id, bank_connection_id, external_id, name) VALUES (%L, %L, 'rb-acct-9', 'Other')$q$, pg_temp.id('org_b'), pg_temp.id('feed_conn'))),
  ('outsider claims the Redbark connection for org B', 'outsider', 'denied',
   format($q$INSERT INTO public.bank_connections (organization_id, provider, external_item_id, status, encrypted_access_token) VALUES (%L, 'redbark', 'rb-conn-3', 'active', '')$q$, pg_temp.id('org_b'))),

  -- Manual imports and reads are unchanged.
  ('owner adds a manual connection', 'owner', 'ok',
   format($q$INSERT INTO public.bank_connections (organization_id, provider, institution_name, status, encrypted_access_token) VALUES (%L, 'manual', 'Another CSV', 'active', '')$q$, pg_temp.id('org_a'))),
  ('accountant adds a manual account', 'accountant', 'ok',
   format($q$INSERT INTO public.bank_accounts (organization_id, bank_connection_id, external_id, name) VALUES (%L, %L, 'manual:saver', 'Saver')$q$, pg_temp.id('org_a'), pg_temp.id('manual_conn'))),
  ('accountant renames a manual account', 'accountant', 'ok',
   format($q$UPDATE public.bank_accounts SET name = 'Main' WHERE id = %L$q$, pg_temp.id('manual_acct'))),
  ('viewer reads the Redbark account', 'viewer', 'ok',
   format($q$SELECT 1 FROM public.bank_accounts WHERE id = %L$q$, pg_temp.id('feed_acct'))),
  ('viewer reads the Redbark connection', 'viewer', 'ok',
   format($q$SELECT 1 FROM public.bank_connections WHERE id = %L$q$, pg_temp.id('feed_conn'))),
  ('outsider reads org A Redbark account', 'outsider', 'none',
   format($q$SELECT 1 FROM public.bank_accounts WHERE id = %L$q$, pg_temp.id('feed_acct')));

CREATE TEMP TABLE results AS
SELECT c.name, c.who, c.expected,
       CASE WHEN c.who = 'service' THEN pg_temp.probe('service_role', NULL, c.sql)
            ELSE pg_temp.probe('authenticated', pg_temp.id(c.who), c.sql) END AS actual
  FROM cases c;

DO $$
DECLARE
  r record;
  bad text := '';
BEGIN
  FOR r IN SELECT * FROM schema_checks WHERE NOT ok LOOP
    bad := bad || format(E'\n  schema: %s', r.name);
  END LOOP;
  FOR r IN SELECT * FROM results WHERE actual IS DISTINCT FROM expected ORDER BY name LOOP
    bad := bad || format(E'\n  %s (as %s): expected %s, got %s', r.name, r.who, r.expected, r.actual);
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'redbark migration checks failed:%', bad;
  END IF;
  RAISE NOTICE 'redbark migrations: % schema checks and % write/read probes as expected',
    (SELECT count(*) FROM schema_checks), (SELECT count(*) FROM results);
END $$;

ROLLBACK;
