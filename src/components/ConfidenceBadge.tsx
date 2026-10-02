import type { AutomationConfidence } from '@/lib/automationDecision';

const CONFIDENCE_LABELS: Record<AutomationConfidence, string> = {
  auto_post: 'Auto',
  quick_confirm: 'Quick',
  review_needed: 'Review',
  advisor_required: 'Advisor',
  blocked_external: 'Blocked',
};

const CONFIDENCE_COLORS: Record<AutomationConfidence, string> = {
  auto_post: 'var(--accent-success)',
  quick_confirm: 'var(--accent-primary)',
  review_needed: '#f59e0b',
  advisor_required: '#ef4444',
  blocked_external: '#dc2626',
};

interface ConfidenceBadgeProps {
  confidence: AutomationConfidence;
  onClick?: () => void;
}

export function ConfidenceBadge({ confidence, onClick }: ConfidenceBadgeProps) {
  return (
    <span
      className="badge"
      style={{
        backgroundColor: `${CONFIDENCE_COLORS[confidence]}20`,
        color: CONFIDENCE_COLORS[confidence],
        border: `1px solid ${CONFIDENCE_COLORS[confidence]}40`,
        cursor: onClick ? 'pointer' : undefined,
      }}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') onClick();
            }
          : undefined
      }
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {CONFIDENCE_LABELS[confidence]}
    </span>
  );
}
