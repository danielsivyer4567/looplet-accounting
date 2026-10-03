// Which records can hold a TFN in entity_tfn_vault (pure, no I/O). The keys are what callers send; the values are
// the tables, which the vault's entity_table CHECK also lists.
export const TFN_ENTITY_TABLES = {
  trust: 'trusts',
  trust_beneficiary: 'trust_beneficiaries',
  fte_test_individual: 'family_trust_elections',
  smsf_fund: 'smsf_funds',
  smsf_member: 'smsf_members',
} as const;

export type TfnEntity = keyof typeof TFN_ENTITY_TABLES;
export type TfnEntityTable = (typeof TFN_ENTITY_TABLES)[TfnEntity];

export function tfnEntityTable(entity: unknown): TfnEntityTable | null {
  return typeof entity === 'string' && Object.hasOwn(TFN_ENTITY_TABLES, entity)
    ? TFN_ENTITY_TABLES[entity as TfnEntity]
    : null;
}
