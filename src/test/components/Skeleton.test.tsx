/**
 * Tests for src/components/Skeleton.tsx
 *
 * These are pure render tests — no mocks needed beyond what setup.ts provides.
 * We verify the DOM shape, not exact pixel values, so the tests stay stable
 * when palette or sizing tweaks happen.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SkeletonLine, SkeletonCard, SkeletonTable } from '@/components/Skeleton';

// ---------------------------------------------------------------------------
// SkeletonLine
// ---------------------------------------------------------------------------

describe('SkeletonLine', () => {
  it('renders a single div element', () => {
    const { container } = render(<SkeletonLine />);
    expect(container.firstChild).toBeInstanceOf(HTMLDivElement);
  });

  it('applies default width of 100%', () => {
    const { container } = render(<SkeletonLine />);
    const el = container.firstChild as HTMLElement;
    expect(el.style.width).toBe('100%');
  });

  it('applies custom width when provided', () => {
    const { container } = render(<SkeletonLine width="55%" />);
    const el = container.firstChild as HTMLElement;
    expect(el.style.width).toBe('55%');
  });

  it('applies custom numeric height', () => {
    const { container } = render(<SkeletonLine height={20} />);
    const el = container.firstChild as HTMLElement;
    // React converts numeric heights to px strings in inline styles
    expect(el.style.height).toBe('20px');
  });
});

// ---------------------------------------------------------------------------
// SkeletonCard
// ---------------------------------------------------------------------------

describe('SkeletonCard', () => {
  it('renders a container div', () => {
    const { container } = render(<SkeletonCard />);
    expect(container.firstChild).toBeInstanceOf(HTMLDivElement);
  });

  it('renders three placeholder lines inside the card', () => {
    const { container } = render(<SkeletonCard />);
    // Card has an outer div + 3 SkeletonLine divs inside
    const innerDivs = (container.firstChild as HTMLElement).querySelectorAll('div');
    expect(innerDivs.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// SkeletonTable
// ---------------------------------------------------------------------------

describe('SkeletonTable', () => {
  it('renders with default props (5 rows, 5 cols)', () => {
    const { container } = render(<SkeletonTable />);
    expect(container.firstChild).toBeInstanceOf(HTMLDivElement);
  });

  it('renders the correct number of body row containers', () => {
    // 1 header row + `rows` body rows = rows + 1 direct children of table root
    const { container } = render(<SkeletonTable rows={3} cols={4} />);
    // The table wrapper has children: [header-row, body-row-0, body-row-1, body-row-2]
    const tableRoot = container.firstChild as HTMLElement;
    // First child = header, rest = body rows
    expect(tableRoot.children.length).toBe(4); // 1 header + 3 body rows
  });

  it('renders correct cell count for given cols', () => {
    const { container } = render(<SkeletonTable rows={2} cols={3} />);
    const tableRoot = container.firstChild as HTMLElement;
    // Header row has `cols` SkeletonLine divs
    const headerRow = tableRoot.children[0] as HTMLElement;
    expect(headerRow.children.length).toBe(3);
  });
});
