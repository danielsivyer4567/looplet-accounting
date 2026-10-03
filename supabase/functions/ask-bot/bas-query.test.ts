import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { BAS_QUARTER_COLUMNS, basQuarterSql } from './basQuery.ts';

// Columns of the CURRENT v_bas_quarterly: the last CREATE OR REPLACE VIEW in the migrations folder.
async function viewColumns(): Promise<Set<string>> {
  const dir = new URL('../../migrations/', import.meta.url);
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith('.sql')) files.push(e.name);
  files.sort();
  let definition = '';
  for (const name of files) {
    const text = await Deno.readTextFile(new URL(name, dir));
    const m = text.match(/CREATE OR REPLACE VIEW (?:public\.)?v_bas_quarterly[\s\S]*?;\s*$/m);
    if (m) definition = m[0];
  }
  if (!definition) throw new Error('v_bas_quarterly definition not found');
  const cols = new Set<string>();
  // Output names anywhere in the definition: "AS alias", "table.column" and bare identifiers at the end of a select
  // line (the view starts with a CTE, so the final select is not the first SELECT in the text).
  for (const m of definition.matchAll(/\bAS\s+([a-z_][a-z0-9_]*)/gi)) cols.add(m[1].toLowerCase());
  for (const m of definition.matchAll(/\.([a-z_][a-z0-9_]*)\s*(?=,|\n|$)/gim)) cols.add(m[1].toLowerCase());
  for (const m of definition.matchAll(/^\s*([a-z_][a-z0-9_]*)\s*(?=,|\n|$)/gim)) cols.add(m[1].toLowerCase());
  return cols;
}

Deno.test('every column Ask AI reads from v_bas_quarterly exists in the view', async () => {
  const cols = await viewColumns();
  for (const c of BAS_QUARTER_COLUMNS) assertEquals(cols.has(c), true, `v_bas_quarterly has no column ${c}`);
  assertEquals(BAS_QUARTER_COLUMNS.includes('net_gst_owed_cents' as never), false);
});

Deno.test('the query is built from that list and only for a UUID', async () => {
  const sql = basQuarterSql('00000000-0000-4000-8000-0000000000aa');
  for (const c of BAS_QUARTER_COLUMNS) assertEquals(sql.includes(c), true, c);
  assertEquals(sql.includes("organization_id = '00000000-0000-4000-8000-0000000000aa'"), true);
  assertThrows(() => basQuarterSql("x' OR 1=1 --"));
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  assertEquals(src.includes('basQuarterSql(orgId)'), true, 'index.ts must build the BAS query from basQuery.ts');
  assertEquals(src.includes('net_gst_owed_cents'), false);
});
