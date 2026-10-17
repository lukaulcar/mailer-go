import { useState } from "react";
import type { FormEvent } from "react";
import { Clock } from "lucide-react";
import { useAuth } from "../lib/auth";
import { getErrorMessage } from "../lib/api";
import { notify } from "../lib/toast";
import { useModalBehavior } from "../lib/modal";
import { authFieldCls, isValidEmail, labelCls } from "../lib/utils";
import { ErrorBox, PasswordInput } from "./ui";
import { CloseIcon } from "./icons";

interface Props {
  mode: "login" | "signup";
  onClose: () => void;
  onSwitch: (mode: "login" | "signup") => void;
}

export default function AuthModal({ mode, onClose, onSwitch }: Props) {
  const { login, signup, authBusy } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [pendingSuccess, setPendingSuccess] = useState(false);

  useModalBehavior(onClose);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    const cleanEmail = email.trim().toLowerCase();
    if (!isValidEmail(cleanEmail)) {
      setLocalError("Enter a valid email address.");
      return;
    }
    if (password.length < 6) {
      setLocalError("Password must be at least 6 characters.");
      return;
    }
    try {
      if (mode === "login") {
        await login(cleanEmail, password);
        notify.success("Welcome back!", `Signed in as ${cleanEmail}`);
        onClose();
      } else {
        const res = await signup(cleanEmail, password);
        if (res.pendingApproval) {
          setPendingSuccess(true);
        } else {
          notify.success("Account created successfully!", `Signed in as ${cleanEmail}`);
          onClose();
        }
      }
    } catch (err) {
      setLocalError(getErrorMessage(err, mode === "login" ? "Login failed. Please check your email and password." : "Signup failed. Please try again."));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-neutral-950/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={mode === "login" ? "Log in to MailerGo" : "Create a MailerGo account"}
      onClick={onClose}
    >
      <div
        className="grid w-full max-w-3xl overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl md:grid-cols-[0.9fr_1.1fr]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative hidden flex-col justify-between bg-neutral-900 p-8 text-white md:flex">
          <div className="bg-dots absolute inset-0 opacity-[0.13] invert" aria-hidden="true" />
          <div className="relative">
            <p className="text-[20px] font-bold">MailerGo</p>
            <p className="font-accent mt-6 text-[30px] leading-tight text-white/95">
              "The email bill finally went to zero."
            </p>
          </div>
          <div className="relative">
            <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg bg-white/15">
              {[
                ["1", "domain"],
                ["5×100MB", "mailboxes"],
                ["∞", "self-host"],
              ].map(([v, l]) => (
                <div key={l} className="min-w-0 bg-neutral-900 px-1 py-4 text-center">
                  <p className={`font-bold tracking-tight whitespace-nowrap ${v.length > 4 ? "text-[14px] sm:text-[15.5px]" : "text-[19px]"}`}>{v}</p>
                  <p className="truncate text-[11px] text-white/55">{l}</p>
                </div>
              ))}
            </div>
            <p className="mt-4 font-mono text-[11px] text-white/40">MIT open source · by Luka Ulcar</p>
          </div>
        </div>

        <div className="p-7 md:p-9">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-[26px] font-bold leading-tight text-neutral-900">
                {pendingSuccess ? "Approval Pending" : mode === "login" ? "Welcome back." : "Start free."}
              </h2>
              <p className="mt-1 text-[13.5px] text-neutral-500">
                {pendingSuccess
                  ? "Your account was created and is waiting for administrator approval."
                  : mode === "login"
                  ? "Your mailboxes missed you."
                  : "1 domain. 5 mailboxes (100MB each). Free forever."}
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

          {pendingSuccess ? (
            <div className="mt-6 space-y-5">
              <div className="rounded-xl border border-neutral-200 bg-white p-4.5 text-[13.5px] shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border border-neutral-200 bg-neutral-50 text-amber-500">
                    <Clock className="h-3.5 w-3.5" />
                  </div>
                  <div>
                    <p className="font-semibold text-amber-500">Registration request received</p>
                    <p className="mt-1 leading-relaxed text-neutral-600">
                      Your account for <strong className="font-mono text-neutral-900">{email}</strong> has been submitted. The administrator must approve your account before you can log in.
                    </p>
                    <p className="mt-2 text-[12.5px] text-neutral-400">
                      Once approved, you will have access to your 1 free custom domain and 5 mailboxes with 100MB storage.
                    </p>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  setPendingSuccess(false);
                  onSwitch("login");
                }}
                className="w-full rounded-md bg-neutral-900 py-3 text-[14px] font-semibold text-white transition-all hover:bg-neutral-800"
              >
                Go to Log In →
              </button>
            </div>
          ) : (
            <>
              <div className="mt-6 grid grid-cols-2 rounded-md border border-neutral-200 bg-neutral-50 p-1" role="tablist" aria-label="Auth mode">
                {(["login", "signup"] as const).map((m) => (
                  <button
                    key={m}
                    role="tab"
                    aria-selected={mode === m}
                    onClick={() => {
                      setLocalError(null);
                      setPassword("");
                      onSwitch(m);
                    }}
                    className={`rounded-md py-2.5 text-[13px] font-semibold transition-all ${
                      mode === m ? "bg-neutral-900 text-white shadow" : "text-neutral-500 hover:text-neutral-900"
                    }`}
                  >
                    {m === "login" ? "Log in" : "Sign up"}
                  </button>
                ))}
              </div>

              <form onSubmit={handleSubmit} className="mt-5 space-y-4" noValidate>
                <div>
                  <label htmlFor="auth-email" className={labelCls}>Email</label>
                  <input id="auth-email" type="email" autoComplete="email" required placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} className={authFieldCls} />
                </div>
                <div>
                  <label htmlFor="auth-password" className={labelCls}>Password</label>
                  <PasswordInput
                    id="auth-password"
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    required
                    minLength={6}
                    placeholder="Minimum 6 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>

                {localError && (
                  <ErrorBox onDismiss={() => setLocalError(null)}>
                    {localError}
                  </ErrorBox>
                )}

                <button
                  type="submit"
                  disabled={authBusy}
                  className="w-full rounded-md bg-neutral-900 py-3.5 text-[14.5px] font-semibold text-white transition-all hover:bg-neutral-800 disabled:cursor-wait disabled:opacity-60"
                >
                  {authBusy ? "Please wait…" : mode === "login" ? "Log in →" : "Request free account →"}
                </button>
              </form>

              <p className="mt-5 text-center font-mono text-[11px] leading-relaxed text-neutral-400">
                secure central authentication · 1 domain · 5 mailboxes (100MB each)
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
