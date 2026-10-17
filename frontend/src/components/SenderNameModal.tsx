import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Check, Mail, Settings, Sparkles, X } from "lucide-react";
import { api, getErrorMessage } from "../lib/api";
import { useModalBehavior } from "../lib/modal";
import { notify } from "../lib/toast";
import { ErrorBox } from "./ui";

interface SenderNameModalProps {
  address: string;
  initialName?: string;
  onClose: () => void;
  onSaved: (newName: string) => void;
}

function cleanSuggestedName(addr: string): string {
  const local = addr.split("@")[0] ?? addr;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(" ");
}

export default function SenderNameModal({
  address,
  initialName = "",
  onClose,
  onSaved,
}: SenderNameModalProps) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggested = useMemo(() => cleanSuggestedName(address), [address]);
  const trimmedName = name.trim();
  const trimmedInitial = initialName.trim();
  const hasChanges = trimmedName !== trimmedInitial;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSave = useCallback(async () => {
    setError(null);
    setSaving(true);
    try {
      await api.mailboxes.setDisplayName(address, trimmedName);
      onSaved(trimmedName);
      notify.success(
        trimmedName ? "Sender display name updated" : "Sender name reset to empty",
        trimmedName ? `Recipients will see "${trimmedName}"` : `Recipients will only see ${address}`,
      );
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to update sender name. Please try again."));
    } finally {
      setSaving(false);
    }
  }, [address, onClose, onSaved, trimmedName]);

  useModalBehavior(onClose, {
    onKeyDown: (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSave();
      }
    },
  });

  const previewSender = trimmedName || address;
  const avatarLetter = (trimmedName.charAt(0) || address.charAt(0) || "?").toUpperCase();

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-neutral-950/50 p-3 backdrop-blur-[2px] sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sender-modal-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl transition-all"
        onClick={(e) => e.stopPropagation()}
      >
        
        <div className="flex items-start justify-between border-b border-neutral-100 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-neutral-100 text-neutral-800">
              <Settings className="h-5 w-5" />
            </div>
            <div>
              <h2 id="sender-modal-title" className="text-[17px] font-bold text-neutral-900">
                Sender Display Name
              </h2>
              <p className="font-mono text-[11.5px] text-neutral-400">
                {address}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void handleSave();
          }}
          className="p-6 space-y-5"
        >
          {error && <ErrorBox onDismiss={() => setError(null)}>{error}</ErrorBox>}

          <div className="rounded-xl border border-neutral-200/80 bg-neutral-50/70 p-3.5 text-[12.5px] text-neutral-600">
            <p>
              Set the name that receivers will see next to your email address when receiving messages from this mailbox.
            </p>
            <p className="mt-1.5 text-[11.5px] text-neutral-400">
              By default, this is empty — receivers will only see your email address.
            </p>
          </div>

          
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="sender-name-input" className="text-[12.5px] font-semibold text-neutral-700">
                Display Name
              </label>
              {trimmedName && (
                <button
                  type="button"
                  onClick={() => setName("")}
                  className="text-[11.5px] font-medium text-neutral-400 hover:text-red-600 transition"
                >
                  Clear (leave empty)
                </button>
              )}
            </div>

            <div className="relative">
              <input
                ref={inputRef}
                id="sender-name-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Luka Ulčar (empty by default)"
                maxLength={100}
                className="w-full rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 pr-9 text-[13.5px] text-neutral-900 placeholder-neutral-400 transition focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
              />
              {name && (
                <button
                  type="button"
                  onClick={() => setName("")}
                  aria-label="Clear input"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-700"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            
            {suggested && suggested.toLowerCase() !== trimmedName.toLowerCase() && (
              <div className="mt-2 flex items-center gap-1.5">
                <span className="text-[11px] text-neutral-400">Suggestion:</span>
                <button
                  type="button"
                  onClick={() => setName(suggested)}
                  className="inline-flex items-center gap-1 rounded-md bg-neutral-100 px-2 py-0.5 text-[11.5px] font-medium text-neutral-700 hover:bg-neutral-200 transition"
                >
                  <Sparkles className="h-3 w-3 text-neutral-500" />
                  {suggested}
                </button>
              </div>
            )}
          </div>

          
          <div>
            <p className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-neutral-400 mb-2">
              Receiver Inbox Preview
            </p>
            <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
              <div className="flex items-center gap-2 border-b border-neutral-100 bg-neutral-50/60 px-3.5 py-2 text-[11px] text-neutral-400">
                <Mail className="h-3.5 w-3.5 text-neutral-400" />
                <span>Recipient's Inbox view</span>
              </div>
              <div className="p-3.5 flex items-center gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-neutral-900 text-white text-[12.5px] font-bold">
                  {avatarLetter}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[13px] font-bold text-neutral-900">
                      {previewSender}
                    </span>
                    {trimmedName && (
                      <span className="truncate font-mono text-[11px] text-neutral-400">
                        &lt;{address}&gt;
                      </span>
                    )}
                  </div>
                  <p className="truncate text-[11.5px] text-neutral-500 mt-0.5">
                    Project update &amp; meeting notes · Hey there, here is the report...
                  </p>
                </div>
              </div>
            </div>
          </div>

          
          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-neutral-100">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-xl border border-neutral-200 px-4 py-2 text-[13px] font-semibold text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !hasChanges}
              className="inline-flex items-center gap-2 rounded-xl bg-neutral-900 px-5 py-2 text-[13px] font-semibold text-white transition hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                  Saving…
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" />
                  Save Name
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
