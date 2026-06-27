-- 0158_distribution_persist.sql — SC-5.C.04 (Phase 5, Trusts — persist proposal)
--
-- distribution_persist(org, fy[, trust]) — writes the streaming overlay's proposal
-- (SC-5.C.03 stream_trust_distribution) into trust_distributions (SC-5.A.03) as
-- status='draft' rows. The terminal step of the distribution engine's PROPOSE phase:
-- the engine computes (net income → optimise → stream) read-only, and this slice
-- materialises the result so the distribution minute (SC-5.D) and the approve-to-
-- finalise gate (SC-5.D.02, blocked on the SC-2 approvals queue) have stable draft
-- rows to act on. NO finalisation here — draft is the only state this writes.
--
-- ── COMPONENTS DROP IN UNCHANGED ───────────────────────────────────────────────
-- stream_trust_distribution constructs every beneficiary's components so that
--   amount_cents = capital_gain_cents + franked_dividend_cents + other_cents
-- and all five money columns (incl. franking_credits_cents) are non-negative BY
-- CONSTRUCTION (SC-5.C.03 header). Those are exactly the trust_distributions CHECKs
-- (trust_distributions_components_sum / _non_negative), so the streamed[] rows persist
-- verbatim — no re-derivation, rounding, or re-balancing here. This slice is a thin
-- writer over the overlay's output, mirroring how SC-5.C.03 is a thin overlay over the
-- core: each layer keeps the one below authoritative.
--
-- ── IDEMPOTENT: RE-RUN REPLACES DRAFTS, NEVER DUPLICATES ───────────────────────
-- The proposal is cheap to recompute and the optimiser may run many times before a
-- distribution is approved. Re-running for the same (trust, fy) must converge, not
-- accumulate. So we SOFT-DELETE the org+trust+fy's existing live DRAFT rows (set
-- deleted_at) and insert the fresh proposal. Soft-delete (not hard delete) keeps the
-- audit trail (audit_log_trigger_v2 fires on the update) and matches the house
-- soft-delete convention (0151/0152/0153).
--
-- Only status='draft' rows are replaced. 'approved' and 'finalised' rows are governed
-- by the approvals gate (SC-2) and the distribution minute (SC-5.D) — re-running the
-- optimiser must never disturb a distribution a human has already approved or finalised.
-- (The trust_distributions_one_final_per_beneficiary_fy unique index is scoped to
-- status='finalised', so any number of drafts coexist freely.)
--
-- ── WHICH BENEFICIARIES GET A ROW ──────────────────────────────────────────────
-- A draft row is written for every beneficiary that actually RECEIVES something —
-- amount_cents > 0 OR franking_credits_cents > 0 (a beneficiary can carry an attached
-- credit even where the cash/corpus split leaves amount small). Beneficiaries the
-- proposal allocated nothing to (deed-excluded, pass-through, or simply not filled by
-- the water-fill) produce NO row: an absent distribution is the correct representation
-- of "received nothing", and writing zero-everything rows would just be noise the
-- minute and the UI would have to filter. The trustee-retained residual (s99A) is NOT
-- a beneficiary distribution and is likewise not written — it is surfaced in the return
-- payload for the minute to narrate.
--
-- ── SECURITY ───────────────────────────────────────────────────────────────────
-- SECURITY INVOKER (the trust chain posture, 0154–0157) — so the function writes only
-- within the caller's accessible orgs: every INSERT/UPDATE is gated by
-- trust_distributions' own RLS write policies (organization_id IN get_accessible_org_ids()),
-- and the read it is built on (stream_trust_distribution) is INVOKER too, so a foreign
-- org degrades to an empty proposal and writes nothing. No SECURITY DEFINER, so there is
-- no cross-tenant write surface and no definer-fn grant to revoke. VOLATILE (it writes).
--
-- MIGRATION NUMBER: the ledger Files line planned 0149, long taken (book_to_tax_cgt_
-- losses). Reassigned to 0158 per the drift rule — the sequential repo head is
-- 0157_distribution_streaming (0178/0179 are late hotfixes that sort after). Verified
-- live (dxoikltymmknxqpkpyhi, read-only): distribution_persist ABSENT and the whole
-- 0151–0157 trust chain (trust_distributions, trusts, trust_beneficiaries, trust_deed,
-- stream_trust_distribution, optimise_trust_distribution, distribution_inputs,
-- trust_net_income) committed-but-NOT-deployed (deploys together) — no drift;
-- get_accessible_org_ids/set_updated_at/audit_log_trigger_v2 all present live.

create or replace function public.distribution_persist(
    p_org uuid, p_fy_start_year integer, p_trust uuid default null)
  returns jsonb
  language plpgsql
  volatile
  security invoker
  set search_path = public
as $$
declare
  v_proposal jsonb;   -- stream_trust_distribution (SC-5.C.03) output
  v_trust    uuid;
  v_replaced int := 0;
  v_inserted int := 0;
  v_persisted jsonb;  -- the rows just written (from INSERT ... RETURNING), for confirmation
  v_result   jsonb;
begin
  -- 1. Compute the proposal (net income → optimise → stream). Delegating to the overlay
  --    means the trust resolution + the multi-active-trust error raise there once, and
  --    the components arrive already CHECK-clean. INVOKER all the way down → RLS-scoped.
  v_proposal := stream_trust_distribution(p_org, p_fy_start_year, p_trust);
  v_trust    := (v_proposal ->> 'trust_id')::uuid;

  -- 2. Idempotent replace: retire this (org, trust, fy)'s existing live DRAFT rows so the
  --    re-run converges. 'approved'/'finalised' rows are left untouched (governed by the
  --    approvals gate / minute, not the optimiser).
  update public.trust_distributions
     set deleted_at = now()
   where organization_id = p_org
     and trust_id        = v_trust
     and financial_year  = p_fy_start_year
     and status          = 'draft'
     and deleted_at is null;
  get diagnostics v_replaced = row_count;

  -- 3. Insert the fresh draft rows — one per beneficiary that actually receives something.
  --    Components persist verbatim (already CHECK-clean from the overlay). The INSERT's
  --    RETURNING feeds BOTH the written-count and the confirmation payload in one pass, so
  --    there is no read-back scan of the rows we just wrote.
  with rows_in as (
    select
      (s ->> 'beneficiary_id')::uuid                          as beneficiary_id,
      coalesce((s ->> 'amount_cents')::bigint, 0)             as amount_cents,
      coalesce((s ->> 'capital_gain_cents')::bigint, 0)       as capital_gain_cents,
      coalesce((s ->> 'franked_dividend_cents')::bigint, 0)   as franked_dividend_cents,
      coalesce((s ->> 'other_cents')::bigint, 0)              as other_cents,
      coalesce((s ->> 'franking_credits_cents')::bigint, 0)   as franking_credits_cents
    from jsonb_array_elements(v_proposal -> 'streamed') as s
  ),
  ins as (
    insert into public.trust_distributions (
      organization_id, trust_id, beneficiary_id, financial_year,
      amount_cents, capital_gain_cents, franked_dividend_cents, other_cents,
      franking_credits_cents, status, created_by
    )
    select
      p_org, v_trust, r.beneficiary_id, p_fy_start_year,
      r.amount_cents, r.capital_gain_cents, r.franked_dividend_cents, r.other_cents,
      r.franking_credits_cents, 'draft', auth.uid()
    from rows_in r
    -- A beneficiary the proposal gave nothing (deed-excluded / pass-through / unfilled)
    -- produces no row; a non-zero attached credit alone still warrants one.
    where r.amount_cents > 0 or r.franking_credits_cents > 0
    returning beneficiary_id, amount_cents, capital_gain_cents,
              franked_dividend_cents, other_cents, franking_credits_cents, status
  )
  select
    count(*),
    coalesce(jsonb_agg(jsonb_build_object(
      'beneficiary_id',         beneficiary_id,
      'amount_cents',           amount_cents,
      'capital_gain_cents',     capital_gain_cents,
      'franked_dividend_cents', franked_dividend_cents,
      'other_cents',            other_cents,
      'franking_credits_cents', franking_credits_cents,
      'status',                 status
    ) order by amount_cents desc, beneficiary_id), '[]'::jsonb)
  into v_inserted, v_persisted
  from ins;

  -- 4. Summary: what was written + the proposal's reconciliation flags/totals passed
  --    through (so a caller persists and confirms in one round-trip). trustee_retained
  --    is echoed but intentionally NOT persisted (it is not a beneficiary distribution).
  v_result := jsonb_build_object(
    'ok',                true,
    'organization_id',   p_org,
    'trust_id',          v_trust,
    'fy_start_year',     p_fy_start_year,
    'period_start',      v_proposal ->> 'period_start',
    'period_end',        v_proposal ->> 'period_end',
    'status',            'draft',
    'method',            v_proposal ->> 'method',
    'streaming_allowed', (v_proposal ->> 'streaming_allowed')::boolean,
    'drafts_replaced',   v_replaced,
    'drafts_written',    v_inserted,
    'totals',            v_proposal -> 'totals',
    'income_classes',    v_proposal -> 'income_classes',
    'persisted',         v_persisted,
    'note', 'Persisted the streaming proposal (SC-5.C.03) into trust_distributions as draft '
            'rows (SC-5.C.04). Re-running replaces this trust+FY''s prior drafts (soft-deleted), '
            'never approved/finalised rows. Components are written verbatim from the overlay '
            '(CHECK-clean). Finalisation is gated by the approvals queue (SC-5.D.02).'
  );

  return v_result;
end;
$$;

comment on function public.distribution_persist(uuid, integer, uuid) is
  'SC-5.C.04: persists stream_trust_distribution''s proposal (SC-5.C.03) into '
  'trust_distributions (SC-5.A.03) as status=''draft'' rows — one per beneficiary that '
  'receives something (amount_cents > 0 or franking_credits_cents > 0). Idempotent: a '
  're-run soft-deletes this (org, trust, fy)''s prior live DRAFT rows and re-inserts, so '
  'it converges instead of duplicating; approved/finalised rows are never touched. '
  'Components persist verbatim (already CHECK-clean). SECURITY INVOKER — the table''s RLS '
  'write policies scope every write to the caller''s org; no SECURITY DEFINER, no cross-'
  'tenant write surface. Returns a write summary + the proposal''s totals/flags. '
  'Finalisation (draft→finalised) is the approvals-gated minute slice (SC-5.D.02).';

revoke all on function public.distribution_persist(uuid, integer, uuid) from public, anon;
grant execute on function public.distribution_persist(uuid, integer, uuid) to authenticated;
