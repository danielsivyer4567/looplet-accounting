-- 20260702180000_drop_orphaned_bank_webhook_events.sql
--
-- bank_webhook_events (0212_basiq_durability.sql) was designed as the
-- persist-before-ack store for inbound Basiq webhooks, but bank-webhook's
-- actual handler was built against bank_events_raw (0217_raw_bank_events.sql)
-- instead and never wrote to this table. Confirmed zero rows live. Two
-- similarly-named, similarly-purposed tables where only one is real is a
-- footgun for future work — drop the dead one. bank_events_raw remains the
-- single canonical raw-webhook-event store.

drop table if exists public.bank_webhook_events;
