-- AP automation → exception review
--
-- Adds bill-level confidence lookups so the Bills page can show automation
-- confidence badges and quick-confirm buttons alongside each bill.

-- Returns the latest automation decision for a given set of bill IDs.
-- Callers pass an array of bill UUIDs; the RPC returns the most recent
-- automation_decision per bill (if any).
create or replace function get_bill_decisions(p_bill_ids uuid[])
returns table (
  bill_id uuid,
  decision_id uuid,
  confidence automation_confidence,
  decision_kind text,
  suggested_treatment jsonb,
  reason_codes text[],
  created_at timestamptz
)
language sql
security invoker
stable
as $$
  select distinct on (ad.source_id)
    ad.source_id::uuid        as bill_id,
    ad.id                     as decision_id,
    ad.confidence,
    ad.decision_kind,
    ad.suggested_treatment,
    ad.reason_codes,
    ad.created_at
  from automation_decisions ad
  where ad.source_kind = 'bill_upload'
    and ad.source_id = any (p_bill_ids)
    and ad.overridden_by is null
  order by ad.source_id, ad.created_at desc
$$;
$$;
