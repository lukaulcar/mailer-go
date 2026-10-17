import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export type ToastType = "success" | "error" | "info";

export interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}

interface ToastContextValue {
  toast: (item: Omit<ToastItem, "id">) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let globalToastEmitter: ((item: Omit<ToastItem, "id">) => void) | null = null;

export const notify = {
  success: (title: string, message?: string) => globalToastEmitter?.({ type: "success", title, message }),
  error: (title: string, message?: string) => globalToastEmitter?.({ type: "error", title, message }),
  info: (title: string, message?: string) => globalToastEmitter?.({ type: "info", title, message }),
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (item: Omit<ToastItem, "id">) => {
      const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const duration = item.duration ?? (item.type === "error" ? 4500 : 3000);
      const toastItem: ToastItem = { ...item, id, duration };

      setToasts((prev) => [...prev.slice(-4), toastItem]);

      if (duration > 0) {
        setTimeout(() => {
          dismiss(id);
        }, duration);
      }
    },
    [dismiss],
  );

  useEffect(() => {
    globalToastEmitter = addToast;
    return () => {
      globalToastEmitter = null;
    };
  }, [addToast]);

  const success = useCallback((title: string, message?: string) => addToast({ type: "success", title, message }), [addToast]);
  const error = useCallback((title: string, message?: string) => addToast({ type: "error", title, message }), [addToast]);
  const info = useCallback((title: string, message?: string) => addToast({ type: "info", title, message }), [addToast]);

  return (
    <ToastContext.Provider value={{ toast: addToast, success, error, info, dismiss }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-5 right-5 z-[120] flex flex-col gap-2.5 sm:max-w-md"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex items-start gap-3 rounded-xl border border-neutral-800 bg-neutral-900/95 p-3.5 text-white shadow-2xl backdrop-blur-md transition-all animate-in fade-in slide-in-from-bottom-2 duration-200"
          >
            <span className="mt-0.5 shrink-0">
              {t.type === "success" && (
                <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-500/20 text-emerald-400">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 8.5 6.5 12 13 4" />
                  </svg>
                </span>
              )}
              {t.type === "error" && (
                <span className="grid h-5 w-5 place-items-center rounded-full bg-red-500/20 text-red-400">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="8" cy="8" r="7" />
                    <line x1="8" y1="5" x2="8" y2="8.5" />
                    <line x1="8" y1="11.5" x2="8.01" y2="11.5" />
                  </svg>
                </span>
              )}
              {t.type === "info" && (
                <span className="grid h-5 w-5 place-items-center rounded-full bg-blue-500/20 text-blue-400">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="8" cy="8" r="7" />
                    <line x1="8" y1="8" x2="8" y2="11.5" />
                    <circle cx="8" cy="5" r="0.5" />
                  </svg>
                </span>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-white">{t.title}</p>
              {t.message && <p className="mt-0.5 text-[12px] leading-relaxed text-white/70">{t.message}</p>}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss toast"
              className="ml-1 -mr-1 -mt-1 grid h-6 w-6 place-items-center rounded-md text-white/40 hover:bg-white/10 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return {
      toast: (item) => notify[item.type](item.title, item.message),
      success: notify.success,
      error: notify.error,
      info: notify.info,
      dismiss: () => undefined,
    };
  }
  return ctx;
}
