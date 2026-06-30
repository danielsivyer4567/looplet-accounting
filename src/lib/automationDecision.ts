import { supabase } from '@/lib/supabase';

/**
 * Confidence bands for AI/automation decisions.
 * Maps directly to the `automation_confidence` DB enum.
 */
export type AutomationConfidence =
  'auto_post' | 'quick_confirm' | 'review_needed' | 'advisor_required' | 'blocked_external';

/**
 * Source kinds that can produce automation decisions.
 */
export type DecisionSourceKind = 'bill_upload' | 'bank_match' | 'coding_suggestion' | 'receipt_ocr';

/**
 * Decision kinds within a source.
 */
export type DecisionKind =
  'supplier_match' | 'category' | 'gst_treatment' | 'job_tag' | 'asset_treatment';

/**
 * A single automation decision record, mirroring the DB row.
 */
export interface AutomationDecision {
  id: string;
  organization_id: string;
  source_kind: string;
  source_id: string;
  decision_kind: string;
  suggested_treatment: unknown;
  confidence: AutomationConfidence;
  reason_codes: string[];
  evidence_refs: unknown;
  policy_refs: unknown;
  accepted_by: string | null;
  accepted_at: string | null;
  overridden_by: string | null;
  override_reason: string | null;
  created_at: string;
  created_by: string | null;
}

/**
 * Input for recording a new automation decision.
 */
export interface AutomationDecisionInput {
  organization_id: string;
  source_kind: DecisionSourceKind;
  source_id: string;
  decision_kind: DecisionKind;
  suggested_treatment: unknown;
  confidence: AutomationConfidence;
  reason_codes?: string[];
  evidence_refs?: unknown;
  policy_refs?: unknown;
  created_by?: string;
}

/**
 * Confidence ranks for comparison.
 * Higher rank = needs more human review.
 */
const CONFIDENCE_RANK: Record<AutomationConfidence, number> = {
  auto_post: 0,
  quick_confirm: 1,
  review_needed: 2,
  advisor_required: 3,
  blocked_external: 4,
};

/**
 * Returns true if `a` requires more human review than `b`.
 */
export function isMoreReviewNeeded(a: AutomationConfidence, b: AutomationConfidence): boolean {
  return CONFIDENCE_RANK[a] > CONFIDENCE_RANK[b];
}

/**
 * Returns true if a decision with this confidence can auto-post
 * (no human review needed).
 */
export function canAutoPost(confidence: AutomationConfidence): boolean {
  return confidence === 'auto_post';
}

/**
 * Returns true if a decision with this confidence needs quick human confirm
 * (lightweight review, not full advisor).
 */
export function needsQuickConfirm(confidence: AutomationConfidence): boolean {
  return confidence === 'quick_confirm';
}

// -- Confidence policies -----------------------------------------------------

/**
 * A confidence policy row from the DB.
 */
export interface ConfidencePolicy {
  id: string;
  org_id: string;
  supplier_id: string | null;
  source_kind: string;
  task_type: string;
  policy: AutomationConfidence;
  valid_from: string;
  valid_until: string | null;
  created_by: string | null;
  created_at: string;
}

/**
 * Fetches the most specific active confidence policy for the given scope,
 * returning null when no policy matches (caller should use its computed band).
 */
export async function getConfidencePolicy(args: {
  organizationId: string;
  sourceKind: DecisionSourceKind;
  taskType: DecisionKind;
  supplierId?: string;
}): Promise<AutomationConfidence | null> {
  const { data, error } = await supabase.rpc('get_confidence_policy', {
    p_org_id: args.organizationId,
    p_source_kind: args.sourceKind,
    p_task_type: args.taskType,
    p_supplier_id: args.supplierId ?? null,
  });

  if (error) throw new Error(`Failed to fetch confidence policy: ${error.message}`);
  return (data as AutomationConfidence | null) ?? null;
}

/**
 * Lists all confidence policies for an org (for the Settings UI).
 */
export async function listConfidencePolicies(organizationId: string): Promise<ConfidencePolicy[]> {
  const { data, error } = await supabase
    .from('confidence_policies')
    .select('*')
    .eq('org_id', organizationId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Failed to list confidence policies: ${error.message}`);
  return (data ?? []) as ConfidencePolicy[];
}

/**
 * Creates a new confidence policy override for the org.
 */
export async function createConfidencePolicy(args: {
  organizationId: string;
  sourceKind: DecisionSourceKind;
  taskType: DecisionKind;
  policy: AutomationConfidence;
  supplierId?: string;
  validUntil?: string;
}): Promise<ConfidencePolicy> {
  const { data, error } = await supabase.rpc('upsert_confidence_policy', {
    p_org_id: args.organizationId,
    p_source_kind: args.sourceKind,
    p_task_type: args.taskType,
    p_policy: args.policy,
    p_supplier_id: args.supplierId ?? null,
    p_valid_from: new Date().toISOString(),
    p_valid_until: args.validUntil ?? null,
  });

  if (error) throw new Error(`Failed to create confidence policy: ${error.message}`);
  return data as unknown as ConfidencePolicy;
}

/**
 * Deletes a confidence policy by ID.
 */
export async function deleteConfidencePolicy(args: {
  policyId: string;
  organizationId: string;
}): Promise<void> {
  const { error } = await supabase.rpc('delete_confidence_policy', {
    p_policy_id: args.policyId,
    p_org_id: args.organizationId,
  });

  if (error) throw new Error(`Failed to delete confidence policy: ${error.message}`);
}

/**
 * Records a new automation decision via the backend.
 * Checks for an active confidence policy override before persisting —
 * the policy wins when present (caller's computed band is the fallback).
 *
 * This calls supabase.rpc which must be SECURITY DEFINER to bypass
 * the INSERT-blocking RLS on automation_decisions.
 */
export async function recordDecision(input: AutomationDecisionInput): Promise<AutomationDecision> {
  // Apply policy override when one exists for this scope
  let effectiveConfidence = input.confidence;
  try {
    const policyBand = await getConfidencePolicy({
      organizationId: input.organization_id,
      sourceKind: input.source_kind,
      taskType: input.decision_kind,
    });
    if (policyBand !== null) {
      effectiveConfidence = policyBand;
    }
  } catch {
    // Non-fatal: if policy lookup fails, proceed with caller-supplied confidence
  }

  const { data, error } = await supabase.rpc('record_automation_decision', {
    p_org_id: input.organization_id,
    p_source_kind: input.source_kind,
    p_source_id: input.source_id,
    p_decision_kind: input.decision_kind,
    p_suggested_treatment: input.suggested_treatment,
    p_confidence: effectiveConfidence,
    p_reason_codes: input.reason_codes ?? [],
    p_evidence_refs: input.evidence_refs ?? null,
    p_policy_refs: input.policy_refs ?? null,
  });

  if (error) throw new Error(`Failed to record decision: ${error.message}`);
  return data as unknown as AutomationDecision;
}

/**
 * Records a human override of a previous automation decision.
 * This creates a new decision row with the override fields set,
 * preserving history.
 */
export async function recordOverride(args: {
  originalDecisionId: string;
  organizationId: string;
  sourceKind: DecisionSourceKind;
  sourceId: string;
  decisionKind: DecisionKind;
  suggestedTreatment: unknown;
  confidence: AutomationConfidence;
  reasonCodes?: string[];
  overrideReason: string;
}): Promise<AutomationDecision> {
  const { data, error } = await supabase.rpc('override_automation_decision', {
    p_original_id: args.originalDecisionId,
    p_org_id: args.organizationId,
    p_source_kind: args.sourceKind,
    p_source_id: args.sourceId,
    p_decision_kind: args.decisionKind,
    p_suggested_treatment: args.suggestedTreatment,
    p_confidence: args.confidence,
    p_reason_codes: args.reasonCodes ?? [],
    p_override_reason: args.overrideReason,
  });

  if (error) throw new Error(`Failed to record override: ${error.message}`);
  return data as unknown as AutomationDecision;
}

/**
 * Validates that a confidence value is one of the known bands.
 */
export function isValidConfidence(value: string): value is AutomationConfidence {
  return [
    'auto_post',
    'quick_confirm',
    'review_needed',
    'advisor_required',
    'blocked_external',
  ].includes(value);
}

/**
 * Serializes an array of reason codes to a JSON-safe format.
 */
export function serializeReasonCodes(codes: string[]): string[] {
  return codes.filter(Boolean);
}

/**
 * Determines whether a decision can proceed without blocking.
 * blocked_external decisions should not auto-proceed.
 */
export function isDecisionBlocked(confidence: AutomationConfidence): boolean {
  return confidence === 'blocked_external';
}

// -- Feedback / Learning Loop ------------------------------------------------

/**
 * Kinds of user corrections the learning loop tracks.
 */
export type FeedbackSourceKind =
  | 'bill_coding'
  | 'bank_match'
  | 'gst_treatment'
  | 'supplier'
  | 'job_tag'
  | 'asset_class'
  | 'confidence_outcome';

/**
 * A single feedback record.
 */
export interface AutomationFeedback {
  id: string;
  organization_id: string;
  source_kind: FeedbackSourceKind;
  source_id: string;
  previous_value: unknown;
  new_value: unknown;
  correction_reason: string | null;
  accepted_by: string | null;
  accepted_at: string;
  promoted_to_rule: boolean;
}

/**
 * Aggregated feedback pattern eligible for rule promotion (3+ occurrences).
 */
export interface FeedbackPattern {
  organization_id: string;
  source_kind: FeedbackSourceKind;
  new_value: unknown;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

/**
 * Records a user correction to an automation suggestion.
 * Calls the record_feedback SECURITY DEFINER RPC.
 */
export async function recordFeedback(args: {
  organizationId: string;
  sourceKind: FeedbackSourceKind;
  sourceId: string;
  previousValue?: unknown;
  newValue: unknown;
  correctionReason?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('record_feedback', {
    p_organization_id: args.organizationId,
    p_source_kind: args.sourceKind,
    p_source_id: args.sourceId,
    p_previous_value: args.previousValue ?? null,
    p_new_value: args.newValue,
    p_correction_reason: args.correctionReason ?? null,
  });

  if (error) throw new Error(`Failed to record feedback: ${error.message}`);
  return data as string;
}

/**
 * Fetches feedback patterns eligible for rule promotion.
 */
export async function getFeedbackPatterns(organizationId: string): Promise<FeedbackPattern[]> {
  const { data, error } = await supabase
    .from('v_feedback_patterns')
    .select('*')
    .eq('organization_id', organizationId);

  if (error) throw new Error(`Failed to fetch feedback patterns: ${error.message}`);
  return (data ?? []) as FeedbackPattern[];
}
