import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type EntityKind =
  | 'supplier'
  | 'contractor'
  | 'customer'
  | 'personal'
  | 'subscription'
  | 'internal_admin'
  | 'unknown';

export interface StagedEntityForApproval {
  id: string;
  organization_id: string;
  canonical_key: string;
  display_name: string;
  primary_email: string | null;
  abn: string | null;
  predicted_kind: EntityKind;
  predicted_category: string | null;
  confidence: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export interface StagedApprovalDecision {
  kind: EntityKind;
  category: string | null;
  source: string;
  confidence: number;
}

export interface StagedApprovalResult {
  supplier_id: string | null;
  customer_id: string | null;
  rule_id: string;
}

const ENTITY_KINDS: readonly EntityKind[] = [
  'supplier',
  'contractor',
  'customer',
  'personal',
  'subscription',
  'internal_admin',
  'unknown',
];

const AUTO_APPROVE_ALLOWED_KINDS = new Set<EntityKind>([
  'supplier',
  'contractor',
  'customer',
  'subscription',
  'internal_admin',
]);

const AUTO_APPROVE_BLOCKED_CATEGORIES = new Set([
  'uncategorized',
  'personal_expense',
  'marketing',
]);

export const AUTO_APPROVE_MIN_CONFIDENCE = 0.84;

export function toEntityKind(value: string): EntityKind | null {
  return ENTITY_KINDS.includes(value as EntityKind) ? (value as EntityKind) : null;
}

export function isSafeStagedAutoApproval(
  kind: EntityKind,
  category: string | null,
  confidence: number,
): boolean {
  if (!Number.isFinite(confidence) || confidence < AUTO_APPROVE_MIN_CONFIDENCE) return false;
  if (!category || AUTO_APPROVE_BLOCKED_CATEGORIES.has(category)) return false;
  return AUTO_APPROVE_ALLOWED_KINDS.has(kind);
}

export function matcherForStagedEntity(entity: {
  canonical_key: string;
  primary_email: string | null;
}): { matcher_type: 'sender_domain' | 'sender_address'; matcher_value: string } {
  if (entity.canonical_key.startsWith('domain:')) {
    return {
      matcher_type: 'sender_domain',
      matcher_value: entity.canonical_key.replace(/^domain:/, ''),
    };
  }

  return {
    matcher_type: 'sender_address',
    matcher_value: entity.primary_email ?? entity.canonical_key.replace(/^email:/, ''),
  };
}

export async function approveStagedEntity(
  admin: SupabaseClient,
  entity: StagedEntityForApproval,
  decision: StagedApprovalDecision,
): Promise<StagedApprovalResult> {
  if (!decision.category) throw new Error('category required to approve staged entity');

  let supplierId: string | null = null;
  let customerId: string | null = null;

  if (createsSupplier(decision.kind)) {
    supplierId = await findOrCreateSupplier(admin, entity);
  } else if (decision.kind === 'customer') {
    customerId = await findOrCreateCustomer(admin, entity);
  }

  const matcher = matcherForStagedEntity(entity);
  const isPersonal = decision.kind === 'personal' || decision.category === 'personal_expense';
  const ruleId = await upsertIntakeRule(admin, {
    organization_id: entity.organization_id,
    matcher_type: matcher.matcher_type,
    matcher_value: matcher.matcher_value,
    matcher_priority: matcher.matcher_type === 'sender_address' ? 50 : 100,
    category_code: decision.category,
    supplier_id: supplierId,
    customer_id: customerId,
    is_personal: isPersonal,
    notes: `Auto Setup auto-approved from ${decision.source} - predicted ${decision.kind} (${decision.confidence.toFixed(2)})`,
  });

  if (decision.kind === 'subscription' && supplierId) {
    await upsertSubscriptionCandidate(admin, entity, supplierId, decision);
  }

  const updatePayload: Record<string, unknown> = {
    status: 'approved',
    user_kind: decision.kind,
    user_category: decision.category,
    resolved_supplier_id: supplierId,
    resolved_customer_id: customerId,
    resolved_rule_id: ruleId,
    reviewed_at: new Date().toISOString(),
  };

  const { error: updateErr } = await admin
    .from('staged_entities')
    .update(updatePayload)
    .eq('id', entity.id)
    .eq('organization_id', entity.organization_id);
  if (updateErr) throw new Error(`staged_entities approve: ${updateErr.message}`);

  return { supplier_id: supplierId, customer_id: customerId, rule_id: ruleId };
}

function createsSupplier(kind: EntityKind): boolean {
  return (
    kind === 'supplier' ||
    kind === 'contractor' ||
    kind === 'subscription' ||
    kind === 'internal_admin'
  );
}

async function findOrCreateSupplier(
  admin: SupabaseClient,
  entity: StagedEntityForApproval,
): Promise<string> {
  const existing = await admin
    .from('suppliers')
    .select('id')
    .eq('organization_id', entity.organization_id)
    .eq('name', entity.display_name)
    .limit(1)
    .maybeSingle();
  if (existing.error) throw new Error(`suppliers lookup: ${existing.error.message}`);
  if (typeof existing.data?.id === 'string') return existing.data.id;

  const inserted = await admin
    .from('suppliers')
    .insert({
      organization_id: entity.organization_id,
      name: entity.display_name,
      email: entity.primary_email,
      abn: entity.abn,
    })
    .select('id')
    .single();
  if (inserted.error) throw new Error(`suppliers insert: ${inserted.error.message}`);
  if (typeof inserted.data?.id !== 'string') throw new Error('suppliers insert returned no id');
  return inserted.data.id;
}

async function findOrCreateCustomer(
  admin: SupabaseClient,
  entity: StagedEntityForApproval,
): Promise<string> {
  const existing = await admin
    .from('customers')
    .select('id')
    .eq('organization_id', entity.organization_id)
    .eq('name', entity.display_name)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing.error) throw new Error(`customers lookup: ${existing.error.message}`);
  if (typeof existing.data?.id === 'string') return existing.data.id;

  const inserted = await admin
    .from('customers')
    .insert({
      organization_id: entity.organization_id,
      name: entity.display_name,
      email: entity.primary_email,
      abn: entity.abn,
    })
    .select('id')
    .single();
  if (inserted.error) throw new Error(`customers insert: ${inserted.error.message}`);
  if (typeof inserted.data?.id !== 'string') throw new Error('customers insert returned no id');
  return inserted.data.id;
}

async function upsertIntakeRule(
  admin: SupabaseClient,
  payload: {
    organization_id: string;
    matcher_type: 'sender_domain' | 'sender_address';
    matcher_value: string;
    matcher_priority: number;
    category_code: string;
    supplier_id: string | null;
    customer_id: string | null;
    is_personal: boolean;
    notes: string;
  },
): Promise<string> {
  const existing = await admin
    .from('intake_rules')
    .select('id')
    .eq('organization_id', payload.organization_id)
    .eq('matcher_type', payload.matcher_type)
    .eq('matcher_value', payload.matcher_value)
    .eq('is_active', true)
    .order('matcher_priority', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) throw new Error(`intake_rules lookup: ${existing.error.message}`);

  if (typeof existing.data?.id === 'string') {
    const updated = await admin
      .from('intake_rules')
      .update({
        matcher_priority: payload.matcher_priority,
        category_code: payload.category_code,
        supplier_id: payload.supplier_id,
        customer_id: payload.customer_id,
        is_personal: payload.is_personal,
        skip_ocr: false,
        notes: payload.notes,
      })
      .eq('id', existing.data.id)
      .select('id')
      .single();
    if (updated.error) throw new Error(`intake_rules update: ${updated.error.message}`);
    if (typeof updated.data?.id !== 'string') throw new Error('intake_rules update returned no id');
    return updated.data.id;
  }

  const inserted = await admin
    .from('intake_rules')
    .insert({
      ...payload,
      skip_ocr: false,
      is_active: true,
    })
    .select('id')
    .single();
  if (inserted.error) throw new Error(`intake_rules insert: ${inserted.error.message}`);
  if (typeof inserted.data?.id !== 'string') throw new Error('intake_rules insert returned no id');
  return inserted.data.id;
}

async function upsertSubscriptionCandidate(
  admin: SupabaseClient,
  entity: StagedEntityForApproval,
  supplierId: string,
  decision: StagedApprovalDecision,
): Promise<void> {
  const existing = await admin
    .from('subscriptions')
    .select('id')
    .eq('organization_id', entity.organization_id)
    .eq('merchant_canonical_key', entity.canonical_key)
    .limit(1)
    .maybeSingle();
  if (existing.error) throw new Error(`subscriptions lookup: ${existing.error.message}`);

  const payload = {
    merchant_name: entity.display_name,
    supplier_id: supplierId,
    category_code: decision.category,
    status: 'candidate',
    cadence: 'irregular',
    amount_cents: 0,
    confidence: decision.confidence,
    detection_reason: decision.source,
    observed_count: 0,
    total_spent_cents: 0,
    first_seen_at: entity.first_seen_at ?? new Date().toISOString(),
    last_seen_at: entity.last_seen_at ?? new Date().toISOString(),
  };

  if (typeof existing.data?.id === 'string') {
    const updated = await admin.from('subscriptions').update(payload).eq('id', existing.data.id);
    if (updated.error) throw new Error(`subscriptions update: ${updated.error.message}`);
    return;
  }

  const inserted = await admin.from('subscriptions').insert({
    organization_id: entity.organization_id,
    merchant_canonical_key: entity.canonical_key,
    ...payload,
  });
  if (inserted.error) throw new Error(`subscriptions insert: ${inserted.error.message}`);
}
