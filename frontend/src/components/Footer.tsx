import { Mark } from "./Header";

export default function Footer() {
  return (
    <footer className="border-t border-neutral-200 bg-white" aria-label="Footer">
      <div className="mx-auto max-w-6xl px-5 pb-8 pt-12 md:px-8">
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div className="max-w-xs">
            <div className="flex items-center gap-2">
              <Mark size={24} />
              <span className="text-[15px] font-semibold tracking-[-0.02em] text-neutral-950">
                MailerGo
              </span>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-neutral-500">
              MIT-licensed, self-hosted email infrastructure. Domains, mailboxes,
              templates, API keys and webhooks.
            </p>
            <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.12em] text-neutral-400">
              Go · React · SQLite · SMTP
            </p>
          </div>

          {[
            {
              title: "Product",
              links: [
                { label: "Features", href: "#product" },
                { label: "Setup", href: "#how-it-works" },
                { label: "API", href: "#api" },
                { label: "Hosting", href: "#hosting" },
              ],
            },
            {
              title: "Developers",
              links: [
                { label: "GitHub", href: "https://github.com/lukaulcar/mailer-go" },
                { label: "Report an issue", href: "https://github.com/lukaulcar/mailer-go/issues" },
              ],
            },
            {
              title: "More",
              links: [
                { label: "FAQ", href: "#faq" },
                { label: "Back to top", href: "#top" },
              ],
            },
          ].map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-neutral-400">
                {col.title}
              </p>
              <ul className="mt-3.5 space-y-2 text-[13.5px]">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="text-neutral-500 transition-colors hover:text-neutral-950"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-10 flex flex-col gap-1 border-t border-neutral-100 pt-5 text-[12px] text-neutral-400 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} MailerGo</p>
          <p>Open source, MIT licensed</p>
        </div>
      </div>
    </footer>
  );
}
