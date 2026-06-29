import { describe, expect, it } from 'vitest';
import {
  loadCurrentVersions,
  type CurrentVersion,
} from '../supabase/functions/_shared/legal/currentVersions.ts';

describe('legal upsert current-version loading', () => {
  it('pages current corpus rows beyond the PostgREST default cap', async () => {
    const docRef = 'Large Act';
    const ranges: Array<[number, number]> = [];

    const rows: CurrentVersion[] = Array.from({ length: 1005 }, (_, index) => ({
      id: `row-${index}`,
      section_ref: `s ${index}`,
      content_hash: `hash-${index}`,
      effective_from: '2026-05-21',
    }));

    const admin = {
      from(table: string) {
        if (table !== 'legal_corpus') throw new Error(`unexpected table ${table}`);
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          is() {
            return query;
          },
          order() {
            return query;
          },
          async range(from: number, to: number) {
            ranges.push([from, to]);
            return { data: rows.slice(from, to + 1), error: null };
          },
        };
        return query;
      },
    };

    const current = await loadCurrentVersions(admin as never, docRef);

    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(current.size).toBe(1005);
    expect(current.get('s 1004')).toMatchObject({ id: 'row-1004' });
  });
});
