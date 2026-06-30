# Deploy Proof — P0-05 / SC-09 Advisor Work Proofs

**Slice:** SC-09 — Deploy and live-prove advisor work proof
**Status:** DEPLOY-GATED — proof capture requires a live Supabase deployment

## What must be captured before this slice can be marked done

1. **Migration applied** — `0208_advisor_work_proofs.sql` applied to production project
   `dxoikltymmknxqpkpyhi` without errors. Screenshot or `list_migrations` output showing
   the migration timestamp present.

2. **Edge function deployed** — `accountant-session-digest` deployed to the same project.
   Confirm via `list_edge_functions` or the Supabase dashboard showing the function active.

3. **Live invocation proof** — POST to
   `https://<project-ref>.supabase.co/functions/v1/accountant-session-digest`
   with a valid `{ org_id, session_id }` body and a caller JWT that belongs to that org.
   Expected response: `{ proof: { id: "<uuid>", proof_type: "session_digest", ... } }`.
   Screenshot or curl output showing HTTP 200 with the proof record id.

4. **Row visible in table** — `SELECT id, proof_type, captured_at FROM advisor_work_proofs
   ORDER BY captured_at DESC LIMIT 5;` run via `execute_sql` and returning at least one row.

## How to run the proof capture

```bash
# 1. Apply migration
supabase db push --project-ref dxoikltymmknxqpkpyhi

# 2. Deploy edge function
supabase functions deploy accountant-session-digest --project-ref dxoikltymmknxqpkpyhi

# 3. Call the function (replace <JWT> and <ORG_ID> with real values)
curl -s -X POST \
  "https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/accountant-session-digest" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"org_id":"<ORG_ID>","session_id":"<SESSION_ID>"}' \
  | jq .

# 4. Verify row
# Run via Supabase MCP execute_sql or the dashboard SQL editor:
# SELECT id, proof_type, captured_at FROM advisor_work_proofs ORDER BY captured_at DESC LIMIT 5;
```

## Notes

- The caller JWT must belong to a user who is a member of `organisation_users` for the given
  `org_id`. Cross-tenant requests will be rejected with HTTP 403.
- The `advisor_work_proofs` table is insert-protected from `authenticated` and `anon` roles;
  only the service-role key (used inside the edge function) may insert rows.
- This file is a placeholder. Replace with actual screenshot evidence and curl output once
  the live deployment has been completed.
