import { useCallback, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Check } from "lucide-react";
import GmailPreview from "./GmailPreview";
import { useConfirm } from "../lib/confirm";
import { getErrorMessage } from "../lib/api";
import { isValidEmail } from "../lib/utils";
import { useModalBehavior } from "../lib/modal";
import { notify } from "../lib/toast";
import { ErrorBox } from "./ui";
import { CloseIcon } from "./icons";

interface Prefill {
  to?: string;
  subject?: string;
  body?: string;
}

export default function ComposeModal({
  from,
  fromName,
  prefill,
  onClose,
  onSend,
}: {
  from: string;
  fromName?: string;
  prefill?: Prefill;
  onClose: () => void;
  onSend: (to: string, subject: string, body: string) => Promise<void>;
}) {
  const confirm = useConfirm();
  const [to, setTo] = useState(prefill?.to ?? "");
  const [subject, setSubject] = useState(prefill?.subject ?? "");
  const [body, setBody] = useState(prefill?.body ?? "");
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const dirty = to.trim() !== "" || subject.trim() !== "" || body.trim() !== "";

  const tryClose = useCallback(async () => {
    if (dirty) {
      const ok = await confirm({
        title: "Discard draft?",
        message: "You have unsaved changes in this email draft. Are you sure you want to discard them?",
        confirmLabel: "Discard draft",
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  }, [confirm, dirty, onClose]);

  const handleSend = useCallback(async () => {
    setError(null);
    const cleanTo = to.trim();
    if (!cleanTo) {
      setError("Add a recipient first.");
      setTab("write");
      return;
    }
    if (!isValidEmail(cleanTo)) {
      setError("That To address doesn't look right.");
      setTab("write");
      return;
    }
    if (!body.trim() && !subject.trim()) {
      setError("Write a subject or a message first.");
      setTab("write");
      return;
    }
    setSending(true);
    try {
      await onSend(cleanTo, subject, body);
      notify.success("Email sent", `To ${cleanTo}`);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to send email. Please check your mail relay configuration and recipient address."));
      setTab("write");
    } finally {
      setSending(false);
    }
  }, [body, onSend, subject, to]);

  useModalBehavior(tryClose, {
    onKeyDown: (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void handleSend();
      }
    },
  });

  function wrapSelection(before: string, after = before) {
    const el = bodyRef.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e, value } = el;
    const selected = value.slice(s, e) || "text";
    const next = `${value.slice(0, s)}${before}${selected}${after}${value.slice(e)}`;
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + before.length, s + before.length + selected.length);
    });
  }

  function prefixLines(prefix: string) {
    const el = bodyRef.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e, value } = el;
    const selected = value.slice(s, e) || value.split("\n")[0] || "item";
    const next =
      value.slice(0, s) +
      selected
        .split("\n")
        .map((l) => `${prefix}${l}`)
        .join("\n") +
      value.slice(e);
    setBody(next);
    requestAnimationFrame(() => el.focus());
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void handleSend();
  }

  const inputRow = "flex items-center gap-3 border-b border-neutral-100 px-6 py-3";
  const labelCls = "w-14 shrink-0 text-[13px] font-medium text-neutral-400";

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-neutral-950/50 p-3 backdrop-blur-[2px] sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="New message"
      onClick={tryClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-6 pt-5">
          <div>
            <h2 className="text-[21px] font-bold tracking-tight text-neutral-900">New message</h2>
            <p className="mt-0.5 font-mono text-[12px] text-neutral-400">
              from {fromName ? `${fromName} <${from}>` : from}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="grid grid-cols-2 rounded-md bg-neutral-100 p-1" role="tablist" aria-label="Compose view">
              {(["write", "preview"] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`rounded-md px-4 py-1.5 text-[12.5px] font-semibold capitalize transition-all ${tab === t ? "bg-neutral-900 text-white shadow" : "text-neutral-500 hover:text-neutral-900"
                    }`}
                >
                  {t === "preview" ? "Receiver view" : "Write"}
                </button>
              ))}
            </div>
            <button
              onClick={tryClose}
              aria-label="Close compose"
              className="grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
            >
              <CloseIcon size={15} aria-hidden />
            </button>
          </div>
        </div>

        {tab === "write" ? (
          <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
            <div className="mt-3 border-t border-neutral-100">
              <div className={inputRow}>
                <span className={labelCls}>To</span>
                <input
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="name@example.com"
                  aria-label="To"
                  autoFocus
                  className="w-full bg-transparent font-mono text-[13.5px] outline-none placeholder:text-neutral-300"
                />
              </div>
              <div className={inputRow}>
                <span className={labelCls}>Subject</span>
                <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" className="w-full bg-transparent text-[14px] font-medium outline-none placeholder:font-normal placeholder:text-neutral-300" />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-0.5 border-b border-neutral-100 px-4 py-1.5">
              <FormatButton label="Bold" onClick={() => wrapSelection("**")}>
                <span className="font-bold">B</span>
              </FormatButton>
              <FormatButton label="Italic" onClick={() => wrapSelection("*")}>
                <span className="italic">I</span>
              </FormatButton>
              <FormatButton label="Link" onClick={() => wrapSelection("[", "](https://)")}>
                <svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M8 12a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L9.5 4.8M12 8a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </FormatButton>
              <span className="mx-1 h-4 w-px bg-neutral-200" aria-hidden="true" />
              <FormatButton label="Bullet list" onClick={() => prefixLines("• ")}>
                <svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M7 5h10M7 10h10M7 15h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /><circle cx="4" cy="5" r="1.2" fill="currentColor" /><circle cx="4" cy="10" r="1.2" fill="currentColor" /><circle cx="4" cy="15" r="1.2" fill="currentColor" /></svg>
              </FormatButton>
              <FormatButton label="Numbered list" onClick={() => prefixLines("1. ")}>
                <svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M8 5h9M8 10h9M8 15h9M3.5 4.5 4.5 5.5 3 7M3.5 9.5l1 1-1.5 1.5M3.5 14.5l1 1-1.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </FormatButton>
              <span className="mx-1 h-4 w-px bg-neutral-200" aria-hidden="true" />
              <span className="ml-auto hidden font-mono text-[11px] tabular-nums text-neutral-300 sm:block">{body.length} chars</span>
            </div>

            <textarea
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              placeholder="Write your message…"
              aria-label="Message body"
              className="min-h-[220px] w-full flex-1 resize-none px-6 py-4 text-[14.5px] leading-[1.7] text-neutral-900 outline-none placeholder:text-neutral-300"
            />

            {error && (
              <div className="mx-6 mb-3">
                <ErrorBox onDismiss={() => setError(null)}>{error}</ErrorBox>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 border-t border-neutral-100 bg-neutral-50/60 px-6 py-3.5">
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={sending}
                  title="Send message (⌘+Enter / Ctrl+Enter)"
                  className="cursor-pointer rounded-md bg-neutral-900 px-6 py-2.5 text-[13.5px] font-semibold text-white transition-all hover:bg-neutral-800 disabled:cursor-wait disabled:opacity-60"
                >
                  {sending ? "Sending…" : "Send"}
                </button>
                <button type="button" onClick={tryClose} className="cursor-pointer rounded-md px-4 py-2.5 text-[13px] font-semibold text-neutral-500 transition-colors hover:bg-neutral-200/60 hover:text-neutral-900">
                  Discard
                </button>
              </div>
              <p className="hidden font-mono text-[11px] text-neutral-400 sm:block">
                {dirty ? <span className="inline-flex items-center gap-1 text-emerald-700 font-medium"><Check className="h-3 w-3 stroke-[2.5]" /> Draft saved</span> : "No draft"}
              </p>
            </div>
          </form>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto bg-neutral-50/60 px-6 py-5">
              <GmailPreview from={from} fromName={fromName} to={to.trim() || "—"} subject={subject} body={body} />
              <p className="mt-3 text-center font-mono text-[11px] text-neutral-400">
                receiver view · rendered like Gmail
              </p>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-neutral-100 px-6 py-3.5">
              <button onClick={() => setTab("write")} className="cursor-pointer rounded-md border border-neutral-200 px-5 py-2.5 text-[13px] font-semibold transition-colors hover:border-neutral-900">
                ← Back to editing
              </button>
              <button
                onClick={handleSubmit}
                disabled={sending}
                className="cursor-pointer rounded-md bg-neutral-900 px-8 py-2.5 text-[13.5px] font-semibold text-white transition-all hover:bg-neutral-800 disabled:cursor-wait disabled:opacity-60"
              >
                {sending ? "Sending…" : "Looks good — send"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FormatButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-[13px] text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
    >
      {children}
    </button>
  );
}
