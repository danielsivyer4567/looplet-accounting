import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const guide = readFileSync(join(root, 'docs/connector-guide.md'), 'utf8');
const openapi = readFileSync(join(root, 'docs/openapi.yaml'), 'utf8');
const ingest = readFileSync(join(root, 'supabase/functions/ingest/index.ts'), 'utf8');
const handlers = readFileSync(join(root, 'supabase/functions/ingest/handlers.ts'), 'utf8');
const gateway = readFileSync(join(root, 'supabase/functions/api-gateway/index.ts'), 'utf8');

const ingestTypes = ['bill', 'bank_transaction', 'invoice', 'document', 'payment'] as const;
const writeScopes = ['write:bills', 'write:bank', 'write:invoices', 'write:documents', 'write:payments'] as const;

describe('connector API docs contract', () => {
  it('documents every ingest type and write scope enforced by the edge function', () => {
    for (const type of ingestTypes) {
      expect(ingest).toContain(`${type}:`);
      expect(openapi).toContain(type);
      expect(guide).toContain(type);
    }

    for (const scope of writeScopes) {
      expect(ingest).toContain(scope);
      expect(openapi).toContain(scope);
      expect(guide).toContain(scope);
    }

    expect(guide).toContain('{ "type": "<bill|bank_transaction|invoice|document|payment>"');
    expect(guide).toContain('`type` not in bill/bank_transaction/invoice/document/payment');
  });

  it('keeps the gateway read-scope caveat explicit in both public docs', () => {
    expect(gateway).toMatch(/issuing ANY key grants full-org read/i);
    expect(guide).toMatch(/read scope is not granular/i);
    expect(guide).toMatch(/full-org read/i);
    expect(openapi).toMatch(/read scopes are not granular/i);
    expect(openapi).toMatch(/full-org read/i);
  });

  it('does not advertise forbidden raw invoice status writes', () => {
    expect(handlers).toMatch(/`status` is deliberately NOT writable from the API/i);
    expect(openapi).not.toMatch(/^\s+status:\s*\{ type: string, enum: \[draft, sent, partially_paid, paid, overdue, void\] \}/m);
    expect(guide).toMatch(/Invoices always start at the database\s+default \(`draft`\)/);
  });

  it('documents tenant-pinned foreign ids on write payloads', () => {
    expect(handlers).toContain("requireOrgRecord(db, 'suppliers'");
    expect(handlers).toContain("requireOrgRecord(db, 'jobs'");
    expect(handlers).toContain("requireOrgRecord(db, 'customers'");
    expect(handlers).toContain("requireOrgRecord(db, 'invoices'");

    expect(guide).toMatch(/`supplier_id` and `job_id` must also belong to your organization/i);
    expect(guide).toMatch(/`customer_id` must belong to your org, and `job_id` must also belong/i);
    expect(guide).toMatch(/`invoice_id` is required and must\s+belong to your organization/i);

    expect(openapi).toMatch(/supplier_id and job_id must belong to the key's org if supplied/i);
    expect(openapi).toMatch(/job_id: \{ type: string, format: uuid, description: Must belong to the key's org if supplied\. \}/);
    expect(openapi).toMatch(/The customer invoice being paid\. Must belong to the key's org/i);
  });
});
