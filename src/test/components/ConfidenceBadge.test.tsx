import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfidenceBadge } from '@/components/ConfidenceBadge';

describe('ConfidenceBadge', () => {
  it('renders quick_confirm label', () => {
    render(<ConfidenceBadge confidence="quick_confirm" />);
    expect(screen.getByText('Quick')).toBeInTheDocument();
  });

  it('renders review_needed label', () => {
    render(<ConfidenceBadge confidence="review_needed" />);
    expect(screen.getByText('Review')).toBeInTheDocument();
  });

  it('renders auto_post label', () => {
    render(<ConfidenceBadge confidence="auto_post" />);
    expect(screen.getByText('Auto')).toBeInTheDocument();
  });

  it('has button role and responds to click', () => {
    const onClick = vi.fn();
    render(<ConfidenceBadge confidence="review_needed" onClick={onClick} />);
    const badge = screen.getByRole('button');
    fireEvent.click(badge);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
