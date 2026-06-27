import { ArrowRight, FileText } from 'lucide-react';
import type { AdviceNote } from '@/hooks/useAdviceNotes';

interface AdviceCardProps {
  note: AdviceNote;
  onOpen: (id: string) => void;
  disabled?: boolean;
}

interface HeadlineMetric {
  label: string;
  value: string;
}

const moneyFormatter = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  maximumFractionDigits: 0,
});

const PREFERRED_NUMBER_KEYS: { key: string; label: string; kind: 'money' | 'number' }[] = [
  { key: 'total_saving_cents', label: 'Saving', kind: 'money' },
  { key: 'estimated_saving_cents', label: 'Saving', kind: 'money' },
  { key: 'tax_diff_cents', label: 'Tax delta', kind: 'money' },
  { key: 'tax_result_cents', label: 'Tax result', kind: 'money' },
  { key: 'runway_weeks', label: 'Runway', kind: 'number' },
  { key: 'projected_closing_balance_cents', label: 'Forecast close', kind: 'money' },
  { key: 'opening_balance_cents', label: 'Opening cash', kind: 'money' },
];

export function AdviceCard({ note, onOpen, disabled = false }: AdviceCardProps) {
  const metric = headlineMetric(note);

  return (
    <article
      aria-label={`Advice card: ${note.title}`}
      style={{
        display: 'grid',
        gap: '0.8rem',
        padding: '1rem',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
        <span style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          <span className={`badge ${statusBadgeClass(note.status)}`}>
            {labelFromStatus(note.status)}
          </span>
          <span className="badge badge-info">{labelFromKind(note.kind)}</span>
        </span>
        <FileText size={17} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
      </div>

      <div style={{ display: 'grid', gap: '0.35rem', minHeight: '5.25rem' }}>
        <strong style={{ color: 'var(--text-title)', lineHeight: 1.25, fontSize: '0.98rem' }}>
          {note.title}
        </strong>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.82rem', lineHeight: 1.45 }}>
          {compactText(note.summary, 130)}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: '0.75rem',
          borderTop: '1px solid var(--border-subtle)',
          paddingTop: '0.75rem',
        }}
      >
        <div style={{ display: 'grid', gap: '0.1rem', minWidth: 0 }}>
          <span
            style={{
              color: 'var(--text-muted)',
              fontSize: '0.68rem',
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}
          >
            {metric.label}
          </span>
          <strong style={{ color: 'var(--text-title)', fontSize: '1.2rem', lineHeight: 1.1 }}>
            {metric.value}
          </strong>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => onOpen(note.id)}
          disabled={disabled}
          style={{ flexShrink: 0 }}
        >
          Open
          <ArrowRight size={14} />
        </button>
      </div>
    </article>
  );
}

function headlineMetric(note: AdviceNote): HeadlineMetric {
  for (const candidate of PREFERRED_NUMBER_KEYS) {
    const value = note.numbers[candidate.key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (candidate.key === 'runway_weeks') {
        return {
          label: candidate.label,
          value: `${value.toLocaleString('en-AU')} wk${value === 1 ? '' : 's'}`,
        };
      }
      return {
        label: candidate.label,
        value:
          candidate.kind === 'money'
            ? moneyFormatter.format(value / 100)
            : value.toLocaleString('en-AU'),
      };
    }
  }

  const firstNumber = Object.entries(note.numbers).find(
    ([, value]) => typeof value === 'number' && Number.isFinite(value),
  );
  if (firstNumber) {
    const [key, value] = firstNumber;
    return {
      label: labelFromKey(key),
      value:
        typeof value === 'number' && key.toLowerCase().endsWith('_cents')
          ? moneyFormatter.format(value / 100)
          : typeof value === 'number'
            ? value.toLocaleString('en-AU')
            : String(value),
    };
  }

  return { label: 'Status', value: labelFromStatus(note.status) };
}

function compactText(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trim()}...`;
}

function labelFromKind(kind: AdviceNote['kind']): string {
  return labelFromKey(kind)
    .replace(/\bCgt\b/g, 'CGT')
    .replace(/\bFbt\b/g, 'FBT');
}

function labelFromStatus(status: AdviceNote['status']): string {
  return labelFromKey(status);
}

function labelFromKey(key: string): string {
  return key
    .replace(/_cents$/i, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusBadgeClass(status: AdviceNote['status']): string {
  switch (status) {
    case 'issued':
    case 'acted':
      return 'badge-success';
    case 'dismissed':
      return 'badge-neutral';
    case 'draft':
    default:
      return 'badge-warning';
  }
}
