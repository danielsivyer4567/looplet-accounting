-- BANK-06: Redbark is the bank-feed provider.
--
-- A new enum label must be committed before any statement uses it, so this is its own migration;
-- 20261003140100_redbark_bank_feed.sql uses the label. The earlier provider labels stay: historical rows and
-- migrations reference them, and Postgres cannot drop an enum label in place.
ALTER TYPE public.bank_provider ADD VALUE IF NOT EXISTS 'redbark';
