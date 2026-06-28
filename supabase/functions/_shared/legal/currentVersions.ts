export interface CurrentVersion {
  id: string;
  section_ref: string;
  content_hash: string;
  effective_from: string;
}

interface SupabaseClient {
  from(table: string): any;
}

const CURRENT_PAGE_SIZE = 1000;

export async function loadCurrentVersions(
  admin: SupabaseClient,
  doc_ref: string,
): Promise<Map<string, CurrentVersion>> {
  const current = new Map<string, CurrentVersion>();
  for (let from = 0; ; from += CURRENT_PAGE_SIZE) {
    const to = from + CURRENT_PAGE_SIZE - 1;
    const { data: liveRows, error: liveErr } = await admin
      .from('legal_corpus')
      .select('id, section_ref, content_hash, effective_from')
      .eq('doc_ref', doc_ref)
      .is('effective_to', null)
      .is('deleted_at', null)
      .order('section_ref', { ascending: true })
      .range(from, to);
    if (liveErr) throw new Error(`load current versions: ${liveErr.message}`);
    const rows = (liveRows ?? []) as CurrentVersion[];
    for (const r of rows) current.set(r.section_ref, r);
    if (rows.length < CURRENT_PAGE_SIZE) break;
  }
  return current;
}
