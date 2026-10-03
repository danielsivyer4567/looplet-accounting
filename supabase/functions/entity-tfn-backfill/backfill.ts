// Encrypts the plain TFNs that migration 20261003130100 moved into entity_tfn_legacy_plaintext (pure; I/O injected).
//
// For each waiting row:
//   - if the entity already has a vault TFN (saved since through entity-tfn-save), that newer TFN wins and the old
//     plain value is deleted ("superseded");
//   - else if it is an 8- or 9-digit TFN, it is encrypted into the vault, then the plain row is deleted ("encrypted");
//   - else it is left in place and reported by id only ("needs_review"), never with its value.
// Safe to run any number of times: a row is only deleted after its TFN is in the vault, and a rerun skips what is done.

import { isTfnShape, normaliseTfn, tfnLast4 } from '../_shared/tfn.ts';

export interface LegacyTfnRow {
  id: string;
  organization_id: string;
  entity_table: string;
  entity_id: string;
  tfn_plaintext: string;
}

export interface VaultInsert {
  organization_id: string;
  entity_table: string;
  entity_id: string;
  tfn_encrypted: string;
  tfn_last4: string;
}

export interface BackfillDeps {
  /** Waiting rows with id greater than afterId (or all, when null), ordered by id. */
  listLegacy(afterId: string | null, limit: number): Promise<LegacyTfnRow[]>;
  hasVaultTfn(entityTable: string, entityId: string): Promise<boolean>;
  encrypt(plain: string): Promise<string>;
  /** Insert the vault row; must not overwrite an existing one for the same entity. */
  insertVault(row: VaultInsert): Promise<void>;
  deleteLegacy(id: string): Promise<void>;
}

export interface BackfillResult {
  encrypted: number;
  superseded: number;
  needs_review: { id: string; entity_table: string; entity_id: string; reason: string }[];
}

export async function backfillLegacyTfns(deps: BackfillDeps, pageSize = 100): Promise<BackfillResult> {
  const result: BackfillResult = { encrypted: 0, superseded: 0, needs_review: [] };
  let afterId: string | null = null;
  for (;;) {
    const page = await deps.listLegacy(afterId, pageSize);
    if (page.length === 0) break;
    for (const row of page) {
      afterId = row.id;
      if (await deps.hasVaultTfn(row.entity_table, row.entity_id)) {
        await deps.deleteLegacy(row.id);
        result.superseded += 1;
        continue;
      }
      const tfn = normaliseTfn(row.tfn_plaintext);
      if (!isTfnShape(tfn)) {
        result.needs_review.push({
          id: row.id,
          entity_table: row.entity_table,
          entity_id: row.entity_id,
          reason: 'not an 8 or 9 digit TFN; saving the correct TFN with entity-tfn-save replaces it',
        });
        continue;
      }
      await deps.insertVault({
        organization_id: row.organization_id,
        entity_table: row.entity_table,
        entity_id: row.entity_id,
        tfn_encrypted: await deps.encrypt(tfn),
        tfn_last4: tfnLast4(tfn),
      });
      await deps.deleteLegacy(row.id);
      result.encrypted += 1;
    }
    if (page.length < pageSize) break;
  }
  return result;
}
