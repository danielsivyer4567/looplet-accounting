-- Tables with a set_updated_at trigger but no updated_at column fail every UPDATE with
-- 'record "new" has no field "updated_at"'. bill_line_items is one (so bill-line edits have been failing), and the
-- books work found the same on overhead_allocations. Add the column wherever the trigger exists without it, so the
-- trigger has something to set. Generic and idempotent: safe on production and on a fresh database.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass AS tbl, c.relname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
       AND p.proname IN ('set_updated_at', 'update_updated_at', 'touch_updated_at')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                        WHERE ic.table_schema = 'public' AND ic.table_name = c.relname AND ic.column_name = 'updated_at')
  LOOP
    EXECUTE format('ALTER TABLE %s ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now()', r.tbl);
    RAISE NOTICE 'added updated_at to %', r.relname;
  END LOOP;
END $$;
