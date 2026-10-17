import { useState } from "react";
import {
  ArrowRight,
  Check,
  Copy,
  Globe,
  Inbox,
  KeyRound,
  LayoutTemplate,
  Plus,
  Radio,
  Search,
  ShieldCheck,
  Star,
} from "lucide-react";
import { notify } from "../lib/toast";
import { Reveal } from "./Reveal";

const STACK = ["Go", "React", "SQLite", "SMTP :25", "DKIM signing", "SPF · DKIM · DMARC", "POST /v1/send", "Webhooks"];

const PREVIEW_TABS = [
  { id: "verify", label: "Verify DNS" },
  { id: "send", label: "Send via API" },
  { id: "read", label: "Read in webmail" },
] as const;

type PreviewTab = (typeof PREVIEW_TABS)[number]["id"];

const DNS_ROWS: Array<[string, string]> = [
  ["MX", "Receiving — points to your server"],
  ["SPF", "Sending — authorizes your server"],
  ["DKIM", "Signing — 2048-bit key generated for you"],
  ["DMARC", "Policy — aligned with SPF + DKIM"],
];

const INBOX_ROWS = [
  { from: "team@yourapp.com", subject: "Welcome, Sara — your mailbox is ready", time: "9:41", starred: true },
  { from: "system@yourapp.com", subject: "DNS verified for yourapp.com", time: "9:12", starred: false },
  { from: "team@yourapp.com", subject: "Your API key was created", time: "Yesterday", starred: false },
];

const TABS = ["cURL", "JavaScript"] as const;

const SNIPPETS: Record<(typeof TABS)[number], string> = {
  cURL: `curl -X POST https://your-server/v1/send \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "welcome@yourapp.com",
    "to": ["new-user@example.com"],
    "template": "welcome",
    "vars": { "name": "Sara" }
  }'`,
  JavaScript: `await fetch("https://your-server/v1/send", {
  method: "POST",
  headers: {
    "Authorization": "Bearer " + process.env.MAILERGO_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    from: "welcome@yourapp.com",
    to: ["new-user@example.com"],
    template: "welcome",
    vars: { name: "Sara" }
  })
});`,
};

function SectionHead({ index, label, title, body }: { index: string; label: string; title: string; body: string }) {
  return (
    <Reveal className="max-w-2xl">
      <p className="flex items-center gap-3 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-400">
        <span className="text-neutral-950">{index}</span>
        <span className="h-px w-10 bg-neutral-300" aria-hidden="true" />
        {label}
      </p>
      <h2 className="mt-4 text-balance text-[30px] font-semibold leading-[1.08] tracking-[-0.032em] text-neutral-950 md:text-[44px]">
        {title}
      </h2>
      <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-neutral-500">{body}</p>
    </Reveal>
  );
}

const FEATURES = [
  {
    icon: Globe,
    title: "Domains + DNS verification",
    body: "Add a domain and get the MX, SPF, DKIM and DMARC records to add. Re-check them live from the dashboard.",
  },
  {
    icon: Inbox,
    title: "Mailboxes + webmail",
    body: "Standard, send-only and catch-all mailboxes. Sign in with email and password — inbox, sent, search, reply.",
  },
  {
    icon: LayoutTemplate,
    title: "Templates with variables",
    body: "Save a subject and HTML body with {{vars}}, preview with sample values, then send by template name.",
  },
  {
    icon: KeyRound,
    title: "Scoped API keys",
    body: "Keys scoped to a mailbox or domain, with send, templates and live-stream permissions, expiry and revocation.",
  },
  {
    icon: Radio,
    title: "Webhooks",
    body: "Subscribe a URL per domain for received, sent and bounced events — with a signing secret and on/off toggle.",
  },
  {
    icon: ShieldCheck,
    title: "Quotas + export",
    body: "Per-mailbox storage tracking with live updates. Export everything as a .zip and take it to your own server.",
  },
];

const STEPS = [
  {
    n: "01",
    t: "Add your domain",
    d: "Enter your domain. The dashboard shows the exact DNS records to add at your provider.",
  },
  {
    n: "02",
    t: "Verify, then add mailboxes",
    d: "Run Verify DNS until the checks pass, then create mailboxes with a login password.",
  },
  {
    n: "03",
    t: "Send from your app",
    d: "Create a scoped API key, then POST to /v1/send with subject/body — or a template with vars.",
  },
];

const FAQ = [
  [
    "What is MailerGo?",
    "Open-source mail hosting built with Go and React: an SMTP service for receiving and sending, plus a dashboard for domains, mailboxes, templates, API keys and webhooks.",
  ],
  [
    "What are the limits?",
    "Self-hosting has no limits in code — you're bounded by your own disk and server. The hosted free tier is 1 domain and 5 mailboxes at 100 MB each, and signups require admin approval.",
  ],
  [
    "How do I send email from code?",
    "Create an API key for a mailbox or domain, then POST to /v1/send with from, to, and either subject and body, or a template name with vars.",
  ],
  [
    "Is there webmail?",
    "Yes. Standard mailboxes sign in with email and password and can read the inbox and sent mail, search, star and reply.",
  ],
  [
    "Can I move to my own server later?",
    "Yes. Export your data as a .zip from the dashboard and use it on your own instance.",
  ],
];

export default function Sections({ onAuth }: { onAuth: (mode: "signup" | "login") => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("cURL");
  const [preview, setPreview] = useState<PreviewTab>("verify");
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [copied, setCopied] = useState(false);

  const copyCode = () => {
    void navigator.clipboard?.writeText(SNIPPETS[tab]).catch(() => undefined);
    setCopied(true);
    notify.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <main id="main" className="bg-white">
      
      <section id="preview" className="scroll-mt-20 border-b border-neutral-200 bg-neutral-50/60" aria-labelledby="preview-h">
        <div className="mx-auto max-w-6xl px-5 py-20 md:px-8 md:py-28">
          <div className="mx-auto max-w-2xl text-center" id="preview-h">
            <Reveal>
              <p className="flex items-center justify-center gap-3 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-400">
                <span className="text-neutral-950">01</span>
                <span className="h-px w-10 bg-neutral-300" aria-hidden="true" />
                Preview
              </p>
            </Reveal>
            <Reveal delay={60}>
              <h2 className="mt-4 text-balance text-[30px] font-semibold leading-[1.08] tracking-[-0.032em] text-neutral-950 md:text-[44px]">
                Verify. Send. Read. <span className="font-accent">One dashboard.</span>
              </h2>
            </Reveal>
            <Reveal delay={120}>
              <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed text-neutral-500">
                The whole flow in one place — check DNS against your nameserver,
                send with one request, read it in webmail.
              </p>
            </Reveal>
          </div>

          <Reveal delay={80} className="mt-9 flex justify-center">
            <div role="tablist" aria-label="Product views" className="inline-flex max-w-full flex-wrap justify-center gap-0.5 rounded-full border border-neutral-200 bg-white p-1 shadow-[0_1px_2px_rgb(0_0_0/0.05)]">
              {PREVIEW_TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={preview === t.id}
                  onClick={() => setPreview(t.id)}
                  className={`rounded-full px-3.5 py-2 text-[12.5px] font-medium transition-all sm:px-5 sm:text-[13px] ${
                    preview === t.id
                      ? "bg-neutral-950 text-white shadow"
                      : "text-neutral-500 hover:text-neutral-950"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </Reveal>

          <Reveal delay={120} className="mx-auto mt-8 max-w-4xl">
            <div
              key={preview}
              className="preview-in overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-[0_24px_80px_-32px_rgb(0_0_0/0.25)]"
            >
              
              <div className="flex items-center gap-2 border-b border-neutral-200 bg-neutral-50/80 px-4 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-neutral-300" aria-hidden="true" />
                <span className="h-2.5 w-2.5 rounded-full bg-neutral-300" aria-hidden="true" />
                <span className="h-2.5 w-2.5 rounded-full bg-neutral-950" aria-hidden="true" />
                <span className="ml-3 hidden font-mono text-[11px] text-neutral-400 sm:block">
                  mailergo — yourapp.com
                </span>
                <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-1 font-mono text-[10.5px] font-medium text-neutral-600">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                  DNS verified
                </span>
              </div>

              {preview === "verify" && (
                <div className="grid md:grid-cols-[240px_1fr]">
                  <div className="border-b border-neutral-100 p-5 md:border-b-0 md:border-r">
                    <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-400">
                      Domain
                    </p>
                    <p className="mt-1 text-[16px] font-semibold tracking-tight text-neutral-950">
                      yourapp.com
                    </p>
                    <ul className="mt-4 space-y-1.5">
                      {["MX", "SPF", "DKIM", "DMARC"].map((r) => (
                        <li
                          key={r}
                          className="flex items-center justify-between rounded-md bg-neutral-50 px-2.5 py-1.5 font-mono text-[11.5px]"
                        >
                          <span className="text-neutral-500">{r}</span>
                          <span className="font-medium text-emerald-600">✓ pass</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="bg-neutral-50/70 p-5">
                    <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-400">
                      Add at your provider, then re-check
                    </p>
                    <ul className="mt-4 space-y-2">
                      {DNS_ROWS.map(([t, d]) => (
                        <li
                          key={t}
                          className="flex flex-col gap-0.5 rounded-lg border border-neutral-200 bg-white px-3.5 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
                        >
                          <span className="shrink-0 font-mono text-[12px] font-medium text-neutral-900">{t}</span>
                          <span className="text-[12.5px] text-neutral-500 sm:text-right">{d}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-4 flex items-center justify-between gap-3">
                      <p className="font-mono text-[11px] text-neutral-400">
                        Most of the wait is propagation.
                      </p>
                      <span className="inline-flex h-9 items-center rounded-full bg-neutral-950 px-5 text-[13px] font-medium text-white">
                        Verify DNS
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {preview === "send" && (
                <div className="bg-neutral-950 p-4 sm:p-6" aria-label="API example">
                  <div className="flex items-center justify-between">
                    <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500">
                      POST /v1/send
                    </p>
                    <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 font-mono text-[10.5px] font-medium text-emerald-300">
                      202 queued
                    </span>
                  </div>
                  <pre className="mt-3 overflow-x-auto font-mono text-[11px] leading-[1.7] text-neutral-300 sm:text-[12.5px]">
                    <code>{`curl -X POST https:
  -H "Authorization: Bearer $KEY" \\
  -d '{
    "from": "welcome@yourapp.com",
    "to": ["new-user@example.com"],
    "template": "welcome",
    "vars": { "name": "Sara" }
  }'`}</code>
                  </pre>
                  <div className="mt-4 flex items-center gap-2 border-t border-white/10 pt-3.5 text-[12px]">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white font-mono text-[10px] font-semibold text-neutral-950">
                      S
                    </span>
                    <p className="truncate text-neutral-400">
                      <span className="font-medium text-neutral-200">Welcome, Sara</span>
                      <span className="mx-2 text-neutral-600">·</span>delivered via your domain
                    </p>
                    <span className="ml-auto hidden shrink-0 font-mono text-[10.5px] text-neutral-500 sm:block">
                      DKIM signed
                    </span>
                  </div>
                </div>
              )}

              {preview === "read" && (
                <div className="p-4 sm:p-5" aria-label="Webmail example">
                  <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50/70 px-3 py-2 text-[13px] text-neutral-400">
                    <Search className="h-3.5 w-3.5" aria-hidden="true" />
                    Search mail…
                  </div>
                  <ul className="mt-3 divide-y divide-neutral-100 rounded-xl border border-neutral-200">
                    {INBOX_ROWS.map((m) => (
                      <li key={m.subject} className="flex items-center gap-3 px-4 py-3">
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-neutral-950 font-mono text-[10px] font-semibold text-white">
                          {m.from[0].toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium text-neutral-900">
                            {m.subject}
                          </span>
                          <span className="block truncate font-mono text-[11px] text-neutral-400">
                            {m.from}
                          </span>
                        </span>
                        <span className="hidden shrink-0 font-mono text-[11px] text-neutral-400 sm:block">
                          {m.time}
                        </span>
                        <Star
                          className={`h-3.5 w-3.5 shrink-0 ${m.starred ? "fill-neutral-950 text-neutral-950" : "text-neutral-300"}`}
                          aria-hidden="true"
                        />
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-center font-mono text-[11px] text-neutral-400">
                    team@yourapp.com · inbox · sent · search · reply
                  </p>
                </div>
              )}
            </div>
            <p className="mt-4 text-center font-mono text-[11px] tracking-tight text-neutral-400">
              Illustrated with example data.
            </p>
          </Reveal>

          <Reveal delay={60}>
            <dl className="mx-auto mt-10 flex max-w-4xl flex-wrap items-center justify-center gap-x-6 gap-y-2 border-t border-neutral-200 pt-8" aria-label="Included capabilities">
              {STACK.map((s) => (
                <dd key={s} className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-neutral-400">
                  {s}
                </dd>
              ))}
            </dl>
          </Reveal>
        </div>
      </section>

      
      <section id="product" className="scroll-mt-20 border-b border-neutral-200" aria-labelledby="product-h">
        <div className="mx-auto max-w-6xl px-5 py-20 md:px-8 md:py-28">
          <div id="product-h">
            <SectionHead
              index="02"
              label="Product"
              title="Everything needed to run email. Nothing else."
              body="Six parts that work together — the pieces required to receive mail, store it, read it, and send it from code."
            />
          </div>

          <div className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-200 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <Reveal key={f.title} delay={Math.min(i * 60, 240)} className="h-full">
                <article className="group h-full bg-white p-6 transition-colors hover:bg-neutral-50 md:p-7">
                  <span className="grid h-9 w-9 place-items-center rounded-lg border border-neutral-200 bg-white text-neutral-800 shadow-[0_1px_2px_rgb(0_0_0/0.05)] transition-colors group-hover:border-neutral-950 group-hover:text-neutral-950">
                    <f.icon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                  </span>
                  <h3 className="mt-4 text-[15px] font-semibold tracking-tight text-neutral-950">
                    {f.title}
                  </h3>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-neutral-500">{f.body}</p>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      
      <section
        id="how-it-works"
        className="scroll-mt-20 border-b border-neutral-200 bg-neutral-50/60"
        aria-labelledby="method-h"
      >
        <div className="mx-auto max-w-6xl px-5 py-20 md:px-8 md:py-28">
          <div id="method-h">
            <SectionHead
              index="03"
              label="Setup"
              title="Domain to sending in three steps."
              body="Add records at your DNS provider, verify them, then send. Most of the wait is DNS propagation."
            />
          </div>

          <ol className="mt-10 grid gap-4 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <Reveal key={s.t} delay={i * 80}>
                <li className="relative h-full rounded-2xl border border-neutral-200 bg-white p-6 md:p-7">
                  <span className="font-mono text-[12px] font-medium tracking-widest text-neutral-400">
                    {s.n}
                  </span>
                  <h3 className="mt-3 text-[16px] font-semibold tracking-tight text-neutral-950">
                    {s.t}
                  </h3>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-neutral-500">{s.d}</p>
                </li>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      
      <section id="api" className="scroll-mt-20 border-b border-neutral-200" aria-labelledby="api-h">
        <div className="mx-auto max-w-6xl px-5 py-20 md:px-8 md:py-28">
          <div id="api-h">
            <SectionHead
              index="04"
              label="API"
              title="One endpoint to send mail."
              body="Authenticate with a scoped API key. Send a raw subject and body — or a stored template with variables."
            />
          </div>

          <div className="mt-10 grid items-start gap-6 lg:grid-cols-[1fr_1.15fr]">
            <Reveal>
              <div className="overflow-hidden rounded-2xl border border-neutral-200">
                {[
                  ["POST /v1/send", "Subject/body or template + vars"],
                  ["Scopes", "send · templates · live stream"],
                  ["Webhooks", "received · sent · bounced"],
                ].map(([t, d]) => (
                  <div
                    key={t}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-neutral-100 px-4 py-4 last:border-0 sm:px-5"
                  >
                    <span className="font-mono text-[13px] font-medium text-neutral-900">{t}</span>
                    <span className="text-right text-[13px] text-neutral-500">{d}</span>
                  </div>
                ))}
                <div className="border-t border-neutral-200 bg-neutral-50 px-5 py-4">
                  <button
                    onClick={() => onAuth("signup")}
                    className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-neutral-950 hover:underline"
                  >
                    Create a key in the dashboard <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </Reveal>

            <Reveal delay={100}>
              <div className="overflow-hidden rounded-2xl border border-neutral-900 bg-neutral-950 shadow-[0_24px_60px_-24px_rgb(0_0_0/0.4)]">
                <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
                  <div className="flex gap-1" role="tablist" aria-label="Code language">
                    {TABS.map((t) => (
                      <button
                        key={t}
                        role="tab"
                        aria-selected={tab === t}
                        onClick={() => setTab(t)}
                        className={`rounded-md px-3 py-1.5 font-mono text-[12px] transition-colors ${
                          tab === t ? "bg-white text-neutral-950" : "text-neutral-500 hover:text-white"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={copyCode}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] text-neutral-400 transition-colors hover:text-white"
                    aria-label="Copy code snippet"
                  >
                    {copied ? <Check className="h-3 w-3" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className="overflow-x-auto p-4 font-mono text-[11.5px] leading-relaxed text-neutral-200 sm:p-5 sm:text-[12.5px]">
                  <code>{SNIPPETS[tab]}</code>
                </pre>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      
      <section
        id="hosting"
        className="scroll-mt-20 border-b border-neutral-200 bg-neutral-50/60"
        aria-labelledby="host-h"
      >
        <div className="mx-auto max-w-6xl px-5 py-20 md:px-8 md:py-28">
          <div id="host-h">
            <SectionHead
              index="05"
              label="Hosting"
              title="Your server, or ours."
              body="Same code both ways. Start on cloud, export to your own server when ready."
            />
          </div>

          <div className="mt-10 grid gap-4 md:grid-cols-2">
            <Reveal>
              <div className="h-full rounded-2xl bg-neutral-950 p-7 text-white md:p-8">
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-neutral-500">
                  Self-host
                </p>
                <h3 className="mt-2 text-[20px] font-semibold tracking-tight">Run it yourself</h3>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-neutral-400">
                  Your server, your data. No limits in code.
                </p>
                <ul className="mt-6 space-y-2.5 text-[13.5px] text-neutral-200">
                  {[
                    "Unlimited domains and mailboxes",
                    "Storage limited by your disk",
                    "You manage port 25 and DNS",
                    "Export and import included",
                  ].map((t) => (
                    <li key={t} className="flex items-start gap-2.5">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-white" strokeWidth={2.5} aria-hidden="true" />
                      {t}
                    </li>
                  ))}
                </ul>
                <a
                  href="https://github.com/lukaulcar/mailer-go"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-7 inline-flex h-10 items-center rounded-full bg-white px-5 text-[13.5px] font-semibold text-neutral-950 transition-colors hover:bg-neutral-200"
                >
                  View source
                </a>
              </div>
            </Reveal>

            <Reveal delay={100}>
              <div className="h-full rounded-2xl border border-neutral-200 bg-white p-7 md:p-8">
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-neutral-400">
                  Cloud
                </p>
                <h3 className="mt-2 text-[20px] font-semibold tracking-tight text-neutral-950">Hosted free tier</h3>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-neutral-500">
                  For testing and small projects.
                </p>
                <ul className="mt-6 space-y-2.5 text-[13.5px] text-neutral-700">
                  {[
                    "1 domain",
                    "5 mailboxes, 100 MB each",
                    "Templates, keys and webhooks",
                    "Signup requires admin approval",
                  ].map((t) => (
                    <li key={t} className="flex items-start gap-2.5">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-neutral-950" strokeWidth={2.5} aria-hidden="true" />
                      {t}
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() => onAuth("signup")}
                  className="mt-7 inline-flex h-10 items-center rounded-full bg-neutral-950 px-5 text-[13.5px] font-semibold text-white transition-colors hover:bg-neutral-800"
                >
                  Create free account
                </button>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      
      <section id="faq" className="scroll-mt-20 border-b border-neutral-200" aria-labelledby="faq-h">
        <div className="mx-auto max-w-3xl px-5 py-20 md:py-28">
          <div className="text-center" id="faq-h">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-neutral-400">
              06 — FAQ
            </p>
            <h2 className="mt-3 text-balance text-[28px] font-semibold tracking-[-0.03em] text-neutral-950 md:text-[36px]">
              Questions, answered plainly.
            </h2>
          </div>
          <div className="mt-10 divide-y divide-neutral-200 border-y border-neutral-200">
            {FAQ.map(([q, a], i) => {
              const isOpen = openFaq === i;
              return (
                <div key={q}>
                  <h3>
                    <button
                      onClick={() => setOpenFaq(isOpen ? null : i)}
                      aria-expanded={isOpen}
                      aria-controls={`faq-panel-${i}`}
                      className="flex w-full items-center justify-between gap-4 py-5 text-left"
                    >
                      <span className="text-[15px] font-medium text-neutral-950">{q}</span>
                      <Plus
                        className={`h-4 w-4 shrink-0 text-neutral-400 transition-transform duration-200 ${
                          isOpen ? "rotate-45" : ""
                        }`}
                        aria-hidden="true"
                      />
                    </button>
                  </h3>
                  <div id={`faq-panel-${i}`} className={`faq-answer ${isOpen ? "open" : ""}`}>
                    <div>
                      <p className="max-w-2xl pb-6 pr-8 text-[14px] leading-relaxed text-neutral-500">
                        {a}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      
      <section className="border-b border-neutral-200" aria-labelledby="cta-h">
        <div className="mx-auto max-w-6xl px-5 py-20 md:px-8 md:py-28">
          <Reveal>
            <div className="rounded-3xl bg-neutral-950 px-6 py-14 text-center text-white md:py-20">
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-neutral-500">
                MIT licensed · Self-hostable
              </p>
              <h2
                id="cta-h"
                className="mx-auto mt-3 max-w-lg text-balance text-[30px] font-semibold leading-[1.08] tracking-[-0.032em] md:text-[44px]"
              >
                Own your inbox<span className="font-accent text-neutral-300">.</span>
              </h2>
              <p className="mx-auto mt-3 max-w-md text-[14.5px] leading-relaxed text-neutral-400">
                Add a domain, verify DNS, create a mailbox, send with one request.
              </p>
              <div className="mt-8 flex flex-col justify-center gap-2.5 sm:flex-row">
                <button
                  onClick={() => onAuth("signup")}
                  className="h-11 rounded-full bg-white px-7 text-[14px] font-semibold text-neutral-950 transition-colors hover:bg-neutral-200"
                >
                  Get started free
                </button>
                <a
                  href="#how-it-works"
                  className="inline-flex h-11 items-center justify-center rounded-full border border-white/25 px-7 text-[14px] font-medium text-white transition-colors hover:border-white/60"
                >
                  How it works
                </a>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </main>
  );
}
