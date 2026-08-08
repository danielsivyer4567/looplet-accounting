import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge conditional class names, de-duplicating conflicting Tailwind classes. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Explicit no-op for fire-and-forget promise tails (swallows rejected promises). */
export function noop(): void {
  /* intentional no-op */
}
