import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const indexSource = readFileSync(
  join(root, 'supabase/functions/bas-lodgement-pack/index.ts'),
  'utf8',
);
const packSource = readFileSync(join(root, 'supabase/functions/bas-lodgement-pack/pack.ts'), 'utf8');
const config = readFileSync(join(root, 'supabase/config.toml'), 'utf8');
const hookSource = readFileSync(join(root, 'src/hooks/useBasLodgementPack.ts'), 'utf8');
const pageSource = readFileSync(join(root, 'src/pages/Lodgements.tsx'), 'utf8');

describe('BAS lodgement pack contract', () => {
  it('keeps the edge function caller-scoped and read-only over lodgements', () => {
    expect(indexSource).toMatch(/createClient\(supabaseUrl,\s*anonKey/i);
    expect(indexSource).toMatch(/global:\s*\{\s*headers:\s*\{\s*Authorization:\s*authHeader\s*\}/i);
    expect(indexSource).toMatch(/\.from\("lodgements"\)/);
    expect(indexSource).toMatch(/\.select\(LODGEMENT_COLUMNS\)/);
    expect(indexSource).toMatch(/\.eq\("id",\s*lodgementId\)/);
    expect(indexSource).not.toMatch(/SERVICE_ROLE|service_role/i);
    expect(indexSource).toMatch(/only BAS lodgements can be packed/i);
    expect(indexSource).toMatch(/renderWorksheetPdf\(toBasLodgementWorksheetDoc/);
  });

  it('states the pack guardrails and leaves ATO transmission out of scope', () => {
    expect(packSource).toMatch(/ato_transmission_included:\s*false/i);
    expect(packSource).toMatch(/human_declaration_required:\s*true/i);
    expect(packSource).toMatch(/NOT LODGED/);
    expect(packSource).toMatch(/requiredBasTotalsPresent/);
    expect(config).toMatch(/\[functions\.bas-lodgement-pack\]\s*verify_jwt\s*=\s*true/i);
  });

  it('wires the Lodgements page to download the BAS pack through the edge function', () => {
    expect(hookSource).toMatch(/supabase\.functions\.invoke<BasLodgementPackResponse>\('bas-lodgement-pack'/);
    expect(hookSource).toMatch(/body:\s*\{\s*lodgement_id:\s*lodgement\.id\s*\}/);
    expect(hookSource).toMatch(/base64ToBlob\(data\.pdf_base64,\s*'application\/pdf'\)/);
    expect(pageSource).toMatch(/Download BAS pack/);
    expect(pageSource).toMatch(/useBasLodgementPack/);
  });
});
