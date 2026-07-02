# Staging And Production Deploy Workflow

**Status:** active finish-line workflow.
**Manual workflow file:** `.github/workflows/staging-deploy.yml`.

## Release Order

1. Merge only a branch with green local gates and an updated
   `docs/FINISH_LINE_TRACKER.md`.
2. Run the GitHub `Staging Deploy` workflow against staging with
   `deploy_edge_functions=false`.
3. Confirm the migration dry run matches `docs/MIGRATION_BASELINE_RUNBOOK.md`.
4. Apply the reviewed migration range in staging, then run product and accounting
   smoke tests.
5. Deploy edge functions from `supabase/functions-inventory.json` where
   `deploy_by_default=true`.
6. Repeat the same dry-run, migration, function, and smoke sequence for
   production.
7. Attach the evidence listed in this doc and in the relevant feature runbook.

## Required Gates

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run test:accounting`
- `npm run build`
- `npx vitest run src/test/db/deploymentDocsReconciliation.test.ts`
- `npm run product:ux-smoke -- --browsers=chromium,firefox`

## Function Deploy Rules

The source of truth is `supabase/functions-inventory.json`, with the readable
summary in `docs/FUNCTION_INVENTORY.md`.

Functions marked `deploy_by_default=false` are intentionally not part of the
default edge-function deployment loop. They need an explicit staging ticket,
operator approval, and live proof before being flipped on.

The ATO functions stay in that hold group until the external ATO TODO list is
complete.

## Post-Deploy Smoke

- Open the production frontend and clear the browser console.
- Exercise dashboard, bills, invoices, credit notes, reports, and settings.
- Confirm no unexpected console errors, page errors, or failed responses.
- Run feature-specific SQL and edge-function proof from the relevant runbook.
- Capture screenshots for any UI workflow that changed.

## Emergency Rollback

- Frontend: roll Cloudflare Pages back to the previous successful deployment.
- Edge functions: redeploy the prior commit's function source with
  `supabase functions deploy <name> --use-api --project-ref <project-ref>`.
- Database: use a forward-fix or targeted revert migration. Use PITR only for a
  severe data incident.
- Document the rollback command, operator, timestamp, and validation evidence in
  the release ticket.
