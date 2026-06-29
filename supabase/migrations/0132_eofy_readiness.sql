-- 0132_eofy_readiness.sql — SC-4.A.01 (Phase 4, EOFY orchestration)
--
-- eofy_readiness(org, fy_start_year) — a READ-ONLY structured readiness report for
-- closing a financial year. NO mutations (STABLE, no writes) so the orchestrator
-- (SC-4.A.02) can call it as a safe, idempotent pre-flight. Returns jsonb:
--   open_period_count      — FY months NOT covered by an active period_locks lock
--   unreconciled_count     — business bank txns in the FY not matched to a bill/
--                            invoice and not manually matched
--   uncoded_count          — business bank txns in the FY with no match AND no
--                            category code (auto_category_code / category_external)
--   trial_balance_*        — books-health PROXY: does v_trial_balance (the real GL,
--                            0074) balance to zero?
--   books_health_available — false: the dedicated Phase-1 books-health fn
--                            (SC-1.A.01/02) is NOT yet landed, so this degrades to
--                            the coverage checks above. WIRING HOOK: when it lands,
--                            call it here and fold its verdict into `ready`.
--   ready                  — all gates green (no open periods, nothing unreconciled
--                            or uncoded, TB balances)
--   blockers               — human-readable reasons it is not ready
--
-- SECURITY INVOKER: every read (period_locks 0001, bank_transactions, v_trial_balance
-- 0074) is RLS-scoped to the caller, so a foreign org returns a safe empty/not-ready
-- report rather than leaking. Verified live schemas before writing.
--
-- MIGRATION NUMBER: Phase-4 plan said 0123, but 0123–0131 are taken (Phase-3 drift
-- reassignments); reassigned to 0132 per the drift rule.

create or replace function public.eofy_readiness(p_org uuid, p_fy_start_year integer)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fy_start    date := make_date(p_fy_start_year, 7, 1);
  v_fy_end      date := make_date(p_fy_start_year + 1, 6, 30);
  v_open        int;
  v_unreconciled int;
  v_uncoded     int;
  v_tb_net      bigint;
  v_tb_balanced boolean;
  v_blockers    text[] := '{}';
  v_ready       boolean;
begin
  -- Open periods: the 12 FY months not contained in an ACTIVE lock (locked, not unlocked).
  select count(*) into v_open
  from generate_series(v_fy_start, make_date(p_fy_start_year + 1, 6, 1), interval '1 month') m(ms)
  where not exists (
    select 1 from period_locks pl
    where pl.organization_id = p_org
      and pl.locked_at is not null and pl.unlocked_at is null
      and m.ms::date between pl.period_start and pl.period_end
  );

  -- Unreconciled + uncoded business bank txns in the FY, in ONE scan. Both share the
  -- business-txn-in-FY / no-bill-or-invoice-match base and diverge on the final test:
  -- unreconciled = not manually matched either; uncoded = no category code either.
  select
    count(*) filter (where coalesce(bt.manually_matched, false) = false)                  as unreconciled,
    count(*) filter (where bt.auto_category_code is null and bt.category_external is null) as uncoded
  into v_unreconciled, v_uncoded
  from bank_transactions bt
  where bt.organization_id = p_org
    and bt.posted_at::date between v_fy_start and v_fy_end
    and coalesce(bt.is_personal, false) = false
    and bt.matched_bill_id is null and bt.matched_invoice_id is null;

  -- Books-health proxy: the real GL trial balance (0074) must net to zero.
  select coalesce(sum(net_cents), 0) into v_tb_net from v_trial_balance where organization_id = p_org;
  v_tb_balanced := (v_tb_net = 0);

  if v_open > 0 then
    v_blockers := v_blockers || format('%s period(s) still open — lock the FY before closing', v_open);
  end if;
  if v_unreconciled > 0 then
    v_blockers := v_blockers || format('%s unreconciled bank transaction(s)', v_unreconciled);
  end if;
  if v_uncoded > 0 then
    v_blockers := v_blockers || format('%s uncoded bank transaction(s)', v_uncoded);
  end if;
  if not v_tb_balanced then
    v_blockers := v_blockers || format('trial balance does not balance (out by %s cents)', v_tb_net);
  end if;

  v_ready := (v_open = 0 and v_unreconciled = 0 and v_uncoded = 0 and v_tb_balanced);

  return jsonb_build_object(
    'organization_id', p_org,
    'fy_start_year', p_fy_start_year,
    'period_start', v_fy_start,
    'period_end', v_fy_end,
    'open_period_count', v_open,
    'unreconciled_count', v_unreconciled,
    'uncoded_count', v_uncoded,
    'trial_balance_net_cents', v_tb_net,
    'trial_balance_balanced', v_tb_balanced,
    'books_health_available', false,
    'ready', v_ready,
    'blockers', to_jsonb(v_blockers)
  );
end;
$$;

comment on function public.eofy_readiness(uuid, integer) is
  'READ-ONLY EOFY readiness report (jsonb) for an org+FY: open periods, unreconciled '
  '+ uncoded bank txns, trial-balance health, and a ready flag. No mutations. The '
  'dedicated Phase-1 books-health fn is not yet landed — degrades to a TB-balances '
  'proxy (books_health_available=false); wire it in when SC-1.A lands. SECURITY INVOKER.';

revoke all on function public.eofy_readiness(uuid, integer) from public, anon;
grant execute on function public.eofy_readiness(uuid, integer) to authenticated;
