import { useEffect, useState } from 'react';

/**
 * Minimal toast store.
 *
 * The ported tag-drop components call `toast({ title, variant })` (the shadcn
 * `use-toast` shape). Looplet had no toast system, so this is a tiny
 * dependency-free store: `toast()` pushes a notice, `<Toaster />` subscribes via
 * `useToast()` and renders them. Auto-dismiss is owned by the Toaster.
 */

export type ToastVariant = 'default' | 'destructive';

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Auto-dismiss delay in ms (default 4000). */
  duration?: number;
}

export interface Toast extends ToastOptions {
  id: string;
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
const listeners = new Set<Listener>();
let counter = 0;

function emit() {
  for (const listener of listeners) listener(toasts);
}

export function dismissToast(id: string) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function toast(options: ToastOptions): { id: string; dismiss: () => void } {
  const id = `toast-${++counter}`;
  toasts = [...toasts, { id, ...options }];
  emit();
  return { id, dismiss: () => dismissToast(id) };
}

export function useToast() {
  const [current, setCurrent] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.add(setCurrent);
    setCurrent(toasts);
    return () => {
      listeners.delete(setCurrent);
    };
  }, []);
  return { toasts: current, toast, dismiss: dismissToast };
}
