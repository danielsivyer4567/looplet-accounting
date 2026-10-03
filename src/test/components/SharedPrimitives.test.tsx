/**
 * Shared UI primitives (src/components/ui): PageHeader, Stat, StatusBadge, EmptyState,
 * Alert and Field, plus the re-themed Modal. Each renders with the accessible role and name
 * a page relies on, and its main variants map to the right classes/tokens.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Wallet } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Stat } from '@/components/ui/Stat';
import { DEFAULT_STATUS_TONES, StatusBadge, humaniseStatus } from '@/components/ui/StatusBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Alert } from '@/components/ui/Alert';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/Modal';

describe('PageHeader', () => {
  it('renders the page title as the level-1 heading with description and actions', () => {
    render(
      <PageHeader
        title="Bills"
        description="Supplier bills and what they owe."
        actions={<button className="btn btn-primary">Upload bill</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Bills' })).toBeInTheDocument();
    expect(screen.getByText('Supplier bills and what they owe.')).toHaveClass(
      'page-header-description',
    );
    expect(screen.getByRole('button', { name: 'Upload bill' })).toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveClass('page-header', 'page-header-full');
  });

  it('is only the heading when it has no description or actions, and can be an h2', () => {
    render(<PageHeader title="Jobs" as="h2" meta={<span>12</span>} />);
    const heading = screen.getByRole('heading', { level: 2, name: /Jobs/ });
    expect(heading).toHaveClass('page-header-title');
    expect(heading.closest('header')).not.toHaveClass('page-header-full');
    expect(within(heading).getByText('12')).toBeInTheDocument();
  });
});

describe('Stat', () => {
  it('labels the card as a group, animates numbers and colours the accent by tone', () => {
    render(
      <Stat
        label="Outstanding"
        value={125000}
        tone="danger"
        icon={Wallet}
        sub="3 overdue"
        formatter={(v) => `$${v / 100}`}
      />,
    );
    const group = screen.getByRole('group', { name: 'Outstanding' });
    expect(group).toHaveClass('stat', 'stat-card');
    expect(group).toHaveStyle({ borderLeftColor: 'var(--accent-danger)' });
    expect(within(group).getByText('3 overdue')).toHaveClass('stat-sub');
    // AnimatedNumber starts from 0 and counts up; the formatter is applied to every frame.
    expect(within(group).getByText(/^\$/)).toBeInTheDocument();
  });

  it('renders string values as given and uses the primary accent for neutral', () => {
    render(<Stat label="Created" value="30 Jun 2026" tone="neutral" />);
    const group = screen.getByRole('group', { name: 'Created' });
    expect(within(group).getByText('30 Jun 2026')).toHaveClass('stat-value');
    expect(group).toHaveStyle({ borderLeftColor: 'var(--accent-primary)' });
  });

  it('has inline and tile variants and accepts an explicit accent token', () => {
    render(
      <>
        <Stat label="ABN" value="12 345 678 901" variant="inline" strong />
        <Stat label="Monthly" value="$40" variant="tile" />
        <Stat label="Health" value="92%" accentColor="var(--accent-info)" />
      </>,
    );
    expect(screen.getByRole('group', { name: 'ABN' })).toHaveClass('stat-inline', 'stat-strong');
    expect(screen.getByRole('group', { name: 'Monthly' })).toHaveClass('stat-tile');
    expect(screen.getByRole('group', { name: 'Health' })).toHaveStyle({
      borderLeftColor: 'var(--accent-info)',
    });
  });
});

describe('StatusBadge', () => {
  it('maps common statuses to tones and humanises the text to sentence case', () => {
    render(
      <>
        <StatusBadge status="paid" />
        <StatusBadge status="partially_paid" />
        <StatusBadge status="sent" />
        <StatusBadge status="overdue" />
        <StatusBadge status="whatever_else" />
      </>,
    );
    expect(screen.getByText('Paid')).toHaveClass('badge', 'badge-success');
    expect(screen.getByText('Partially paid')).toHaveClass('badge-warning');
    expect(screen.getByText('Sent')).toHaveClass('badge-info');
    expect(screen.getByText('Overdue')).toHaveClass('badge-danger');
    expect(screen.getByText('Whatever else')).toHaveClass('badge-neutral');
    expect(humaniseStatus('on_hold')).toBe('On hold');
    expect(DEFAULT_STATUS_TONES['cancelled']).toBe('danger');
  });

  it('lets a page override tones and labels, or force a tone', () => {
    render(
      <>
        <StatusBadge status="paid" tones={{ paid: 'info' }} />
        <StatusBadge status="cancelled" tones={{ cancelled: 'neutral' }} label="Cancelled by you" />
        <StatusBadge status="detected" tone="warning" icon={<Wallet size={12} />} />
      </>,
    );
    expect(screen.getByText('Paid')).toHaveClass('badge-info');
    expect(screen.getByText('Cancelled by you')).toHaveClass('badge-neutral');
    const detected = screen.getByText('Detected');
    expect(detected).toHaveClass('badge-warning');
    expect(detected.querySelector('.badge-icon')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('EmptyState', () => {
  it('shows title, explanation and an action, and hides the decorative icon from assistive tech', () => {
    render(
      <EmptyState
        title="No bills yet"
        icon={Wallet}
        action={<button className="btn btn-primary">Upload a bill</button>}
      >
        Bills you upload or email in will show here.
      </EmptyState>,
    );
    const title = screen.getByText('No bills yet');
    expect(title).toHaveClass('empty-state-title');
    const block = title.closest('.empty-state') as HTMLElement;
    expect(block).not.toBeNull();
    // Not a live region: it mounts with its text, and pages keep role="status" for their own messages.
    expect(block).not.toHaveAttribute('role');
    expect(block.querySelector('.empty-state-icon')).toHaveAttribute('aria-hidden', 'true');
    expect(within(block).getByText(/will show here/)).toBeInTheDocument();
    expect(within(block).getByRole('button', { name: 'Upload a bill' })).toBeInTheDocument();
  });

  it('works with only children and a compact variant', () => {
    render(<EmptyState compact>No franking account entries for this year.</EmptyState>);
    const block = screen
      .getByText('No franking account entries for this year.')
      .closest('.empty-state');
    expect(block).toHaveClass('empty-state-compact');
  });
});

describe('Alert', () => {
  it('announces warnings and problems and uses the tone classes', () => {
    render(
      <>
        <Alert tone="danger" title="Payment failed">
          The bank rejected the file.
        </Alert>
        <Alert tone="warning">GST data is incomplete for Q4.</Alert>
      </>,
    );
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveClass('alert', 'alert-danger');
    expect(within(alerts[0] as HTMLElement).getByText('Payment failed')).toHaveClass('alert-title');
    expect(alerts[1]).toHaveClass('alert-warning');
  });

  it('keeps information and success as polite status, with optional actions and no icon', () => {
    render(
      <>
        <Alert
          tone="info"
          icon={null}
          actions={<button className="btn btn-secondary">Learn more</button>}
        >
          Bank feeds are paused while the old app is the product.
        </Alert>
        <Alert tone="success">Saved.</Alert>
      </>,
    );
    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toHaveClass('alert-info');
    expect(statuses[0]?.querySelector('.alert-icon')).toBeNull();
    expect(screen.getByRole('button', { name: 'Learn more' })).toBeInTheDocument();
    expect(statuses[1]).toHaveClass('alert-success');
  });
});

describe('Field', () => {
  it('associates the label with the control and reads the hint with it', () => {
    render(
      <Field label="Invoice number" hint="Leave blank to number it automatically">
        <input className="form-input" />
      </Field>,
    );
    const input = screen.getByLabelText('Invoice number');
    expect(input).toHaveClass('form-input');
    expect(input).toHaveAccessibleDescription('Leave blank to number it automatically');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('marks the control invalid and announces the error; required adds a visual mark', () => {
    render(
      <Field label="ABN" error="Enter the 11-digit ABN" required>
        <input className="form-input" />
      </Field>,
    );
    const input = screen.getByLabelText(/ABN/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toBeRequired();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the 11-digit ABN');
    expect(input).toHaveAccessibleDescription('Enter the 11-digit ABN');
    expect(input.closest('.form-group')).toHaveClass('field', 'field-invalid');
  });

  it('respects an existing control id and works with a select', () => {
    render(
      <Field label="Frequency">
        <select id="freq" className="form-select">
          <option>Weekly</option>
        </select>
      </Field>,
    );
    expect(screen.getByLabelText('Frequency')).toHaveAttribute('id', 'freq');
  });
});

describe('Modal', () => {
  it('is a labelled dialog that closes on Escape, on the backdrop and from the named close button', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Receipt">
        <p>Body</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Receipt' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveClass('modal-panel');
    expect(dialog).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('renders nothing when closed', () => {
    render(
      <Modal open={false} onClose={() => undefined} title="Hidden">
        <p>Body</p>
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
