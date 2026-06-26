/**
 * Vitest global setup — runs once before every test file that uses jsdom.
 *
 * 1. Imports @testing-library/jest-dom matchers (toBeInTheDocument, etc.)
 * 2. Stubs window.matchMedia (not implemented in jsdom; needed by useIsMobile)
 * 3. Stubs ResizeObserver (not implemented in jsdom; used by some layout hooks)
 */

import '@testing-library/jest-dom';
import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// window.matchMedia stub
// ---------------------------------------------------------------------------
// jsdom does not implement matchMedia. Any component/hook that calls
// window.matchMedia() would throw without this stub.
//
// This setup file is shared by ALL test files, including the Node-environment
// integration tests under tests/ (e.g. tenant-isolation), where there is no
// `window`. Guard the browser-only stubs so the file is a no-op in Node.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // deprecated but some libs use it
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// ---------------------------------------------------------------------------
// ResizeObserver stub
// ---------------------------------------------------------------------------
// jsdom does not implement ResizeObserver.
if (typeof globalThis.ResizeObserver === 'undefined') {
  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
}

// ---------------------------------------------------------------------------
// Suppress noisy console.error from React (e.g. act() warnings) in tests.
// Remove this block if you want to see full React warnings during test runs.
// ---------------------------------------------------------------------------
// const originalError = console.error.bind(console);
// vi.spyOn(console, 'error').mockImplementation((...args) => {
//   if (typeof args[0] === 'string' && args[0].includes('Warning:')) return;
//   originalError(...args);
// });
