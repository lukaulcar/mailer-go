import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useModalBehavior } from "../lib/modal";

export interface ConfirmOptions {
  title?: string;
  message: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmModalProps {
  options: ConfirmOptions;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  options,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const {
    title = "Confirm action",
    message,
    description,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
  } = options;

  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmBtnRef.current?.focus();
  }, []);

  useModalBehavior(onCancel, { capture: true, stopPropagation: true });

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center overflow-y-auto bg-neutral-950/50 p-4 backdrop-blur-sm animate-in fade-in duration-150"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl transition-all"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-neutral-100 px-6 py-4">
          <div className="flex items-center gap-3">
            {danger ? (
              <span
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-neutral-200 bg-neutral-50 text-red-600"
                aria-hidden="true"
              >
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M10 6v5M10 14.5v.5M3.2 16.5h13.6c1.1 0 1.8-1.2 1.2-2.1L11.2 3.4c-.5-.9-1.9-.9-2.4 0L2 14.4c-.6.9.1 2.1 1.2 2.1z"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            ) : (
              <span
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-neutral-200 bg-neutral-100 text-neutral-800"
                aria-hidden="true"
              >
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.7" />
                  <path d="M10 9v5M10 6.5v.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
              </span>
            )}
            <h3 className="text-[16px] font-bold tracking-tight text-neutral-900">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 py-5">
          <div className="text-[13.5px] leading-relaxed text-neutral-600">{message}</div>
          {description && (
            <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-500">{description}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2.5 border-t border-neutral-100 bg-neutral-50 px-6 py-3.5">
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-md border border-neutral-200 bg-white px-4 py-2 text-[13px] font-semibold text-neutral-700 transition-colors hover:border-neutral-400 hover:text-neutral-900"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            onClick={onConfirm}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-4 py-2 text-[13px] font-semibold text-white transition-colors ${
              danger
                ? "bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500/30"
                : "bg-neutral-900 hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-900/30"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
