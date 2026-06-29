-- 0190_realtime_receipt_events.sql
-- Stream new receipt events to the Receipt Hub UI without a manual refetch.
-- Adds receipt_events to the supabase_realtime publication so postgres_changes fires on insert/
-- update. RLS still applies to realtime (the 0088 receipt_events_select policy scopes rows to
-- get_accessible_org_ids()), so a client only receives events for orgs it can access. REPLICA
-- IDENTITY FULL ensures UPDATE/DELETE payloads carry the row's identifying columns for filtering.
-- Guarded so re-running is safe if the table is already published.

ALTER TABLE public.receipt_events REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'receipt_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.receipt_events;
  END IF;
END;
$$;
