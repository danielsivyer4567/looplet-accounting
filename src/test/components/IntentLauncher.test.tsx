import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { IntentLauncher } from '@/components/IntentLauncher';

function renderIntentLauncher() {
  return render(
    <MemoryRouter>
      <IntentLauncher />
    </MemoryRouter>,
  );
}

describe('IntentLauncher', () => {
  it('renders all 6 owner intents', () => {
    renderIntentLauncher();

    expect(screen.getByText('Get paid')).toBeInTheDocument();
    expect(screen.getByText('Pay a bill')).toBeInTheDocument();
    expect(screen.getByText('Buy gear')).toBeInTheDocument();
    expect(screen.getByText('Run payday')).toBeInTheDocument();
    expect(screen.getByText('File tax')).toBeInTheDocument();
    expect(screen.getByText('Fix books')).toBeInTheDocument();
  });

  it('each intent links to the correct route', () => {
    renderIntentLauncher();

    expect(screen.getByText('Get paid').closest('a')).toHaveAttribute('href', '/invoices');
    expect(screen.getByText('Pay a bill').closest('a')).toHaveAttribute('href', '/bills');
    expect(screen.getByText('Buy gear').closest('a')).toHaveAttribute('href', '/bills/upload');
    expect(screen.getByText('Run payday').closest('a')).toHaveAttribute('href', '/payroll');
    expect(screen.getByText('File tax').closest('a')).toHaveAttribute('href', '/lodgements');
    expect(screen.getByText('Fix books').closest('a')).toHaveAttribute('href', '/quality');
  });

  it('renders descriptions for each intent', () => {
    renderIntentLauncher();

    expect(screen.getByText('Create invoices, track payments')).toBeInTheDocument();
    expect(screen.getByText('Upload bills, approve, pay')).toBeInTheDocument();
    expect(screen.getByText('Record purchases, fixed assets')).toBeInTheDocument();
    expect(screen.getByText('Process payroll and super')).toBeInTheDocument();
    expect(screen.getByText('Lodge BAS, tax returns')).toBeInTheDocument();
    expect(screen.getByText('Review coding, reconcile accounts')).toBeInTheDocument();
  });

  it('renders the section heading', () => {
    renderIntentLauncher();
    expect(screen.getByText('What would you like to do?')).toBeInTheDocument();
  });
});
