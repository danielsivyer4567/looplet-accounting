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
// Bare `localStorage` global (Node ≥22 ships an experimental one)
// ---------------------------------------------------------------------------
// Node ships an experimental `localStorage` global that resolves to undefined
// unless --localstorage-file is passed, and it shadows jsdom's working
// window.localStorage. Tests (and app code) that touch the bare global then
// crash with "Cannot read properties of undefined (reading 'clear')". In jsdom,
// install a minimal in-memory polyfill on BOTH the bare global and window so
// every reference resolves to the same store.
if (typeof window !== 'undefined') {
  const memStore = new Map<string, string>();
  const polyfill: Storage = {
    get length() {
      return memStore.size;
    },
    clear: () => memStore.clear(),
    getItem: (key: string) => memStore.get(key) ?? null,
    key: (index: number) => Array.from(memStore.keys())[index] ?? null,
    removeItem: (key: string) => {
      memStore.delete(key);
    },
    setItem: (key: string, value: string) => {
      memStore.set(key, value);
    },
  };

  try {
    Object.defineProperty(globalThis, 'localStorage', {
      value: polyfill,
      writable: true,
      configurable: true,
    });
  } catch {
    // Non-configurable on some runtimes — ignore.
  }
  try {
    Object.defineProperty(window, 'localStorage', {
      value: polyfill,
      writable: true,
      configurable: true,
    });
  } catch {
    // Non-configurable on some runtimes — ignore.
  }
}
