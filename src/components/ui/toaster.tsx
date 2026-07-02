import { useEffect } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast, dismissToast, type Toast } from '@/hooks/use-toast';

/**
 * Toaster — renders the toast store in a fixed bottom-right stack.
 *
 * Dependency-free (no Radix); pairs with `@/hooks/use-toast`. Mounted once near
 * the app root (SC-2F) so the ported tag-drop components' `toast()` calls show.
 */
function ToastItem({ toast }: { toast: Toast }) {
  useEffect(() => {
    const timer = setTimeout(() => dismissToast(toast.id), toast.duration ?? 4000);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration]);

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex w-80 items-start gap-3 rounded-md border p-4 shadow-lg animate-in slide-in-from-right-full',
        toast.variant === 'destructive'
          ? 'border-destructive bg-destructive text-destructive-foreground'
          : 'border-border bg-popover text-popover-foreground',
      )}
    >
      <div className="flex-1 space-y-1">
        <p className="text-sm font-semibold leading-none">{toast.title}</p>
        {toast.description && <p className="text-sm opacity-90">{toast.description}</p>}
      </div>
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        className="shrink-0 rounded-sm opacity-70 transition-opacity hover:opacity-100"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function Toaster() {
  const { toasts } = useToast();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-0 right-0 z-[10001] flex max-h-screen flex-col gap-2 p-4">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

export default Toaster;
