/**
 * Tests for src/components/ErrorBoundary.tsx
 *
 * Strategy:
 * - Render a child that throws on first render to verify the boundary swaps the
 *   crash for the friendly fallback (role="alert") instead of a white screen.
 * - Flip a flag so the child stops throwing, then click "Try again" to confirm
 *   the boundary clears its error and re-renders the now-healthy children.
 *
 * React logs caught render errors to console.error; we silence that for these
 * tests so the intentional throw doesn't spam the test output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from '@/components/ErrorBoundary';

// Module-level switch so the test can decide whether the child throws on a
// given render pass.
let shouldThrow = true;

function Bomb() {
  if (shouldThrow) {
    throw new Error('boom');
  }
  return <div>recovered child</div>;
}

describe('ErrorBoundary', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    shouldThrow = true;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders children normally when nothing throws', () => {
    shouldThrow = false;
    render(
      <ErrorBoundary>
        <div>healthy content</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the friendly fallback when a child throws during render', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('Reset clears the error and re-renders the children', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    // Fallback is showing.
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Make the child healthy, then click "Try again" to re-mount it.
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('recovered child')).toBeInTheDocument();
  });
});
