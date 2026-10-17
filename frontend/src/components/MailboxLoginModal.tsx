import { useState } from "react";
import type { FormEvent } from "react";
import { useMailbox } from "../lib/mailboxAuth";
import { getErrorMessage } from "../lib/api";
import { authFieldCls, labelCls } from "../lib/utils";
import { useModalBehavior } from "../lib/modal";
import { notify } from "../lib/toast";
import { ErrorBox, PasswordInput } from "./ui";
import { CloseIcon } from "./icons";

interface Props {
  initialAddress?: string;
  onClose: () => void;
}

export default function MailboxLoginModal({ initialAddress = "", onClose }: Props) {
  const { mailboxLogin, mailboxBusy } = useMailbox();
  const [address, setAddress] = useState(initialAddress);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useModalBehavior(onClose);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const cleanAddress = address.trim().toLowerCase();
    try {
      await mailboxLogin(cleanAddress, password);
      notify.success("Mailbox opened!", `Signed in as ${cleanAddress}`);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Mailbox login failed. Please verify the mailbox email and password."));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-neutral-950/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Log in to your mailbox"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-neutral-200 bg-white p-7 shadow-xl md:p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-[24px] font-bold leading-tight text-neutral-900">Mailbox login.</h2>
            <p className="mt-1 text-[13.5px] text-neutral-500">
              Type your mailbox email + its password to open your inbox.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
          >
            <CloseIcon aria-hidden />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4" noValidate>
          <div>
            <label htmlFor="mbox-login-email" className={labelCls}>
              Mailbox email
            </label>
            <input
              id="mbox-login-email"
              type="email"
              autoComplete="email"
              required
              autoFocus
              placeholder="hello@yourapp.com"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className={`${authFieldCls} font-mono`}
            />
          </div>
          <div>
            <label htmlFor="mbox-login-password" className={labelCls}>
              Mailbox password
            </label>
            <PasswordInput
              id="mbox-login-password"
              autoComplete="current-password"
              required
              placeholder="The password set for this mailbox"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="font-mono"
            />
          </div>

          {error && (
            <ErrorBox onDismiss={() => setError(null)}>
              {error}
            </ErrorBox>
          )}

          <button
            type="submit"
            disabled={mailboxBusy}
            className="w-full rounded-md bg-neutral-900 py-3.5 text-[14.5px] font-semibold text-white transition-all hover:bg-neutral-800 disabled:cursor-wait disabled:opacity-60"
          >
            {mailboxBusy ? "Opening inbox…" : "Open my inbox →"}
          </button>
        </form>

        <p className="mt-4 text-center font-mono text-[11px] leading-relaxed text-neutral-400">
          passwords are per-mailbox · set in dashboard → mailboxes
        </p>
      </div>
    </div>
  );
}
