-- 0137_eofy_orchestrate.sql — SC-4.A.02 (Phase 4, EOFY orchestration)
--
-- generate_eofy_pack(org, fy_start_year) — the single "bring the books to EOFY state"
-- RPC. For the AU financial year (1 Jul fy_start_year → 30 Jun next) it sequences:
--   1. close-all-periods + depreciation true-up  — close_period (SC-1.J.02, 0100) for
--      each of the 12 FY months. close_period ALREADY posts that month's depreciation
--      (Dr 6700 / Cr 1900, idempotent — same loop + idempotency key as the
--      depreciation-run edge fn, see 0100:300-369 and its own comment at 0100:208-212),
--      posts the month-end journals, and writes the period_locks row. So this RPC does
--      the depreciation step BY COMPOSITION — it does NOT need the SC-1.G.02 edge fn
--      (that was the resolution of the original SC-4.A.02 architecture block: the
--      depreciation true-up has a SQL posting path after all — inside close_period).
--   2. accrual finalisation  — compose detect_recurring_bills (SC-1.I.01) +
--      accrue_recurring_bill (SC-1.I.02). Only multi-period cadences (quarterly /
--      semi_annual / yearly) need straight-lining; accrue_recurring_bill is idempotent
--      (NULL periods derive from cadence) so a re-run or cron overlap never double-posts.
--   3. readiness  — return the eofy_readiness probe (SC-4.A.01, 0132) over the trued-up
--      books, plus a per-month close summary and an accrual summary.
--
-- BOOKS-HEALTH GATE: if v_books_health.blocking (SC-1.A.02) the RPC RAISES rather than
-- limping through 12 guaranteed-to-refuse close_period calls — the books must be coded
-- and reconciled before an EOFY close is meaningful. (A missing v_books_health row under
-- SECURITY INVOKER == the caller cannot access the org → also RAISE.)
--
-- BEST-EFFORT, IDEMPOTENT, RE-RUNNABLE: each close_period and each accrual is wrapped in
-- its own subtransaction so one bad month / series is collected as an exception, never
-- aborting the whole EOFY run (mirrors close_period's own per-schedule handler). Every
-- composed RPC is idempotent (close_period → already_locked; accrue_recurring_bill →
-- reused), so generate_eofy_pack can be re-run safely until ready=true.
--
-- NOT GATED BY APPROVALS: this is EOFY *prep*, not a lodgement or a money-mover. It posts
-- only month-end accounting journals via close_period, which is itself Tier-1 "notify, not
-- approvals-gated" (SC-1.J.02). The actual lodgement gate lands in Phase-7 SC-7.E.
--
-- DIV 7A HOOK (deliberately NOT here — Phase-5 SC-5.E): owner-loan / Division 7A true-ups
-- are a separate engine. SC-5.E wires an extra step in here WITHOUT a contract change —
-- see the "-- TODO(SC-5.E)" marker below.
--
-- SECURITY INVOKER (matches close_period / the read probes): RLS scopes every read to the
-- caller, and the posting inside close_period goes through post_journal_entry (SECURITY
-- DEFINER) which re-checks org access — so an authenticated member drives it under their
-- identity, and a backend driver must call through an org-scoped token (as the crons do).
-- MIGRATION NUMBER: Phase-4 plan said 0124, taken; 0137 per the drift rule (repo head 0136).

create or replace function public.generate_eofy_pack(p_org uuid, p_fy_start_year integer)
  returns jsonb
  language plpgsql
  security invoker
  set search_path = public
as $$
declare
  v_period_start date := make_date(p_fy_start_year, 7, 1);
  v_period_end   date := make_date(p_fy_start_year + 1, 6, 30);
  v_score        integer;
  v_blocking     boolean;
  v_month        date;
  v_close        jsonb;
  v_closes       jsonb := '[]'::jsonb;
  v_refusals     jsonb := '[]'::jsonb;
  v_total        integer;
  v_refused      integer;
  v_series       record;
  v_bill_id      uuid;
  v_acc_scanned  integer := 0;
  v_acc_done     integer := 0;
  v_acc_errors   jsonb := '[]'::jsonb;
  v_readiness    jsonb;
begin
  -- Books-health gate. v_books_health (SECURITY INVOKER) only exposes the caller's orgs,
  -- so a missing row == not authorized for this org.
  select score, blocking into v_score, v_blocking
    from public.v_books_health
   where organization_id = p_org;
  if not found then
    raise exception 'generate_eofy_pack: org % not found or not accessible', p_org;
  end if;
  if v_blocking then
    raise exception
      'generate_eofy_pack: books-health score % is blocking for org %; resolve coding/reconciliation gaps before EOFY close',
      v_score, p_org;
  end if;

  -- 1. Close-all-periods + depreciation true-up. close_period posts the month's
  --    depreciation + month-end journals and locks; an already-locked or refused month is
  --    collected (not fatal). A subtransaction isolates an unexpected RAISE to its month.
  --    (close_period owns the depreciation posting loop today; the non-fragile form — a
  --    shared post_period_depreciation(org, period) RPC called by both close_period and the
  --    depreciation-run edge fn — is deferred, see 0100:208-212 + the SC-3.B account map.)
  for v_month in
    select gs::date from generate_series(v_period_start, v_period_end, interval '1 month') gs
  loop
    begin
      v_close := public.close_period(p_org, v_month);
    exception when others then
      v_close := jsonb_build_object('ok', false, 'status', 'error',
                   'reason', 'close_period_raised', 'message', sqlerrm);
    end;

    v_closes := v_closes || jsonb_build_object(
      'month', to_char(v_month, 'YYYY-MM'),
      'status', v_close->>'status',
      'depreciation', v_close->'depreciation');

    -- A month is "closed" iff close_period locked it ('closed') or it was already locked;
    -- anything else (refused / error) is collected for the readiness consumer.
    if coalesce(v_close->>'status', 'unknown') not in ('closed', 'already_locked') then
      v_refusals := v_refusals || jsonb_build_object(
        'month', to_char(v_month, 'YYYY-MM'),
        'status', v_close->>'status',
        'reason', v_close->>'reason',
        'detail', v_close);
    end if;
  end loop;

  -- 2. Accrual finalisation. Only multi-period cadences need straight-lining; accrue the
  --    most-recent member bill of each detected series (idempotent). Best-effort per series.
  --    Per-bill expense mapping uses accrue_recurring_bill's default (6900); reversing
  --    accruals net to zero across the FY, so the annual result is unaffected.
  for v_series in
    select cadence, bill_ids
      from public.detect_recurring_bills(p_org)
     where cadence in ('quarterly', 'semi_annual', 'yearly')
       and bill_ids is not null
       and array_length(bill_ids, 1) > 0
  loop
    v_acc_scanned := v_acc_scanned + 1;
    v_bill_id := v_series.bill_ids[array_upper(v_series.bill_ids, 1)];  -- most-recent member bill
    begin
      perform public.accrue_recurring_bill(v_bill_id);
      v_acc_done := v_acc_done + 1;
    exception when others then
      v_acc_errors := v_acc_errors || jsonb_build_object('bill_id', v_bill_id, 'error', sqlerrm);
    end;
  end loop;

  -- TODO(SC-5.E): Division 7A owner-loan true-up wires in here — append its result to the
  -- payload below without changing this function's (org, fy_start_year) -> jsonb contract.

  -- 3. Readiness over the trued-up books (SC-4.A.01).
  v_readiness := public.eofy_readiness(p_org, p_fy_start_year);

  -- Month counts derived from the source-of-truth arrays (v_closes = every month attempted).
  v_total   := jsonb_array_length(v_closes);
  v_refused := jsonb_array_length(v_refusals);

  return jsonb_build_object(
    'organization_id', p_org,
    'fy_start_year', p_fy_start_year,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'books_health', jsonb_build_object('score', v_score, 'blocking', false),
    'close', jsonb_build_object(
      'months_closed', v_total - v_refused,
      'months_refused', v_refused,
      'months', v_closes,
      'refusals', v_refusals),
    'accruals', jsonb_build_object(
      'series_scanned', v_acc_scanned,
      'accrued', v_acc_done,
      'errors', v_acc_errors),
    'readiness', v_readiness,
    'ready', coalesce((v_readiness->>'ready')::boolean, false),
    'message', format(
      'EOFY %s-%s: %s/%s months closed, %s accrual series finalised; readiness=%s',
      p_fy_start_year, p_fy_start_year + 1, v_total - v_refused, v_total,
      v_acc_done, coalesce(v_readiness->>'ready', 'unknown'))
  );
end;
$$;

comment on function public.generate_eofy_pack(uuid, integer) is
  'SC-4.A.02: brings the books to EOFY state for an AU FY and returns a readiness pack. '
  'Sequences close_period (SC-1.J.02) over the 12 FY months — which trues up depreciation '
  '(Dr 6700/Cr 1900) + month-end and locks each month — then finalises recurring-bill '
  'accruals (detect_recurring_bills + accrue_recurring_bill, idempotent), and returns the '
  'eofy_readiness probe (SC-4.A.01) plus per-month close + accrual summaries. RAISES if '
  'v_books_health is blocking (or the org is inaccessible). Best-effort + idempotent, so '
  're-runnable. EOFY prep, not an approvals-gated lodgement. SECURITY INVOKER.';

revoke all on function public.generate_eofy_pack(uuid, integer) from public, anon;
grant execute on function public.generate_eofy_pack(uuid, integer) to authenticated;

-- New client-callable RPC (the SC-4.C EOFY wizard / pack edge fn will call it): refresh
-- PostgREST's schema cache so rpc() reaches it on deploy (matches 0094/0098/0100).
notify pgrst, 'reload schema';
