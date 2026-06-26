-- 0115: harden match_legal_corpus grants (security-advisor fix).
--
-- 0109 (SC-LC.B.01) predates the DEFINER-fn grant gotcha: this project's default
-- privileges GRANT EXECUTE on new public functions to authenticated + anon DIRECTLY,
-- so 0109's `REVOKE ALL ... FROM PUBLIC` alone left `anon` able to execute this
-- SECURITY DEFINER fn (which bypasses RLS) — an unauthenticated caller could read
-- corpus law that legal_corpus's authenticated-only SELECT policy would otherwise
-- block. The Supabase security advisor flags this as
-- `anon_security_definer_function_executable`. Revoke anon explicitly; authenticated
-- (future UI) + service_role (ask-bot) keep EXECUTE by design — the fn is read-only
-- over world-readable, CC-BY public law, so no privilege escalation for them.

REVOKE ALL ON FUNCTION public.match_legal_corpus(vector, int, int, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_legal_corpus(vector, int, int, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
