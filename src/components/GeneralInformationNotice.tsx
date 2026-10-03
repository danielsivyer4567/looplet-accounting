import { Info } from 'lucide-react';

/**
 * Label for anything the AI or the advisor models produce. Looplet is not a registered tax agent:
 * its answers are general information, and acting on tax law applied to your own circumstances
 * should go through a registered tax agent or BAS agent (Tax Agent Services Act 2009).
 * Keep in step with GENERAL_INFORMATION_NOTICE in supabase/functions/ask-bot/prompts.ts.
 */
export const GENERAL_INFORMATION_NOTICE =
  "General information only, not tax, financial or legal advice. It doesn't take all of your " +
  'circumstances into account. Check with a registered tax agent or BAS agent before you act on it.';

export function GeneralInformationNotice({ compact = false }: { compact?: boolean }) {
  return (
    <p
      role="note"
      aria-label="General information notice"
      style={{
        display: 'flex',
        gap: '0.4rem',
        alignItems: 'flex-start',
        margin: 0,
        padding: compact ? 0 : '0.6rem 0.75rem',
        background: compact ? 'transparent' : 'var(--bg-info-subtle)',
        border: compact ? 'none' : '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text-muted)',
        fontSize: compact ? '0.72rem' : '0.8rem',
        lineHeight: 1.45,
      }}
    >
      <Info size={compact ? 12 : 14} style={{ flexShrink: 0, marginTop: '0.15rem' }} />
      <span>{GENERAL_INFORMATION_NOTICE}</span>
    </p>
  );
}
