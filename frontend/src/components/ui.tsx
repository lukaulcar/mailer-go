import { useState } from "react";
import type { ReactNode } from "react";
import { Check, Copy, X } from "lucide-react";
import { notify } from "../lib/toast";
import { useModalBehavior } from "../lib/modal";
import { cx, fieldCls } from "../lib/utils";
import { CloseIcon } from "./icons";

export function Button({
  children,
  onClick,
  type,
  disabled,
  variant = "primary",
  size = "md",
  className,
  title,
  loading,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "submit" | "button";
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger" | "dark";
  size?: "sm" | "md" | "lg";
  className?: string;
  title?: string;
  loading?: boolean;
}) {
  const sizes = {
    sm: "px-3 py-1.5 text-[12.5px]",
    md: "px-3.5 py-2 text-[13px]",
    lg: "px-5 py-2.5 text-[13.5px]",
  };
  const variants = {
    primary: "bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-50",
    dark: "bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-50",
    secondary:
      "border border-neutral-200 bg-white text-neutral-800 hover:border-neutral-400 hover:text-neutral-900 disabled:opacity-50",
    ghost: "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50",
    danger:
      "border border-red-200 bg-white text-red-700 hover:bg-red-50 disabled:opacity-50",
  };
  return (
    <button
      type={type ?? "button"}
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-all disabled:cursor-not-allowed",
        sizes[size],
        variants[variant],
        className,
      )}
    >
      {loading && (
        <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {children}
    </button>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("overflow-hidden rounded-xl border border-neutral-200 bg-white", className)}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  count,
  description,
  actions,
}: {
  title: string;
  count?: number;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-5 py-4">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-neutral-900">
          {title}
          {typeof count === "number" && (
            <span className="rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-neutral-500">
              {count}
            </span>
          )}
        </h2>
        {description && <div className="mt-0.5 text-[12.5px] leading-relaxed text-neutral-500">{description}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">{children}</p>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "dark" | "green" | "red" | "amber" }) {
  const tones: Record<string, string> = {
    neutral: "border-neutral-200 bg-neutral-50 text-neutral-700",
    dark: "border-neutral-900 bg-neutral-900 text-white",
    green: "border-neutral-200 bg-white text-emerald-600",
    red: "border-neutral-200 bg-white text-red-600",
    amber: "border-neutral-200 bg-white text-amber-500",
  };
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold", tones[tone])}>
      {children}
    </span>
  );
}

export function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={cx("h-1.5 w-1.5 rounded-full", ok ? "bg-emerald-600" : "bg-neutral-300")} aria-hidden="true" />
  );
}

export function Field({
  label,
  children,
  htmlFor,
}: {
  label: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

export function ErrorBox({
  children,
  title,
  onDismiss,
  action,
  className,
}: {
  children: ReactNode;
  title?: string;
  onDismiss?: () => void;
  action?: { label: string; onClick: () => void };
  className?: string;
}) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className={cx(
        "flex items-start gap-3 rounded-xl border border-neutral-200 bg-white p-3.5 text-[13px] text-neutral-800 shadow-sm",
        className,
      )}
    >
      <div
        className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-neutral-100 text-red-600"
        aria-hidden="true"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 3.5a.75.75 0 01.75.75v4a.75.75 0 01-1.5 0v-4A.75.75 0 018 4.5zm0 7.5a1 1 0 100-2 1 1 0 000 2z"
            clipRule="evenodd"
          />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        {title && <p className="mb-0.5 font-semibold text-red-600">{title}</p>}
        <div className="font-medium leading-relaxed break-words text-red-600">{children}</div>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-red-600 underline underline-offset-2 hover:text-red-700"
          >
            {action.label} →
          </button>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto -mr-1 -mt-1 grid h-6 w-6 place-items-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
          aria-label="Dismiss error"
        >
          <CloseIcon size={12} />
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-[14px] font-semibold text-neutral-900">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-neutral-500">{body}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function CopyButton({
  text,
  dark,
  notifyMessage,
  label = "Copy",
}: {
  text: string;
  dark?: boolean;
  notifyMessage?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        setCopied(true);
        if (notifyMessage) notify.success(notifyMessage);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={copied ? "Copied to clipboard" : "Copy to clipboard"}
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[11px] font-medium transition-all active:scale-[0.98]",
        copied
          ? dark
            ? "border-emerald-500/40 bg-emerald-500/20 text-emerald-300"
            : "border-emerald-300 bg-emerald-50 text-emerald-800"
          : dark
            ? "border-white/20 bg-white/10 text-white hover:bg-white/20"
            : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-900 hover:text-neutral-900",
      )}
    >
      {copied ? (
        <>
          <Check className="h-3 w-3 stroke-[2.5]" /> Copied
        </>
      ) : (
        <>
          <Copy className="h-3 w-3 opacity-60" /> {label}
        </>
      )}
    </button>
  );
}

export function PasswordInput({
  id,
  value,
  onChange,
  placeholder = "Password",
  autoComplete,
  className,
  required,
  minLength,
  autoFocus,
  disabled,
  title,
}: {
  id?: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  autoComplete?: string;
  className?: string;
  required?: boolean;
  minLength?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative flex items-center">
      <input
        id={id}
        type={show ? "text" : "password"}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        autoFocus={autoFocus}
        disabled={disabled}
        title={title}
        className={cx(fieldCls, "pr-10", className)}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow((v) => !v)}
        aria-label={show ? "Hide password" : "Show password"}
        title={show ? "Hide password" : "Show password"}
        className="absolute right-2.5 grid h-7 w-7 place-items-center rounded text-neutral-400 transition-colors hover:text-neutral-800 focus:outline-none"
      >
        {show ? (
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M2.5 10c1.8-3.6 4.8-5.5 7.5-5.5 2.7 0 5.7 1.9 7.5 5.5-1.8 3.6-4.8 5.5-7.5 5.5-2.7 0-5.7-1.9-7.5-5.5z" />
            <line x1="3" y1="3" x2="17" y2="17" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M2.5 10c1.8-3.6 4.8-5.5 7.5-5.5 2.7 0 5.7 1.9 7.5 5.5-1.8 3.6-4.8 5.5-7.5 5.5-2.7 0-5.7-1.9-7.5-5.5z" />
            <circle cx="10" cy="10" r="2.5" />
          </svg>
        )}
      </button>
    </div>
  );
}

export function StatCard({
  title,
  value,
  subtext,
  badge,
  icon,
}: {
  title: string;
  value: ReactNode;
  subtext?: ReactNode;
  badge?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col justify-between rounded-xl border border-neutral-200 bg-white p-4 shadow-sm transition-all hover:border-neutral-300">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-wider text-neutral-400">{title}</p>
        {icon && <div className="text-neutral-400">{icon}</div>}
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <p className="text-[24px] font-bold tracking-tight text-neutral-900">{value}</p>
        {badge}
      </div>
      {subtext && <div className="mt-1 text-[12px] text-neutral-500">{subtext}</div>}
    </div>
  );
}

export function KeyboardShortcutsModal({ onClose }: { onClose: () => void }) {
  const shortcuts = [
    { key: "c", desc: "Compose new message" },
    { key: "j / ↓", desc: "Next message in list" },
    { key: "k / ↑", desc: "Previous message in list" },
    { key: "Enter / o", desc: "Open selected message" },
    { key: "u / Esc", desc: "Back to message list" },
    { key: "s", desc: "Star / unstar active message" },
    { key: "e / #", desc: "Delete active/selected message" },
    { key: "r", desc: "Reply to message" },
    { key: "f", desc: "Forward message" },
    { key: "/", desc: "Focus search input" },
    { key: "?", desc: "Open keyboard shortcuts" },
  ];

  return (
    <Modal title="Keyboard Shortcuts" subtitle="Fast keyboard navigation for your inbox" onClose={onClose}>
      <div className="divide-y divide-neutral-100">
        {shortcuts.map((s) => (
          <div key={s.key} className="flex items-center justify-between py-2.5 text-[13px]">
            <span className="text-neutral-600">{s.desc}</span>
            <kbd className="rounded border border-neutral-200 bg-neutral-100 px-2 py-1 font-mono text-[11.5px] font-semibold text-neutral-800 shadow-sm">
              {s.key}
            </kbd>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useModalBehavior(onClose);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-neutral-950/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className={cx("w-full overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl", wide ? "max-w-3xl" : "max-w-lg")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4">
          <div>
            <h3 className="text-[15px] font-semibold tracking-tight text-neutral-900">{title}</h3>
            {subtitle && <p className="mt-0.5 text-[12.5px] text-neutral-500">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-neutral-200 bg-neutral-50 px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  meta,
  actions,
}: {
  eyebrow: string;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-1 truncate text-[26px] font-semibold tracking-tight text-neutral-900">{title}</h1>
        {meta && <div className="mt-1 text-[12.5px] text-neutral-500">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex gap-5 border-b border-neutral-200" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            "-mb-px border-b-2 pb-2 text-[13.5px] font-semibold transition-colors",
            active === t.id
              ? "border-neutral-900 text-neutral-900"
              : "border-transparent text-neutral-400 hover:text-neutral-900",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CodeBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-900">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3.5 py-2">
        <p className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-white/50">{title}</p>
        <CopyButton dark text={code} />
      </div>
      <pre className="overflow-x-auto p-3.5 font-mono text-[11.5px] leading-relaxed text-neutral-100">{code}</pre>
    </div>
  );
}

export { default as ConfirmModal } from "./ConfirmModal";
