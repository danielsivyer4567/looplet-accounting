-- SEC-10: SECURITY DEFINER functions that signed-in users can call and that write money tables check the caller's role.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/definer-write-roles.sql
--
-- Part 1 audits every such function in the database. Part 2 calls each one as each kind of user and checks whether
-- its authorisation gate let the call through. A gate rejection is a 42501 error, the "not a member" / "not
-- authorized" messages, or {"error": "forbidden"}; anything else (success, or a later data check) means the gate
-- allowed the caller. Everything is rolled back.

BEGIN;

-- Part 1: audit. Money tables written through a definer function must be gated by require_role.
CREATE TEMP TABLE audit AS
SELECT p.proname,
       (SELECT string_agg(t, ',') FROM unnest(ARRAY['bills','invoices','journal_entries','journal_lines','period_locks','suppliers',
               'customers','bank_accounts','employees','payment_runs','payment_run_items','super_batches','pay_runs','pay_slips',
               'bank_transactions','credit_notes']) t
         WHERE p.prosrc ~* ('(insert\s+into|update|delete\s+from)\s+(public\.)?' || t || '\M')) AS writes,
       p.prosrc ~* '(require_role|can_write_org)' AS role_check
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef AND p.prokind = 'f'
   AND p.prorettype <> 'pg_catalog.trigger'::regtype
   AND has_function_privilege('authenticated', p.oid, 'EXECUTE');

-- Part 2: behaviour.
CREATE FUNCTION pg_temp.gate(p_claims jsonb, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  result jsonb;
  outcome text;
BEGIN
  PERFORM set_config('request.jwt.claims', p_claims::text, true);
  PERFORM set_config('request.jwt.claim.sub', coalesce(p_claims->>'sub', ''), true);
  -- auth.role() reads this in older images and request.jwt.claims in newer ones; production sets both.
  PERFORM set_config('request.jwt.claim.role', coalesce(p_claims->>'role', ''), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql INTO result;
    outcome := CASE WHEN result ? 'error' AND result->>'error' = 'forbidden' THEN 'denied' ELSE 'allowed' END;
    RAISE EXCEPTION 'gate-rollback';
  EXCEPTION
    WHEN insufficient_privilege THEN outcome := 'denied';
    WHEN OTHERS THEN
      IF SQLERRM = 'gate-rollback' THEN NULL;
      ELSIF SQLERRM ~* '^(not a member of organization|not authorized to post journal entry)' THEN outcome := 'denied';
      ELSE outcome := 'allowed';  -- the gate let the caller through; a later data check stopped it
      END IF;
  END;
  EXECUTE 'RESET ROLE';
  RETURN outcome;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
INSERT INTO ids VALUES
  ('org_a', 'aa000000-0000-4000-8000-000000000001'), ('org_b', 'bb000000-0000-4000-8000-000000000001'),
  ('owner', 'a1000000-0000-4000-8000-000000000001'), ('admin', 'a1000000-0000-4000-8000-000000000002'),
  ('accountant', 'a1000000-0000-4000-8000-000000000003'), ('employee', 'a1000000-0000-4000-8000-000000000004'),
  ('viewer', 'a1000000-0000-4000-8000-000000000005'), ('pending_admin', 'a1000000-0000-4000-8000-000000000006'),
  ('outsider', 'a1000000-0000-4000-8000-000000000007'),
  ('conn', 'c0000000-0000-4000-8000-000000000001'), ('account', 'c1000000-0000-4000-8000-000000000001'),
  ('txn', 'c2000000-0000-4000-8000-000000000001'), ('journal', 'c3000000-0000-4000-8000-000000000001'),
  ('bill', 'c4000000-0000-4000-8000-000000000001'), ('customer', 'c5000000-0000-4000-8000-000000000001'),
  ('invoice', 'c6000000-0000-4000-8000-000000000001'), ('staff', 'c7000000-0000-4000-8000-000000000001');
CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;
-- Users by name, or 'machine_a': the organisation-pinned machine token (no user) that server code mints for org A.
CREATE FUNCTION pg_temp.claims(who text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE who
    WHEN 'machine_a' THEN jsonb_build_object('role', 'authenticated', 'aud', 'authenticated', 'organization_id', pg_temp.id('org_a'))
    ELSE jsonb_build_object('sub', pg_temp.id(who), 'role', 'authenticated')
  END $$;

INSERT INTO auth.users (id, email, aud, role)
SELECT v, k || '@example.test', 'authenticated', 'authenticated' FROM ids
 WHERE k IN ('owner', 'admin', 'accountant', 'employee', 'viewer', 'pending_admin', 'outsider');
INSERT INTO public.organizations (id, name) VALUES (pg_temp.id('org_a'), 'Org A'), (pg_temp.id('org_b'), 'Org B');
-- Org A: one user per role. Org B: everyone except the outsider has the SAME role there too, so moving an employee
-- between A and B tests the role, not missing access; the outsider is only an owner of org B.
INSERT INTO public.organization_memberships (user_id, organization_id, role, role_enum, accepted_at)
SELECT pg_temp.id(u.k), o.org, u.legacy::public.membership_role, u.role::public.org_role, u.accepted
  FROM (VALUES ('owner', 'owner', 'owner', now()), ('admin', 'admin', 'admin', now()), ('accountant', 'member', 'accountant', now()),
               ('employee', 'member', 'employee', now()), ('viewer', 'member', 'viewer', now()),
               ('pending_admin', 'admin', 'admin', NULL::timestamptz)) AS u(k, legacy, role, accepted)
 CROSS JOIN (VALUES (pg_temp.id('org_a')), (pg_temp.id('org_b'))) AS o(org);
INSERT INTO public.organization_memberships (user_id, organization_id, role, role_enum, accepted_at)
  VALUES (pg_temp.id('outsider'), pg_temp.id('org_b'), 'owner', 'owner', now());

INSERT INTO public.bank_connections (id, organization_id, provider, encrypted_access_token)
  VALUES (pg_temp.id('conn'), pg_temp.id('org_a'), 'manual', 'x');
INSERT INTO public.bank_accounts (id, organization_id, bank_connection_id, external_id, name)
  VALUES (pg_temp.id('account'), pg_temp.id('org_a'), pg_temp.id('conn'), 'acct-1', 'Everyday');
INSERT INTO public.bank_transactions (id, organization_id, bank_account_id, external_id, posted_at, description, amount_cents)
  VALUES (pg_temp.id('txn'), pg_temp.id('org_a'), pg_temp.id('account'), 'txn-1', now(), 'Payment', -1100);
INSERT INTO public.journal_entries (id, organization_id) VALUES (pg_temp.id('journal'), pg_temp.id('org_a'));
DO $$
DECLARE src text := (SELECT e.enumlabel FROM pg_attribute a JOIN pg_enum e ON e.enumtypid = a.atttypid
                      WHERE a.attrelid = 'public.bills'::regclass AND a.attname = 'source' ORDER BY e.enumsortorder LIMIT 1);
BEGIN
  EXECUTE format('INSERT INTO public.bills (id, organization_id, source, storage_key, original_filename, mime_type) VALUES (%L, %L, %L, %L, %L, %L)',
                 pg_temp.id('bill'), pg_temp.id('org_a'), src, 'a/1', 'bill.pdf', 'application/pdf');
END $$;
INSERT INTO public.customers (id, organization_id, name) VALUES (pg_temp.id('customer'), pg_temp.id('org_a'), 'Customer');
INSERT INTO public.invoices (id, organization_id, invoice_number, customer_id, due_date)
  VALUES (pg_temp.id('invoice'), pg_temp.id('org_a'), 'INV-D-1', pg_temp.id('customer'), DATE '2030-01-31');
INSERT INTO public.employees (id, organization_id, full_name) VALUES (pg_temp.id('staff'), pg_temp.id('org_a'), 'Staff Member');

CREATE TEMP TABLE cases (fn text, min_role text, sql text);
INSERT INTO cases VALUES
  ('post_journal_entry', 'accountant', format('SELECT to_jsonb(public.post_journal_entry(%L))', pg_temp.id('journal'))),
  ('reconcile_match_bill', 'accountant', format('SELECT to_jsonb(public.reconcile_match_bill(%L, %L))', pg_temp.id('txn'), pg_temp.id('bill'))),
  ('reconcile_match_invoice', 'accountant', format('SELECT to_jsonb(public.reconcile_match_invoice(%L, %L, 1100))', pg_temp.id('txn'), pg_temp.id('invoice'))),
  ('reconcile_undo_match', 'accountant', format('SELECT to_jsonb(public.reconcile_undo_match(%L))', pg_temp.id('txn'))),
  ('bulk_accept_job_suggestions', 'accountant', format('SELECT to_jsonb(public.bulk_accept_job_suggestions(%L, 0.85))', pg_temp.id('org_a'))),
  ('rematch_unallocated_bills', 'accountant', format('SELECT to_jsonb(public.rematch_unallocated_bills(%L, 10))', pg_temp.id('org_a'))),
  ('move_employee_to_org', 'admin', format('SELECT to_jsonb(public.move_employee_to_org(%L, %L))', pg_temp.id('staff'), pg_temp.id('org_b')));

CREATE TEMP TABLE ranks (role text PRIMARY KEY, rank int);
INSERT INTO ranks VALUES ('viewer', 0), ('employee', 1), ('accountant', 2), ('admin', 3), ('owner', 4);

CREATE TEMP TABLE results AS
SELECT c.fn, u.who,
       CASE WHEN u.who = 'machine_a' THEN CASE WHEN c.fn = 'move_employee_to_org' THEN 'denied' ELSE 'allowed' END
            WHEN u.rank IS NOT NULL AND u.rank >= (SELECT rank FROM ranks WHERE role = c.min_role) THEN 'allowed' ELSE 'denied' END AS expected,
       pg_temp.gate(pg_temp.claims(u.who), c.sql) AS actual
  FROM cases c
 CROSS JOIN (VALUES ('owner', 4), ('admin', 3), ('accountant', 2), ('employee', 1), ('viewer', 0),
                    ('pending_admin', NULL), ('outsider', NULL), ('machine_a', NULL)) AS u(who, rank);
-- The machine token keeps its previous access to its own organisation (it cannot reach org B, so it cannot move
-- an employee there).

DO $$
DECLARE
  r record;
  bad text := '';
BEGIN
  FOR r IN SELECT * FROM audit WHERE writes IS NOT NULL AND NOT role_check ORDER BY proname LOOP
    bad := bad || format(E'\n  audit: %s writes %s without a role check', r.proname, r.writes);
  END LOOP;
  FOR r IN SELECT * FROM results WHERE actual IS DISTINCT FROM expected ORDER BY fn, who LOOP
    bad := bad || format(E'\n  %s as %s: expected %s, got %s', r.fn, r.who, r.expected, r.actual);
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'definer write-role checks failed:%', bad;
  END IF;
  RAISE NOTICE 'definer write roles: % audited functions gated, % call probes as expected',
    (SELECT count(*) FROM audit WHERE writes IS NOT NULL), (SELECT count(*) FROM results);
END $$;

ROLLBACK;
