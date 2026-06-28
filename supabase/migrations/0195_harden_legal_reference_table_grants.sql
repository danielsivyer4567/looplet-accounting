-- 0195_harden_legal_reference_table_grants.sql
--
-- Repair migration for the legal-citation / RAG global reference tables. The
-- original 0108/0110/0111/0113 migrations enabled select-only RLS policies, but
-- did not revoke this project's broad default table grants from anon/authenticated.
-- RLS still denies client writes because no write policies exist, but the table
-- privilege posture should match the documented contract: authenticated users can
-- read public legal reference data; writes are service_role/backend only.

revoke all on table public.legal_corpus from public, anon, authenticated;
revoke all on table public.legal_sources from public, anon, authenticated;
revoke all on table public.legal_change_events from public, anon, authenticated;
revoke all on table public.legal_horizon from public, anon, authenticated;

grant select on table public.legal_corpus to authenticated;
grant select on table public.legal_sources to authenticated;
grant select on table public.legal_change_events to authenticated;
grant select on table public.legal_horizon to authenticated;

grant all on table public.legal_corpus to service_role;
grant all on table public.legal_sources to service_role;
grant all on table public.legal_change_events to service_role;
grant all on table public.legal_horizon to service_role;

notify pgrst, 'reload schema';
