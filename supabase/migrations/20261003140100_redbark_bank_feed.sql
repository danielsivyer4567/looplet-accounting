-- BANK-06: Redbark bank feeds.
--
-- Redbark is read with one server key, so whoever holds a link to a Redbark connection sees every transaction on it.
-- A Redbark connection must therefore belong to exactly one organisation, and only the bank-feed edge functions (which
-- check that the caller is an admin of an organisation allowed to use the feed) may create or change those links.
--
--   1. bank_accounts.feed_sync_from is the import-from date chosen when the account is linked; nothing earlier is
--      imported. bank_accounts.feed_covered_through is the checkpoint: the last date whose history has been imported.
--   2. (provider, external_item_id) is unique across all organisations, so one provider connection belongs to one
--      organisation. Manual imports have no external_item_id, and NULLs stay distinct.
--   3. A bank account always belongs to the organisation of its bank connection, and a connection that has accounts
--      cannot move to another organisation. These triggers run for every role, including the service role.
--   4. Signed-in users cannot insert, change or delete Redbark connections, or the accounts under them, through the
--      API. RESTRICTIVE policies are ANDed with the existing ones, so reads and manual-import writes are unchanged; the
--      service role bypasses RLS as before.

-- 1. The per-account feed window.
ALTER TABLE public.bank_accounts
  ADD COLUMN IF NOT EXISTS feed_sync_from date,
  ADD COLUMN IF NOT EXISTS feed_covered_through date;

COMMENT ON COLUMN public.bank_accounts.feed_sync_from IS
  'Bank feed import-from date chosen when the account was linked (bank-feed-link). Transactions dated earlier are not imported.';
COMMENT ON COLUMN public.bank_accounts.feed_covered_through IS
  'Bank feed checkpoint: the last date whose history has been imported. bank-sync only moves it forward.';

-- 2. One organisation per provider connection.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bank_connections_provider_external_item_id_key'
       AND conrelid = 'public.bank_connections'::regclass
  ) THEN
    ALTER TABLE public.bank_connections
      ADD CONSTRAINT bank_connections_provider_external_item_id_key UNIQUE (provider, external_item_id);
  END IF;
END $$;

-- 3. Accounts stay in the organisation of their connection.
CREATE OR REPLACE FUNCTION public.enforce_bank_account_same_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.bank_connection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.bank_connections c
     WHERE c.id = NEW.bank_connection_id AND c.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'bank account % must belong to the organisation of its bank connection', NEW.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bank_accounts_same_org ON public.bank_accounts;
CREATE TRIGGER trg_bank_accounts_same_org
  BEFORE INSERT OR UPDATE OF organization_id, bank_connection_id ON public.bank_accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_account_same_org();

CREATE OR REPLACE FUNCTION public.enforce_bank_connection_org_stable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     AND EXISTS (SELECT 1 FROM public.bank_accounts a WHERE a.bank_connection_id = NEW.id) THEN
    RAISE EXCEPTION 'bank connection % has accounts and cannot move to another organisation', NEW.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bank_connections_org_stable ON public.bank_connections;
CREATE TRIGGER trg_bank_connections_org_stable
  BEFORE UPDATE OF organization_id ON public.bank_connections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_connection_org_stable();

-- 4. Redbark links are written only by the bank-feed edge functions.
-- SECURITY DEFINER so the check sees the connection whatever the caller's own RLS view of it.
CREATE OR REPLACE FUNCTION public.is_redbark_bank_connection(p_connection_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.bank_connections c
     WHERE c.id = p_connection_id AND c.provider = 'redbark'::public.bank_provider
  );
$$;

REVOKE ALL ON FUNCTION public.is_redbark_bank_connection(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_redbark_bank_connection(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS bank_connections_feed_insert ON public.bank_connections;
DROP POLICY IF EXISTS bank_connections_feed_update ON public.bank_connections;
DROP POLICY IF EXISTS bank_connections_feed_delete ON public.bank_connections;
DROP POLICY IF EXISTS bank_accounts_feed_insert ON public.bank_accounts;
DROP POLICY IF EXISTS bank_accounts_feed_update ON public.bank_accounts;
DROP POLICY IF EXISTS bank_accounts_feed_delete ON public.bank_accounts;

CREATE POLICY bank_connections_feed_insert ON public.bank_connections AS RESTRICTIVE FOR INSERT TO public
  WITH CHECK (provider <> 'redbark'::public.bank_provider);
CREATE POLICY bank_connections_feed_update ON public.bank_connections AS RESTRICTIVE FOR UPDATE TO public
  USING (provider <> 'redbark'::public.bank_provider)
  WITH CHECK (provider <> 'redbark'::public.bank_provider);
CREATE POLICY bank_connections_feed_delete ON public.bank_connections AS RESTRICTIVE FOR DELETE TO public
  USING (provider <> 'redbark'::public.bank_provider);

CREATE POLICY bank_accounts_feed_insert ON public.bank_accounts AS RESTRICTIVE FOR INSERT TO public
  WITH CHECK (NOT public.is_redbark_bank_connection(bank_connection_id));
CREATE POLICY bank_accounts_feed_update ON public.bank_accounts AS RESTRICTIVE FOR UPDATE TO public
  USING (NOT public.is_redbark_bank_connection(bank_connection_id))
  WITH CHECK (NOT public.is_redbark_bank_connection(bank_connection_id));
CREATE POLICY bank_accounts_feed_delete ON public.bank_accounts AS RESTRICTIVE FOR DELETE TO public
  USING (NOT public.is_redbark_bank_connection(bank_connection_id));
