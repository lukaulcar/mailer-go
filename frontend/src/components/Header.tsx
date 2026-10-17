import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { useMailbox } from "../lib/mailboxAuth";

export function GithubMark({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function Mark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[8px] bg-neutral-950 text-white"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg width={size * 0.54} height={size * 0.54} viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="3" width="13" height="10" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M2.5 4.5 8 9l5.5-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

const NAV = [
  { label: "Product", href: "#product" },
  { label: "Setup", href: "#how-it-works" },
  { label: "API", href: "#api" },
  { label: "Hosting", href: "#hosting" },
  { label: "FAQ", href: "#faq" },
];

export default function Header({
  onAuth,
  onMailboxLogin,
  onGoDashboard,
  onGoMail,
}: {
  onAuth: (mode: "login" | "signup") => void;
  onMailboxLogin: () => void;
  onGoDashboard: () => void;
  onGoMail: () => void;
}) {
  const { user, logout } = useAuth();
  const { accounts } = useMailbox();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const signedIn = Boolean(user) || accounts.length > 0;

  return (
    <header className="fixed inset-x-0 top-0 z-40">
      <div
        className={`mx-auto transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          scrolled
            ? "max-w-[880px] px-3 pt-3 sm:px-4 sm:pt-4"
            : "max-w-6xl px-0 pt-0"
        }`}
      >
        <div
          className={`transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            scrolled
              ? "rounded-full border border-neutral-200/90 bg-white/80 shadow-[0_12px_40px_-12px_rgb(0_0_0/0.22)] backdrop-blur-xl"
              : "rounded-none border border-transparent bg-white/0 backdrop-blur-none"
          }`}
        >
          <div
            className={`mx-auto flex items-center justify-between gap-3 transition-all duration-500 ${
              scrolled ? "h-14 px-3 sm:px-4" : "h-[72px] px-5 md:px-8"
            }`}
          >
            <a href="#top" className="flex items-center gap-2" aria-label="MailerGo home">
              <Mark size={scrolled ? 26 : 28} />
              <span className="text-[16px] font-semibold tracking-[-0.02em] text-neutral-950">
                MailerGo
              </span>
            </a>

            <nav className="hidden items-center gap-1 lg:flex" aria-label="Primary">
              {NAV.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="rounded-full px-3 py-1.5 text-[13.5px] font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-950"
                >
                  {item.label}
                </a>
              ))}
            </nav>

            <div className="hidden items-center gap-1.5 lg:flex">
              {signedIn ? (
                <>
                  <button
                    onClick={onGoMail}
                    className="cursor-pointer rounded-full px-3.5 py-2 text-[13.5px] font-medium text-neutral-600 transition-colors hover:text-neutral-950"
                  >
                    Mail{accounts.length > 1 ? ` (${accounts.length})` : ""} →
                  </button>
                  <button
                    onClick={onGoDashboard}
                    className="cursor-pointer rounded-full bg-neutral-950 px-[18px] py-2 text-[13.5px] font-medium text-white transition-colors hover:bg-neutral-800"
                  >
                    Dashboard
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={onMailboxLogin}
                    className="cursor-pointer rounded-full px-3.5 py-2 text-[13.5px] font-medium text-neutral-600 transition-colors hover:text-neutral-950"
                  >
                    Mailbox login
                  </button>
                  <button
                    onClick={() => onAuth("login")}
                    className="cursor-pointer rounded-full px-3.5 py-2 text-[13.5px] font-medium text-neutral-600 transition-colors hover:text-neutral-950"
                  >
                    Sign in
                  </button>
                  <button
                    onClick={() => onAuth("signup")}
                    className="cursor-pointer rounded-full bg-neutral-950 px-[18px] py-2 text-[13.5px] font-medium text-white transition-colors hover:bg-neutral-800"
                  >
                    Get started
                  </button>
                </>
              )}
            </div>

            <button
              className={`grid h-9 w-9 cursor-pointer place-items-center rounded-full border bg-white lg:hidden transition-colors ${
                scrolled ? "border-neutral-200" : "border-neutral-200"
              }`}
              onClick={() => setOpen((v) => !v)}
              aria-label="Toggle menu"
              aria-expanded={open}
            >
              <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                {open
                  ? <path d="M3 3l12 12M15 3 3 15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                  : <path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />}
              </svg>
            </button>
          </div>

          {open && (
            <div className="mx-2 mb-2 rounded-3xl border border-neutral-200 bg-white px-5 pb-6 pt-2 shadow-xl lg:hidden">
              <nav className="flex flex-col" aria-label="Mobile">
                {NAV.map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="flex items-center justify-between border-b border-neutral-100 py-3.5 text-[15px] font-medium text-neutral-900"
                  >
                    {item.label}
                    <span aria-hidden="true" className="text-neutral-300">→</span>
                  </a>
                ))}
              </nav>
              <div className="mt-4 flex flex-col gap-2">
                {signedIn ? (
                  <>
                    <button onClick={() => { setOpen(false); onGoMail(); }} className="w-full cursor-pointer rounded-full border border-neutral-200 py-3 text-[14px] font-medium">
                      Open mail →
                    </button>
                    <button onClick={() => { setOpen(false); onGoDashboard(); }} className="w-full cursor-pointer rounded-full bg-neutral-950 py-3 text-[14px] font-medium text-white">
                      Dashboard
                    </button>
                    {user && (
                      <button onClick={() => { void logout(); setOpen(false); }} className="w-full cursor-pointer rounded-full py-3 text-[14px] font-medium text-neutral-500">
                        Sign out
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <button onClick={() => { setOpen(false); onMailboxLogin(); }} className="w-full cursor-pointer rounded-full border border-neutral-200 py-3 text-[14px] font-medium">
                      Mailbox login
                    </button>
                    <button onClick={() => { setOpen(false); onAuth("signup"); }} className="w-full cursor-pointer rounded-full bg-neutral-950 py-3 text-[14px] font-medium text-white">
                      Get started
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
