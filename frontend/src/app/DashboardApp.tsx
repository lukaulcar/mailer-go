import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Check, HelpCircle, Shield } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useMailbox } from "../lib/mailboxAuth";
import { useConfirm } from "../lib/confirm";
import { navigate, useRoute } from "../lib/router";
import { Mark } from "../components/Header";
import ApiKeysPanel from "../components/ApiKeys";
import TemplateStudio from "../components/TemplateStudio";
import TemplatesTab from "../components/TemplatesTab";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CopyButton,
  EmptyState,
  ErrorBox,
  Modal,
  StatusDot,
} from "../components/ui";
import { PencilIcon, TrashIcon } from "../components/icons";
import { fieldCls, labelCls } from "../lib/utils";
import { notify } from "../lib/toast";
import {
  api,
  effectiveQuotaMb,
  getErrorMessage,
  buildRecords,
  CHECK_COOLDOWN_S,
  DEFAULT_MX_HOST,
  formatMailboxStorage,
  randomPassword,
  subscribeToLiveEvents,
} from "../lib/api";
import type {
  DnsRecord,
  DnsStatus,
  Domain,
  Mailbox,
  MailboxKind,
  MailTemplate,
  MXServer,
} from "../lib/api";

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})+$/i;

const MENU_ITEM_CLS =
  "w-full px-4 py-2.5 text-left text-[13px] font-medium text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-neutral-900";

const MX_MODE_OPTIONS = [
  { mode: "default" as const, title: "MailerGo default", sub: DEFAULT_MX_HOST, body: "We receive and store everything." },
  { mode: "custom" as const, title: "My own servers", sub: "self-hosted MX", body: "You run SMTP — we route to it." },
];

function PrimaryButton({ children, onClick, type, disabled, large }: { children: ReactNode; onClick?: () => void; type?: "submit" | "button"; disabled?: boolean; large?: boolean }) {
  return (
    <Button type={type} onClick={onClick} disabled={disabled} size={large ? "lg" : "md"}>
      {children}
    </Button>
  );
}

function SoftButton({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <Button variant="secondary" onClick={onClick} size="md">
      {children}
    </Button>
  );
}

function StatusPill({ status }: { status: Domain["status"] }) {
  return (
    <Badge tone={status === "verified" ? "dark" : "neutral"}>
      <StatusDot ok={status === "verified"} /> {status === "verified" ? "Active" : "Pending DNS"}
    </Badge>
  );
}

function SettingCard({ title, body, action, children, wide }: { title: string; body?: string; action?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <Card className={wide ? "xl:col-span-2" : undefined}>
      <CardHeader title={title} description={body} actions={action} />
      <div className="px-5 py-4">{children}</div>
    </Card>
  );
}

function DnsStatusDot({ status }: { status: DnsStatus }) {
  if (status === "ok")
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1 text-[11px] font-bold text-white">
        <Check className="h-3 w-3 stroke-[3]" /> Pass
      </span>
    );
  if (status === "fail")
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-red-600 px-3 py-1 text-[11px] font-bold text-white">
        Missing / wrong
      </span>
    );
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-neutral-100 px-3 py-1 text-[11px] font-bold text-neutral-500">
      Not checked
    </span>
  );
}

function DnsRecordRow({ record, notCheckedYet }: { record: DnsRecord; notCheckedYet?: boolean }) {
  const isPending = notCheckedYet || record.status === "pending" || !record.status;
  const failed = !isPending && record.status === "fail";
  const passed = !isPending && record.status === "ok";

  const isMx = record.kind === "MX";

  return (
    <div
      className={`rounded-xl border p-5 transition-colors ${
        passed
          ? "border-emerald-200 bg-emerald-50/70"
          : failed
            ? "border-red-200 bg-red-50/70"
            : "border-neutral-200 bg-white"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-lg px-2.5 py-1 font-mono text-[11px] font-bold tracking-wide text-white transition-colors ${
              passed ? "bg-emerald-700" : failed ? "bg-red-600" : "bg-neutral-900"
            }`}
          >
            {isMx ? "MX" : "TXT"}
          </span>
          <span className="rounded-md border border-neutral-200 bg-neutral-100 px-2 py-0.5 font-mono text-[11px] font-semibold text-neutral-700">
            {record.kind}
          </span>
        </div>
        <DnsStatusDot status={isPending ? "pending" : record.status} />
      </div>

      <div className="mt-3.5 space-y-2.5">
        <div
          className={`flex items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 ${
            passed ? "border-emerald-100 bg-white" : failed ? "border-red-100 bg-white" : "border-neutral-200 bg-neutral-50"
          }`}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[11px] font-bold uppercase tracking-wider text-neutral-400">Host / Name</span>
            <code className="min-w-0 break-all font-mono text-[13px] font-semibold text-neutral-900">{record.host}</code>
          </div>
          <CopyButton text={record.host} />
        </div>

        <div
          className={`flex items-start justify-between gap-3 rounded-lg border px-3.5 py-2.5 ${
            passed ? "border-emerald-100 bg-white" : failed ? "border-red-100 bg-white" : "border-neutral-200 bg-neutral-50"
          }`}
        >
          <div className="min-w-0 flex-1">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-neutral-400">Value / Target</span>
            <code className="mt-0.5 block min-w-0 break-all font-mono text-[12.5px] leading-relaxed text-neutral-900">{record.value}</code>
          </div>
          <CopyButton text={record.value} />
        </div>
      </div>

      {passed && (
        <p className="mt-3 flex items-center gap-1.5 text-[13px] font-medium leading-relaxed text-emerald-700">
          <Check className="h-4 w-4 stroke-[2.5]" /> Found — this record is correctly configured.
        </p>
      )}
      {failed && (
        <div className="mt-3 rounded-lg border border-neutral-200 bg-white p-3 text-[12.5px] leading-relaxed text-neutral-700 shadow-xs">
          <div className="flex items-center gap-1.5 font-semibold text-red-600">
            <svg className="h-4 w-4 shrink-0 text-red-600" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <span>Verification Issue</span>
          </div>
          <p className="mt-1 text-red-600">
            {record.error || "We couldn't verify this record. Copy the Host and Value above into your DNS zone, wait a minute, then click Verify DNS."}
          </p>
          {record.current_value && record.current_value !== "<none>" && (
            <div className="mt-2 rounded border border-neutral-200 bg-neutral-50 p-2 font-mono text-[11px] text-neutral-700">
              <span className="font-semibold text-neutral-500">DNS currently returned: </span>
              <span className="break-all">{record.current_value}</span>
            </div>
          )}
        </div>
      )}
      {isPending && (
        <div className="mt-2.5 space-y-1">
          <p className="text-[12.5px] text-neutral-400">
            Copy the Host and Value into your DNS zone, then click Verify DNS below.
          </p>
          {record.error && (
            <p className="font-mono text-[11px] text-amber-600/90">
              Note: {record.error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function formatZoneFile(records: DnsRecord[]): string {
  if (!records || records.length === 0) return "";
  return records
    .map((r) => {
      const host = r.host.endsWith(".") ? r.host : `${r.host}.`;
      if (r.kind === "MX") {
        const val = r.value.trim();
        const mxVal = /^\d+\s+/.test(val) ? val : `10 ${val}`;
        return `${host} 300 IN MX ${mxVal}`;
      }
      if (r.kind === "TXT") {
        return `${host} 300 IN TXT "${r.value.replace(/"/g, '\\"')}"`;
      }
      return `${host} 300 IN ${r.kind} ${r.value}`;
    })
    .join("\n");
}

function DnsGuideBox() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50/70 p-3 text-[12.5px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center justify-between text-left font-semibold text-neutral-800 hover:text-neutral-950"
      >
        <span className="flex items-center gap-2">
          <HelpCircle className="h-4 w-4 text-neutral-500 shrink-0" /> DNS Provider Quick Tips (Cloudflare, GoDaddy, Namecheap)
        </span>
        <span className="font-mono text-[11px] text-neutral-400">{open ? "Hide ▲" : "Show ▼"}</span>
      </button>
      {open && (
        <div className="mt-2.5 space-y-2 border-t border-neutral-200/60 pt-2.5 text-neutral-600">
          <p>
            <strong className="text-neutral-900">Cloudflare:</strong> Keep proxy status <em className="font-semibold text-amber-700">DNS Only</em> (grey cloud), not Proxied (orange cloud), or SMTP / MX mail exchange cannot route directly.
          </p>
          <p>
            <strong className="text-neutral-900">GoDaddy / Namecheap:</strong> If entering the root domain, enter <code className="rounded bg-neutral-200/70 px-1 py-0.5 font-mono text-[11.5px]">@</code> in the Host field instead of your full domain name. For DKIM enter <code className="rounded bg-neutral-200/70 px-1 py-0.5 font-mono text-[11.5px]">mailergo._domainkey</code>.
          </p>
          <p>
            <strong className="text-neutral-900">TTL / Propagation:</strong> DNS updates typically take 1–5 minutes. Set TTL to 300s (or &quot;Auto&quot;) for the fastest verification.
          </p>
        </div>
      )}
    </div>
  );
}

const WIZARD_STEPS = ["Domain", "Mail servers", "DNS & verify"];

const DOMAIN_WIZARD_STORAGE_KEY = "mailergo_domain_wizard_state";
const MAX_DRAFT_AGE_MS = 24 * 60 * 60 * 1000;

interface DomainWizardDraft {
  step: number;
  name: string;
  mxMode: "default" | "custom";
  servers: MXServer[];
  records: DnsRecord[];
  attempts: number;
  updatedAt: number;
}

function loadDomainWizardDraft(): DomainWizardDraft | null {
  try {
    const raw = sessionStorage.getItem(DOMAIN_WIZARD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.step === "number" && parsed.step >= 1 && parsed.step <= 3) {
      if (parsed.updatedAt && Date.now() - parsed.updatedAt > MAX_DRAFT_AGE_MS) {
        clearDomainWizardDraft();
        return null;
      }
      return parsed;
    }
  } catch {
  }
  return null;
}

function saveDomainWizardDraft(draft: DomainWizardDraft) {
  try {
    const serialized = JSON.stringify({
      ...draft,
      servers: draft.servers.map((s) => ({ ...s, secret1: "", secret2: "" })),
    });
    sessionStorage.setItem(DOMAIN_WIZARD_STORAGE_KEY, serialized);
  } catch {
  }
}

function clearDomainWizardDraft() {
  try {
    sessionStorage.removeItem(DOMAIN_WIZARD_STORAGE_KEY);
    localStorage.removeItem(DOMAIN_WIZARD_STORAGE_KEY);
  } catch {
  }
}

function StepTracker({ current }: { current: number }) {
  return (
    <div>
      <p className="font-mono text-[11.5px] font-medium tracking-[0.14em] text-neutral-400">
        STEP {current} OF {WIZARD_STEPS.length}
      </p>
      <ol className="mt-3 flex items-center gap-6 sm:gap-10" aria-label="Setup progress">
        {WIZARD_STEPS.map((label, i) => {
          const n = i + 1;
          const done = n < current;
          const active = n === current;
          return (
            <li key={label} className="flex items-center gap-2.5">
              <span
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[13px] font-bold transition-colors ${
                  done || active ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-400"
                }`}
                aria-hidden="true"
              >
                {done ? <Check className="h-3.5 w-3.5 stroke-[3]" /> : n}
              </span>
              <span className={`text-[13.5px] font-semibold ${active || done ? "text-neutral-900" : "text-neutral-400"}`}>
                {label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function AddDomainFlow({ existing, onDone, onExit }: { existing: Domain[]; onDone: (d: Domain) => void; onExit: () => void }) {
  const { user } = useAuth();
  const route = useRoute();

  const [draft] = useState<DomainWizardDraft | null>(() => loadDomainWizardDraft());
  const initialStep = route.wizardStep || draft?.step || 1;

  const [step, setStepState] = useState<number>(initialStep);
  const [name, setName] = useState<string>(draft?.name || "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [mxMode, setMxMode] = useState<"default" | "custom">(draft?.mxMode || "default");
  const [servers, setServers] = useState<MXServer[]>(
    draft?.servers && draft.servers.length > 0 ? draft.servers : [{ host: "", priority: "10", secret1: "", secret2: "" }]
  );
  const [mxError, setMxError] = useState<string | null>(null);
  const [records, setRecords] = useState<DnsRecord[]>(draft?.records || []);
  const [attempts, setAttempts] = useState<number>(draft?.attempts || 0);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setStep = useCallback((newStep: number) => {
    setStepState(newStep);
    navigate({ view: "dashboard", newDomain: true, wizardStep: newStep });
  }, []);

  useEffect(() => {
    saveDomainWizardDraft({
      step,
      name,
      mxMode,
      servers,
      records,
      attempts,
      updatedAt: Date.now(),
    });
  }, [step, name, mxMode, servers, records, attempts]);

  useEffect(() => {
    if (route.wizardStep && route.wizardStep !== step) {
      setStepState(route.wizardStep);
    }
  }, [route.wizardStep, step]);

  useEffect(() => {
    if (step === 3 && name && records.length === 0) {
      api.domains.verify(name).then((dns) => {
        if (dns && dns.length > 0) {
          const mapped = dns.map((r) => ({
            ...r,
            status: attempts === 0 && r.status !== "ok" ? ("pending" as DnsStatus) : r.status,
          }));
          setRecords(mapped);
        } else {
          setRecords(buildRecords(name, mxMode, servers));
        }
      }).catch(() => {
        setRecords(buildRecords(name, mxMode, servers));
      });
    }
  }, [step, name, records.length, mxMode, servers, attempts]);

  const passing = records.filter((r) => r.status === "ok").length;
  const allOk = records.length > 0 && passing === records.length;

  function submitName(e: FormEvent) {
    e.preventDefault();
    const clean = name.trim().toLowerCase();
    if (!DOMAIN_RE.test(clean)) return setNameError("That doesn't look like a domain — try yourapp.com.");
    if (existing.some((d) => d.name === clean)) return setNameError("That domain is already added.");
    if (user?.plan !== 1 && existing.length >= 1) return setNameError("Free plan limit reached: maximum 1 domain allowed. Admin accounts have unlimited domains.");
    setName(clean);
    setNameError(null);
    setStep(2);
    window.scrollTo({ top: 0 });
  }

  async function submitServers() {
    if (mxMode === "custom") {
      const filled = servers.filter((s) => s.host.trim());
      if (filled.length === 0) return setMxError("Add at least one mail server, or use the default.");
      for (const s of filled) {
        if (!DOMAIN_RE.test(s.host.trim())) return setMxError(`"${s.host}" is not a valid hostname.`);
        if (!s.secret1.trim() || !s.secret2.trim()) return setMxError("Each custom server needs both secrets.");
      }
    }
    setMxError(null);
    setBusy(true);
    try {
      const dom = await api.domains.create({
        name,
        mxMode,
        mxServers: mxMode === "custom" ? servers.filter((s) => s.host.trim()) : [],
        dns: buildRecords(name, mxMode, servers),
        lastCheck: Date.now(),
      });
      const recs = (dom.dns && dom.dns.length > 0 ? dom.dns : buildRecords(name, mxMode, servers)).map((r) => ({
        ...r,
        status: (r.status === "ok" ? "ok" : "pending") as DnsStatus,
      }));
      setRecords(recs);
      setAttempts(0);
      setStep(3);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setMxError(getErrorMessage(err, "Could not save domain."));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (checking || allOk) return;
    setChecking(true);
    setError(null);
    try {
      const dns = await api.domains.verify(name);
      setRecords(dns);
      setAttempts((a) => a + 1);
    } catch (err) {
      setError(getErrorMessage(err, "DNS verification check failed."));
    } finally {
      setChecking(false);
    }
  }

  function handleCancel() {
    clearDomainWizardDraft();
    onExit();
  }

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      const all = await api.domains.list();
      const found = all.find((d) => d.name.toLowerCase() === name.toLowerCase());
      if (found) {
        clearDomainWizardDraft();
        onDone(found);
      } else {
        clearDomainWizardDraft();
        onExit();
      }
    } catch (err) {
      setError(getErrorMessage(err, "Could not complete setup."));
    } finally {
      setBusy(false);
    }
  }

  function updateServer(i: number, patch: Partial<MXServer>) {
    setServers((ss) => ss.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  return (
    <div className="mx-auto max-w-2xl pb-10">
      <button onClick={handleCancel} className="text-[13px] font-semibold text-neutral-400 transition-colors hover:text-neutral-900">
        ← Cancel, back to domains
      </button>
      <h1 className="mt-4 text-[34px] font-semibold tracking-tight text-neutral-900 md:text-[42px]">
        Add a domain
      </h1>
      <p className="mt-2 text-[15px] text-neutral-500">
        Three quick steps. About ten minutes, most of it waiting on DNS.
      </p>

      <div className="mt-8">
        <StepTracker current={step} />
      </div>

      <div className="mt-10">
        {step === 1 && (
          <form onSubmit={submitName}>
            <h2 className="text-[24px] font-semibold tracking-tight text-neutral-900">What's your domain?</h2>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="yourapp.com"
              autoComplete="off"
              spellCheck={false}
              aria-label="Domain name"
              className={`${fieldCls} mt-6 font-mono`}
            />
            {nameError && (
              <div className="mt-3">
                <ErrorBox onDismiss={() => setNameError(null)}>{nameError}</ErrorBox>
              </div>
            )}
            <div className="mt-8 flex justify-end">
              <PrimaryButton type="submit" large>Continue →</PrimaryButton>
            </div>
          </form>
        )}

        {step === 2 && (
          <div>
            <h2 className="text-[24px] font-semibold tracking-tight text-neutral-900">Where should mail go?</h2>
            <div className="mt-6 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Mail server mode">
              {MX_MODE_OPTIONS.map((opt) => {
                const selectedMode = mxMode === opt.mode;
                return (
                  <button
                    key={opt.mode}
                    onClick={() => setMxMode(opt.mode)}
                    aria-pressed={selectedMode}
                    className={`rounded-xl border p-6 text-left transition-colors ${
                      selectedMode ? "border-neutral-900 bg-neutral-900/[0.03] text-neutral-900" : "border-neutral-200 bg-white text-neutral-900 hover:border-neutral-400"
                    }`}
                  >
                    <p className="text-[15.5px] font-bold">{opt.title}</p>
                    <p className="mt-0.5 font-mono text-[12px] text-neutral-500">{opt.sub}</p>
                    <p className="mt-2 text-[13px] leading-relaxed text-neutral-500">{opt.body}</p>
                  </button>
                );
              })}
            </div>

            {mxMode === "custom" && (
              <div className="mt-4 space-y-3">
                {servers.map((s, i) => (
                  <div key={i} className="rounded-xl border border-neutral-200 bg-white p-5 sm:p-6">
                    <div className="flex items-center justify-between">
                      <p className="font-mono text-[11px] font-bold tracking-[0.14em] text-neutral-400">SERVER {i + 1}</p>
                      {servers.length > 1 && (
                        <button onClick={() => setServers((ss) => ss.filter((_, idx) => idx !== i))} className="text-[12.5px] font-semibold text-neutral-400 hover:text-neutral-900">
                          Remove
                        </button>
                      )}
                    </div>
                    <div className="mt-3 grid gap-2.5 sm:grid-cols-[1fr_90px]">
                      <input value={s.host} onChange={(e) => updateServer(i, { host: e.target.value })} placeholder="mx1.yourserver.com" aria-label={`Server ${i + 1} hostname`} className={`${fieldCls} font-mono`} />
                      <input value={s.priority} onChange={(e) => updateServer(i, { priority: e.target.value })} placeholder="10" aria-label={`Server ${i + 1} priority`} className={fieldCls} />
                    </div>
                    <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
                      <input value={s.secret1} onChange={(e) => updateServer(i, { secret1: e.target.value })} placeholder="Secret 1" aria-label={`Server ${i + 1} secret 1`} type="password" className={`${fieldCls} font-mono`} />
                      <input value={s.secret2} onChange={(e) => updateServer(i, { secret2: e.target.value })} placeholder="Secret 2" aria-label={`Server ${i + 1} secret 2`} type="password" className={`${fieldCls} font-mono`} />
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => setServers((ss) => [...ss, { host: "", priority: "10", secret1: "", secret2: "" }])}
                  className="w-full py-3 text-[13.5px] font-semibold text-neutral-500 transition-colors hover:text-neutral-900"
                >
                  + Add another server
                </button>
              </div>
            )}

            {mxError && (
              <div className="mt-4">
                <ErrorBox onDismiss={() => setMxError(null)}>{mxError}</ErrorBox>
              </div>
            )}
            <div className="mt-8 flex items-center justify-between">
              <button onClick={() => setStep(1)} className="text-[13.5px] font-semibold text-neutral-400 hover:text-neutral-900">← Back</button>
              <PrimaryButton onClick={submitServers} large>Continue →</PrimaryButton>
            </div>
          </div>
        )}

        {step === 3 && !allOk && (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-[24px] font-semibold tracking-tight text-neutral-900">Add these records, then verify</h2>
                <p className="mt-1 max-w-xl text-[14.5px] leading-relaxed text-neutral-500">
                  Copy each row into your DNS zone, then hit <span className="font-bold text-neutral-900">Verify DNS</span>.
                </p>
              </div>
              {records.length > 0 && (
                <CopyButton
                  text={formatZoneFile(records)}
                  notifyMessage="Copied all DNS records (Zone file format)"
                />
              )}
            </div>
            <div className="mt-4">
              <DnsGuideBox />
            </div>
            <div className="mt-6 space-y-3 rounded-xl border border-neutral-200 bg-white p-3">
              {records.map((r, i) => (
                <DnsRecordRow key={`${r.kind}-${i}`} record={r} notCheckedYet={attempts === 0} />
              ))}
            </div>
            {error && (
              <div className="mt-4">
                <ErrorBox onDismiss={() => setError(null)}>{error}</ErrorBox>
              </div>
            )}
            <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
              <button onClick={() => setStep(2)} className="text-[13.5px] font-semibold text-neutral-400 hover:text-neutral-900">← Back</button>
              <div className="flex items-center gap-4">
                {attempts > 0 && (
                  <p className="font-mono text-[12px] tabular-nums text-neutral-400">{passing}/{records.length} passing</p>
                )}
                <PrimaryButton large onClick={verify} disabled={checking}>
                  {checking ? "Verifying…" : attempts === 0 ? "Verify DNS" : "Verify again"}
                </PrimaryButton>
              </div>
            </div>
          </div>
        )}

        {step === 3 && allOk && (
          <div className="py-8 text-center sm:py-14">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-neutral-900 text-white" aria-hidden="true">
              <Check className="h-8 w-8 stroke-[2.5]" />
            </div>
            <h2 className="mt-6 text-[32px] font-semibold tracking-tight text-neutral-900">{name} is live.</h2>
            <p className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-neutral-500">
              MX, SPF, DKIM, DMARC — everything verified.
            </p>
            {error && (
              <div className="mx-auto mt-4 max-w-md">
                <ErrorBox onDismiss={() => setError(null)}>{error}</ErrorBox>
              </div>
            )}
            <div className="mt-8 flex justify-center">
              <PrimaryButton large onClick={finish} disabled={busy}>{busy ? "Saving…" : "Open domain panel →"}</PrimaryButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MailboxesPanel({ domain, boxes, busy, loadError, onRefresh, onOpenTemplates, createOpen, onCreateOpenChange }: {
  domain: Domain;
  boxes: Mailbox[];
  busy: boolean;
  loadError?: string | null;
  onRefresh: () => void;
  onOpenTemplates: (address: string) => void;
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
}) {
  const { user } = useAuth();
  const { accounts, switchMailbox, openMailboxSession } = useMailbox();
  const [query, setQuery] = useState("");
  const [internalCreateOpen, setInternalCreateOpen] = useState(false);
  const isCreateOpen = createOpen !== undefined ? createOpen : internalCreateOpen;
  const setCreateModalOpen = (open: boolean) => {
    if (onCreateOpenChange) onCreateOpenChange(open);
    else setInternalCreateOpen(open);
    if (open) {
      setError(null);
      setLocal("");
      setPassword(randomPassword());
      setKind("standard");
    }
  };
  const [local, setLocal] = useState("");
  const [password, setPassword] = useState(randomPassword());
  const [kind, setKind] = useState<MailboxKind>("standard");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [pwFor, setPwFor] = useState<string | null>(null);
  const [newPw, setNewPw] = useState(randomPassword());
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSaving, setPwSaving] = useState(false);

  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [deleteFor, setDeleteFor] = useState<string | null>(null);
  const [deleteText, setDeleteText] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [quotaFor, setQuotaFor] = useState<string | null>(null);
  const [quotaMb, setQuotaMb] = useState("1024");
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [quotaSaving, setQuotaSaving] = useState(false);

  const [tplCounts, setTplCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    let live = true;
    void api.templates.listDomain(domain.name).then((all) => {
      if (!live) return;
      const counts: Record<string, number> = {};
      for (const t of all) counts[t.mailbox] = (counts[t.mailbox] ?? 0) + 1;
      setTplCounts(counts);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [domain.name, boxes]);

  const filtered = boxes.filter((b) =>
    b.address.toLowerCase().includes(query.toLowerCase()),
  );
  const catchAllCount = boxes.filter((b) => b.kind === "catch-all").length;
  const hasCatchAll = catchAllCount > 0;
  const CATCH_ALL_LOCAL = "catch-all";
  const catchAllAddressTaken = boxes.some((b) => b.address.toLowerCase() === `${CATCH_ALL_LOCAL}@${domain.name}`.toLowerCase());

  function pickKind(next: MailboxKind) {
    if (next === "catch-all") {
      setLocal(CATCH_ALL_LOCAL);
      setKind("catch-all");
    } else {
      if (local.trim().toLowerCase() === CATCH_ALL_LOCAL) setLocal("");
      setKind(next);
    }
  }

  async function submitCreate(e: FormEvent) {
    e.preventDefault();
    if (user?.plan === 0 && boxes.length >= 5) {
      setError("Free plan limit reached: maximum 5 mailboxes allowed per domain. Administrator accounts have unlimited mailboxes.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const effectiveLocal = kind === "catch-all" ? CATCH_ALL_LOCAL : local;
      await api.mailboxes.create(domain.name, effectiveLocal, password, kind);
      notify.success(`Mailbox ${effectiveLocal}@${domain.name} created`);
      setLocal("");
      setPassword(randomPassword());
      setKind("standard");
      setCreateModalOpen(false);
      onRefresh();
    } catch (err) {
      setError(getErrorMessage(err, "Could not create mailbox."));
    } finally {
      setSaving(false);
    }
  }

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    if (!pwFor) return;
    setPwSaving(true);
    setPwError(null);
    try {
      await api.mailboxes.setPassword(pwFor, newPw);
      notify.success(`Password updated for ${pwFor}`);
      setPwFor(null);
      onRefresh();
    } catch (err) {
      setPwError(getErrorMessage(err, "Could not set password."));
    } finally {
      setPwSaving(false);
    }
  }

  async function toggle(address: string, enabled: boolean) {
    setActionError(null);
    try {
      await api.mailboxes.setEnabled(address, !enabled);
      notify.success(enabled ? `Mailbox ${address} disabled — login, inbound and sending are now blocked` : `Mailbox ${address} enabled`);
      onRefresh();
    } catch (err) {
      setActionError(getErrorMessage(err, "Failed to update mailbox status."));
    } finally {
      setMenuFor(null);
    }
  }

  async function submitQuota(e: FormEvent) {
    e.preventDefault();
    if (!quotaFor) return;
    setQuotaSaving(true);
    setQuotaError(null);
    try {
      const v = quotaMb.trim().toLowerCase();
      let mb = 0;
      if (v === "" || v === "unlimited" || v === "0" || v === "inf" || v === "∞") {
        mb = 0;
      } else {
        mb = Number(v);
        if (!Number.isFinite(mb) || mb < 0) throw new Error("Enter 0 (unlimited) or a size in MB.");
      }
      await api.mailboxes.setQuota(quotaFor, mb);
      notify.success(mb === 0 ? `Mailbox ${quotaFor} now has unlimited storage` : `Mailbox ${quotaFor} storage set to ${mb} MB`);
      setQuotaFor(null);
      onRefresh();
    } catch (err) {
      setQuotaError(getErrorMessage(err, "Could not set storage quota."));
    } finally {
      setQuotaSaving(false);
    }
  }

  async function switchKind(address: string, next: MailboxKind) {
    setActionError(null);
    try {
      await api.mailboxes.setKind(address, next);
      onRefresh();
    } catch (err) {
      setActionError(getErrorMessage(err, "Failed to update mailbox routing type."));
    } finally {
      setMenuFor(null);
    }
  }

  function openInboxDirect(m: Mailbox) {
    if (accounts.some((a) => a.address.toLowerCase() === m.address.toLowerCase())) {
      switchMailbox(m.address);
    } else {
      openMailboxSession(m);
    }
    setMenuFor(null);
    navigate({ view: "mail", folder: "inbox", messageId: null, account: m.address });
  }

  async function confirmDelete() {
    if (!deleteFor || deleteText !== "DELETE" || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.mailboxes.remove(deleteFor);
      notify.success(`Mailbox ${deleteFor} deleted`);
      setDeleteFor(null);
      setDeleteText("");
      setDeleteError(null);
      setMenuFor(null);
      onRefresh();
    } catch (err) {
      setDeleteError(getErrorMessage(err, "Failed to delete mailbox."));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      {actionError && (
        <div className="mb-4">
          <ErrorBox onDismiss={() => setActionError(null)}>{actionError}</ErrorBox>
        </div>
      )}
      {loadError && (
        <div className="mb-4">
          <ErrorBox>{loadError}</ErrorBox>
        </div>
      )}
      {(boxes.length > 3 || query) && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search mailboxes…"
          aria-label="Search mailboxes"
          className="mt-4 w-full max-w-xs rounded-md border border-neutral-200 bg-white px-4 py-2 text-[13px] focus:border-neutral-900 focus:outline-none"
        />
      )}

      {busy ? (
        <p className="mt-6 rounded-lg border border-neutral-200 bg-white px-5 py-10 text-center text-[13.5px] text-neutral-500">Loading mailboxes…</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={boxes.length === 0 ? `No mailboxes on ${domain.name} yet` : "No matches"}
          body={boxes.length === 0 ? "hello@ for people, no-reply@ (send-only) for notifications, catch-all@ for everything else — each logs in with email + password." : "Try a different search or filter."}
        />
      ) : (
        <ul className="mt-4 space-y-2">
          {filtered.map((m) => {
            const sendOnly = m.kind === "send-only";
            const isCatchAll = m.kind === "catch-all";
            const kindLabel = sendOnly ? "Send-only" : isCatchAll ? "Catch-all" : "Standard";
            const isPremium = user?.plan === 1 || m.plan === 1;
            const storage = formatMailboxStorage(m.usedMb, effectiveQuotaMb(m, isPremium));
            const isCatchAllAddress = m.address.split("@")[0]?.toLowerCase() === CATCH_ALL_LOCAL;
            return (
            <li key={m.address} className={`rounded-lg border bg-white px-4 py-4 transition-colors hover:bg-neutral-50 ${isCatchAll ? "border-neutral-900" : "border-neutral-200"} ${m.enabled ? "" : "opacity-70"}`}>
              <div className="flex flex-wrap items-center gap-3">
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-[14px] font-bold ${m.enabled ? "bg-neutral-900 text-white" : "bg-neutral-200 text-neutral-400"}`} aria-hidden="true">
                  {m.address.charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1 basis-48">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="flex items-center gap-1.5 truncate font-mono text-[13.5px] font-medium text-neutral-900">
                      <span className="truncate">{m.address}</span>
                      <CopyButton text={m.address} notifyMessage={`Copied ${m.address}`} />
                    </p>
                    <span className={`inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[10.5px] font-bold ${(sendOnly || isCatchAll) ? "bg-neutral-900 text-white" : "border border-neutral-200 bg-neutral-50 text-neutral-700"}`}>
                      {kindLabel}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px] text-neutral-500">
                    {m.passwordSet ? "Password set" : "No password yet"}
                    {!m.enabled && " · disabled"}
                    {!sendOnly && (
                      <span className="ml-2 font-mono tabular-nums">
                        {storage.display}
                      </span>
                    )}
                  </p>
                  {!sendOnly ? (
                    <>
                      {!storage.isUnlimited && (
                        <div className="mt-1.5 h-1 w-44 overflow-hidden rounded-full bg-neutral-200" aria-hidden="true">
                          <div
                            className="h-full rounded-full bg-neutral-900"
                            style={{ width: `${storage.pct}%` }}
                          />
                        </div>
                      )}
                      {isCatchAll && (
                        <p className="mt-1 text-[12px] text-neutral-500">Receives mail to any unregistered @{m.domain} address.</p>
                      )}
                    </>
                  ) : (
                    <p className="mt-1 text-[12px] text-neutral-500">Incoming mail is discarded — nothing stored.</p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => openInboxDirect(m)}
                    className="rounded-md bg-neutral-900 px-3.5 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-neutral-700"
                  >
                    Open inbox →
                  </button>
                  <button
                    onClick={() => onOpenTemplates(m.address)}
                    className="rounded-md border border-neutral-200 bg-white px-3.5 py-1.5 text-[12px] font-semibold text-neutral-700 transition-colors hover:border-neutral-400 hover:text-neutral-900"
                  >
                    Templates{tplCounts[m.address] ? ` (${tplCounts[m.address]})` : ""}
                  </button>
                  <div className="relative">
                    <button
                      onClick={() => setMenuFor((cur) => (cur === m.address ? null : m.address))}
                      aria-haspopup="menu"
                      aria-expanded={menuFor === m.address}
                      aria-label={`Edit ${m.address}`}
                      title={`Edit ${m.address}`}
                      className="grid h-8 w-8 place-items-center rounded-md border border-neutral-200 bg-white text-neutral-700 transition-colors hover:border-neutral-400 hover:text-neutral-900"
                    >
                      <PencilIcon size={15} aria-hidden />
                    </button>
                    {menuFor === m.address && (
                      <>
                        <button aria-label="Close menu" className="fixed inset-0 z-10 cursor-default" onClick={() => setMenuFor(null)} />
                        <div role="menu" aria-label={`Mailbox actions for ${m.address}`} className="absolute right-0 top-9 z-20 w-52 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1.5 shadow-xl">
                          {isCatchAll || sendOnly ? (
                            <button
                              role="menuitem"
                              onClick={() => switchKind(m.address, "standard")}
                              title={isCatchAll ? "Convert to standard inbox (stops catching unregistered addresses)" : "Convert to standard inbox"}
                              className={MENU_ITEM_CLS}
                            >
                              Make standard
                            </button>
                          ) : (
                            <>
                              <button
                                role="menuitem"
                                onClick={() => switchKind(m.address, "send-only")}
                                title="Convert to send-only"
                                className={MENU_ITEM_CLS}
                              >
                                Make send-only
                              </button>
                              {isCatchAllAddress && !hasCatchAll && (
                                <button
                                  role="menuitem"
                                  onClick={() => switchKind(m.address, "catch-all")}
                                  title="Promote catch-all@ to catch unregistered addresses"
                                  className={MENU_ITEM_CLS}
                                >
                                  Make catch-all
                                </button>
                              )}
                            </>
                          )}
                          <button
                            role="menuitem"
                            onClick={() => { setPwError(null); setNewPw(randomPassword()); setPwFor(m.address); setMenuFor(null); }}
                            className={MENU_ITEM_CLS}
                          >
                            {m.passwordSet ? "Reset password" : "Set password"}
                          </button>
                          <button
                            role="menuitem"
                            onClick={() => toggle(m.address, m.enabled)}
                            className={MENU_ITEM_CLS}
                          >
                            {m.enabled ? "Disable" : "Enable"}
                          </button>
                          {isPremium ? (
                            <button
                              role="menuitem"
                              onClick={() => {
                                const cur = m.quota_bytes ? Math.round(m.quota_bytes / (1024 * 1024)) : (m.quotaMb ?? 0);
                                setQuotaMb(cur > 0 ? String(cur) : "0");
                                setQuotaError(null);
                                setQuotaFor(m.address);
                                setMenuFor(null);
                              }}
                              title="Set per-mailbox storage quota in MB (0 = unlimited)"
                              className={MENU_ITEM_CLS}
                            >
                              Set storage…
                            </button>
                          ) : (
                            <div className="px-4 py-2.5 text-[12px] leading-relaxed text-neutral-400" title="Free plan storage is fixed at 100 MB per mailbox">
                              Storage: 100 MB (fixed on free plan)
                            </div>
                          )}
                          <div className="my-1.5 border-t border-neutral-100" />
                          <button
                            role="menuitem"
                            onClick={() => { setDeleteText(""); setDeleteFor(m.address); setMenuFor(null); }}
                            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] font-bold text-red-600 transition-colors hover:bg-red-50 hover:text-red-700"
                          >
                            <TrashIcon strokeWidth={1.7} linejoin aria-hidden />
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </li>
            );
          })}
        </ul>
      )}

      {isCreateOpen && (
        <Modal title={`New mailbox @${domain.name}`} subtitle="It logs in with its full email + this password." onClose={() => setCreateModalOpen(false)}>
          <form onSubmit={submitCreate} className="space-y-4">
            <div>
              <label htmlFor="mbox-local" className={labelCls}>Address</label>
              <div className="flex gap-2">
                <input
                  id="mbox-local"
                  autoFocus={kind !== "catch-all"}
                  value={kind === "catch-all" ? CATCH_ALL_LOCAL : local}
                  onChange={(e) => setLocal(e.target.value)}
                  placeholder="hello"
                  disabled={kind === "catch-all"}
                  aria-disabled={kind === "catch-all"}
                  title={kind === "catch-all" ? "Catch-all address is fixed" : undefined}
                  className={`${fieldCls} font-mono ${kind === "catch-all" ? "cursor-not-allowed bg-neutral-50 text-neutral-500" : ""}`}
                />
                <span className="grid shrink-0 place-items-center rounded-lg border border-neutral-200 bg-neutral-50 px-3 font-mono text-[12.5px] text-neutral-500">@{domain.name}</span>
              </div>
              {kind === "catch-all" && (
                <p className="mt-1.5 text-[12px] text-neutral-500">Fixed address — this mailbox is always <span className="font-mono font-semibold text-neutral-700">{CATCH_ALL_LOCAL}@{domain.name}</span>.</p>
              )}
            </div>
            <div>
              <span className={labelCls}>Type</span>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Mailbox type">
                {(
                  [
                    { id: "standard" as MailboxKind, title: "Standard", body: "Sends + receives. Mail is stored.", disabled: false, why: undefined as string | undefined },
                    { id: "send-only" as MailboxKind, title: "Send-only", body: "e.g. no-reply. Incoming mail discarded.", disabled: false, why: undefined as string | undefined },
                    {
                      id: "catch-all" as MailboxKind,
                      title: "Catch-all",
                      body: hasCatchAll ? "Taken — one per domain." : catchAllAddressTaken ? "catch-all@ exists — promote it." : "Fixed as catch-all@. Catches unregistered mail.",
                      disabled: hasCatchAll || catchAllAddressTaken,
                      why: hasCatchAll ? "This domain already has a catch-all mailbox" : catchAllAddressTaken ? "An address named catch-all@ already exists — promote it from the list instead" : undefined,
                    },
                  ]
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => !opt.disabled && pickKind(opt.id)}
                    disabled={opt.disabled}
                    aria-pressed={kind === opt.id}
                    title={opt.why}
                    className={`rounded-lg border p-4 text-left transition-colors ${opt.disabled ? "cursor-not-allowed opacity-50" : ""} ${kind === opt.id ? "border-neutral-900 bg-neutral-900/[0.03]" : "border-neutral-200 bg-white hover:border-neutral-400"}`}
                  >
                    <p className="text-[13.5px] font-bold text-neutral-900">{opt.title}</p>
                    <p className="mt-1 text-[12px] leading-relaxed text-neutral-500">{opt.body}</p>
                  </button>
                ))}
              </div>
              {kind === "catch-all" && (
                <p className="mt-2 text-[12px] leading-relaxed text-neutral-500">One per domain. Mail to unknown @{domain.name} addresses lands here, alongside its own mail.</p>
              )}
            </div>
            <div>
              <span className={labelCls}>Password</span>
              <div className="flex gap-2">
                <input value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Mailbox password" className={`${fieldCls} font-mono`} />
                <button type="button" onClick={() => setPassword(randomPassword())} className="shrink-0 rounded-lg border border-neutral-200 bg-white px-3.5 text-[12.5px] font-semibold text-neutral-700 hover:border-neutral-400">
                  Generate
                </button>
                <CopyButton text={password} notifyMessage="Copied generated password" />
              </div>
              <p className="mt-1.5 text-[12px] text-neutral-500">Min. 8 characters. The owner types email + password to read and send mail.</p>
            </div>
            {error && <ErrorBox onDismiss={() => setError(null)}>{error}</ErrorBox>}
            <div className="flex justify-end gap-2">
              <SoftButton onClick={() => setCreateModalOpen(false)}>Cancel</SoftButton>
              <PrimaryButton type="submit" disabled={saving}>{saving ? "Creating…" : "Create mailbox"}</PrimaryButton>
            </div>
          </form>
        </Modal>
      )}

      {pwFor && (
        <Modal title="Set password" subtitle={`${pwFor} will log in with this password.`} onClose={() => setPwFor(null)}>
          <form onSubmit={submitPassword} className="space-y-4">
            <div className="flex gap-2">
              <input autoFocus value={newPw} onChange={(e) => setNewPw(e.target.value)} aria-label="New password" className={`${fieldCls} font-mono`} />
              <button type="button" onClick={() => setNewPw(randomPassword())} className="shrink-0 rounded-lg border border-neutral-200 bg-white px-3.5 text-[12.5px] font-semibold text-neutral-700 hover:border-neutral-400">
                Generate
              </button>
              <CopyButton text={newPw} notifyMessage="Copied generated password" />
            </div>
            {pwError && <ErrorBox onDismiss={() => setPwError(null)}>{pwError}</ErrorBox>}
            <div className="flex justify-end gap-2">
              <SoftButton onClick={() => setPwFor(null)}>Cancel</SoftButton>
              <PrimaryButton type="submit" disabled={pwSaving}>{pwSaving ? "Saving…" : "Save password"}</PrimaryButton>
            </div>
          </form>
        </Modal>
      )}

      {quotaFor && (
        <Modal title="Mailbox storage" subtitle={`${quotaFor} — set a per-mailbox quota.`} onClose={() => setQuotaFor(null)}>
          <form onSubmit={submitQuota} className="space-y-4">
            <div>
              <label htmlFor="mbox-quota" className={labelCls}>Quota (MB, 0 = unlimited)</label>
              <input
                id="mbox-quota"
                autoFocus
                value={quotaMb}
                onChange={(e) => setQuotaMb(e.target.value)}
                placeholder="0"
                inputMode="decimal"
                aria-label="Storage quota in MB"
                className={`${fieldCls} font-mono`}
              />
              <p className="mt-1.5 text-[12px] text-neutral-500">Paid plans only — free plan mailboxes are fixed at 100 MB each. Min 1 MB when limited, max 50 GB.</p>
            </div>
            {quotaError && <ErrorBox onDismiss={() => setQuotaError(null)}>{quotaError}</ErrorBox>}
            <div className="flex justify-end gap-2">
              <SoftButton onClick={() => setQuotaFor(null)}>Cancel</SoftButton>
              <PrimaryButton type="submit" disabled={quotaSaving}>{quotaSaving ? "Saving…" : "Save quota"}</PrimaryButton>
            </div>
          </form>
        </Modal>
      )}

      {deleteFor && (
        <Modal title="Delete mailbox" subtitle={`${deleteFor} and all of its mail will be permanently removed.`} onClose={() => { setDeleteFor(null); setDeleteText(""); setDeleteError(null); }}>
          <div className="space-y-4">
            <p className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-[13px] font-medium leading-relaxed text-red-600 shadow-xs">
              This can't be undone. Type <span className="font-mono font-bold">DELETE</span> below to confirm.
            </p>
            <div>
              <label htmlFor="mbox-delete-confirm" className={labelCls}>
                Type DELETE to confirm
              </label>
              <input
                id="mbox-delete-confirm"
                autoFocus
                value={deleteText}
                onChange={(e) => setDeleteText(e.target.value)}
                placeholder="DELETE"
                autoComplete="off"
                spellCheck={false}
                aria-label="Type DELETE to confirm deletion"
                className={`${fieldCls} font-mono`}
              />
            </div>
            {deleteError && <ErrorBox onDismiss={() => setDeleteError(null)}>{deleteError}</ErrorBox>}
            <div className="flex justify-end gap-2">
              <SoftButton onClick={() => { setDeleteFor(null); setDeleteText(""); setDeleteError(null); }}>Cancel</SoftButton>
              <button
                onClick={confirmDelete}
                disabled={deleteText !== "DELETE" || deleting}
                className="inline-flex items-center gap-2 rounded-md bg-red-600 px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <TrashIcon strokeWidth={1.7} linejoin aria-hidden />
                {deleting ? "Deleting…" : "Delete mailbox"}
              </button>
            </div>
          </div>
        </Modal>
      )}

    </div>
  );
}


function SettingsPanel({ domain, boxes, onDomainChanged, onDeleted }: {
  domain: Domain;
  boxes: Mailbox[];
  onDomainChanged: () => void;
  onDeleted: () => void;
}) {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [dnsBusy, setDnsBusy] = useState(false);
  const [dnsError, setDnsError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const [mxMode, setMxMode] = useState<"default" | "custom">(domain.mxMode);
  const [servers, setServers] = useState<MXServer[]>(() =>
    domain.mxMode === "custom" && domain.mxServers.length > 0
      ? domain.mxServers.map((s) => ({ ...s }))
      : [{ host: "", priority: "10", secret1: "", secret2: "" }],
  );
  const [mxError, setMxError] = useState<string | null>(null);
  const [mxSaving, setMxSaving] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!domain.lastCheck) return;
    const tick = () => {
      setCooldown(Math.max(0, CHECK_COOLDOWN_S - Math.floor((Date.now() - (domain.lastCheck as number)) / 1000)));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [domain.lastCheck]);

  const mxDirty =
    mxMode !== domain.mxMode ||
    JSON.stringify(mxMode === "custom" ? servers : []) !== JSON.stringify(domain.mxServers);

  function updateServer(i: number, patch: Partial<MXServer>) {
    setServers((ss) => ss.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  function removeServer(i: number) {
    setServers((ss) => (ss.length <= 1 ? ss : ss.filter((_, idx) => idx !== i)));
  }

  async function saveMx() {
    setMxSaving(true);
    setMxError(null);
    try {
      await api.domains.updateMx(domain.name, mxMode, mxMode === "custom" ? servers : []);
      onDomainChanged();
    } catch (err) {
      setMxError(getErrorMessage(err, "Could not save mail servers."));
    } finally {
      setMxSaving(false);
    }
  }

  async function recheckDns() {
    setDnsBusy(true);
    setDnsError(null);
    try {
      await api.domains.recheck(domain.name);
      onDomainChanged();
    } catch (err) {
      setDnsError(getErrorMessage(err, "DNS re-check failed."));
    } finally {
      setDnsBusy(false);
    }
  }

  async function deleteDomain() {
    const ok = await confirm({
      title: "Delete domain",
      message: `Delete ${domain.name}? Mailboxes and API keys associated with it will also be deleted. This cannot be undone.`,
      confirmLabel: "Delete domain",
      danger: true,
    });
    if (!ok) return;
    setDeleteError(null);
    try {
      await api.domains.remove(domain.name);
      onDeleted();
    } catch (err) {
      setDeleteError(getErrorMessage(err, "Failed to delete domain."));
    }
  }

  return (
    <div className="grid items-start gap-5">
      <div className="grid items-start gap-5 xl:grid-cols-2">
        <div className="grid items-start gap-5">
      <SettingCard title="General" body={`Mail for ${domain.name} routes through ${domain.mxMode === "default" ? DEFAULT_MX_HOST : `${domain.mxServers.length} custom server(s)`}. Added ${domain.addedAt}.`}>
        <dl className="grid gap-2 text-[14px] sm:grid-cols-2">
          <div className="flex justify-between gap-4 rounded-lg border border-neutral-200 bg-white px-4 py-3"><dt className="text-neutral-400">Mailboxes</dt><dd className="font-bold tabular-nums">{boxes.length} / {user?.plan === 1 ? "∞" : 5}</dd></div>
          <div className="flex justify-between gap-4 rounded-lg border border-neutral-200 bg-white px-4 py-3"><dt className="text-neutral-400">Status</dt><dd><StatusPill status={domain.status} /></dd></div>
        </dl>
      </SettingCard>

      <SettingCard
        title="DNS"
        body={`MX, SPF, DKIM, DMARC for ${domain.name}. Re-checks every ${CHECK_COOLDOWN_S}s.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {domain.dns.length > 0 && (
              <CopyButton
                text={formatZoneFile(domain.dns)}
                notifyMessage="Copied all DNS records (Zone file format)"
              />
            )}
            <PrimaryButton onClick={recheckDns} disabled={dnsBusy || cooldown > 0}>
              {dnsBusy ? "Checking…" : cooldown > 0 ? `Re-check in ${cooldown}s` : "Re-check DNS"}
            </PrimaryButton>
          </div>
        }
      >
        <div className="mb-3">
          <DnsGuideBox />
        </div>
        {dnsError && (
          <div className="mb-3">
            <ErrorBox onDismiss={() => setDnsError(null)}>{dnsError}</ErrorBox>
          </div>
        )}
        <div className="space-y-2.5">
          {domain.dns.length === 0 ? (
            <p className="rounded-lg border border-neutral-200 bg-white px-5 py-8 text-center text-[13.5px] text-neutral-500">No DNS snapshot stored for this domain yet.</p>
          ) : (
            domain.dns.map((r, i) => <DnsRecordRow key={`${r.kind}-${i}`} record={r} />)
          )}
        </div>
      </SettingCard>
        </div>
        <div className="grid items-start gap-5">
      <SettingCard
        title="Mail servers"
        body={`Where mail for ${domain.name} goes. There always has to be at least one server — removing the last one is disabled.`}
        action={
          <PrimaryButton onClick={saveMx} disabled={mxSaving || !mxDirty}>
            {mxSaving ? "Saving…" : "Save changes"}
          </PrimaryButton>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Mail server mode">
          {MX_MODE_OPTIONS.map((opt) => {
            const selectedMode = mxMode === opt.mode;
            return (
              <button
                key={opt.mode}
                onClick={() => setMxMode(opt.mode)}
                aria-pressed={selectedMode}
                className={`rounded-xl border p-4 text-left transition-colors ${
                  selectedMode ? "border-neutral-900 bg-neutral-900/[0.03] text-neutral-900" : "border-neutral-200 bg-white text-neutral-900 hover:border-neutral-400"
                }`}
              >
                <p className="text-[14px] font-bold">{opt.title}</p>
                <p className="mt-0.5 font-mono text-[12px] text-neutral-500">{opt.sub}</p>
              </button>
            );
          })}
        </div>

        {mxMode === "custom" && (
          <div className="mt-4 space-y-3">
            {servers.map((s, i) => (
              <div key={i} className="rounded-xl border border-neutral-200 bg-white p-4">
                <div className="flex items-center justify-between">
                  <p className="font-mono text-[11px] font-bold tracking-[0.14em] text-neutral-400">SERVER {i + 1}</p>
                  <button
                    onClick={() => removeServer(i)}
                    disabled={servers.length <= 1}
                    title={servers.length <= 1 ? "There always has to be at least one server" : "Remove this server"}
                    className={`text-[12.5px] font-semibold ${servers.length <= 1 ? "cursor-not-allowed opacity-40" : "text-neutral-400 hover:text-neutral-900"}`}
                  >
                    Remove
                  </button>
                </div>
                <div className="mt-3 grid gap-2.5 sm:grid-cols-[1fr_90px]">
                  <input value={s.host} onChange={(e) => updateServer(i, { host: e.target.value })} placeholder="mx1.yourserver.com" aria-label={`Server ${i + 1} hostname`} className={`${fieldCls} font-mono`} />
                  <input value={s.priority} onChange={(e) => updateServer(i, { priority: e.target.value })} placeholder="10" aria-label={`Server ${i + 1} priority`} className={fieldCls} />
                </div>
                <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
                  <input value={s.secret1} onChange={(e) => updateServer(i, { secret1: e.target.value })} placeholder="Secret 1" aria-label={`Server ${i + 1} secret 1`} type="password" className={`${fieldCls} font-mono`} />
                  <input value={s.secret2} onChange={(e) => updateServer(i, { secret2: e.target.value })} placeholder="Secret 2" aria-label={`Server ${i + 1} secret 2`} type="password" className={`${fieldCls} font-mono`} />
                </div>
              </div>
            ))}
            <button
              onClick={() => setServers((ss) => [...ss, { host: "", priority: "10", secret1: "", secret2: "" }])}
              className="w-full py-2 text-[13.5px] font-semibold text-neutral-500 transition-colors hover:text-neutral-900"
            >
              + Add another server
            </button>
          </div>
        )}

        {mxMode === "default" && (
          <p className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 font-mono text-[12.5px] text-neutral-600">
            MX → 10 {DEFAULT_MX_HOST}
          </p>
        )}

        {mxError && (
          <div className="mt-4">
            <ErrorBox onDismiss={() => setMxError(null)}>{mxError}</ErrorBox>
          </div>
        )}
        {!mxDirty && !mxError && (
          <p className="mt-3 text-[12.5px] text-neutral-400">No unsaved changes. Saving updates the MX records above — re-check DNS afterwards.</p>
        )}
      </SettingCard>

      <section className="rounded-xl border border-red-200 bg-white p-5 sm:p-7">
        <p className="font-mono text-[11px] font-semibold tracking-[0.14em] text-red-500">DANGER ZONE</p>
        <p className="mt-2 max-w-md text-[13.5px] text-neutral-500">Removes the domain, its mailboxes and keys. This can't be undone.</p>
        {deleteError && (
          <div className="mt-3 max-w-md">
            <ErrorBox onDismiss={() => setDeleteError(null)}>{deleteError}</ErrorBox>
          </div>
        )}
        <button onClick={deleteDomain} className="mt-3 text-[13.5px] font-bold text-red-600 hover:text-red-800">
          Delete {domain.name} →
        </button>
      </section>
        </div>
      </div>
    </div>
  );
}

export default function DashboardApp({ onGoLanding }: { onGoLanding: () => void }) {
  const { user, logout } = useAuth();
  const { accounts } = useMailbox();
  const route = useRoute();
  const [menu, setMenu] = useState(false);

  const selected = route.domain ?? null;
  const dtab = route.tab ?? "mailboxes";
  const flowOpen = route.newDomain ?? false;
  const tplFor = route.tplMailbox ?? null;
  const [studioTemplate, setStudioTemplate] = useState<MailTemplate | null>(null);

  const [domains, setDomains] = useState<Domain[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(true);
  const [domainsError, setDomainsError] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<Mailbox[]>([]);
  const [loadingBoxes, setLoadingBoxes] = useState(() => Boolean(selected));
  const [boxesError, setBoxesError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mboxCreateOpen, setMboxCreateOpen] = useState(false);
  const [pendingUsersCount, setPendingUsersCount] = useState<number>(0);

  useEffect(() => {
    if (user?.isAdmin) {
      api.admin
        .listUsers()
        .then((res) => {
          const count = res.users.filter((u) => u.status === "pending").length;
          setPendingUsersCount(count);
        })
        .catch(() => {});
    }
  }, [user?.isAdmin]);

  const domain = selected ? domains.find((d) => d.name === selected) ?? null : null;

  const refreshDomains = useCallback(async () => {
    setLoadingDomains(true);
    setDomainsError(null);
    try {
      setDomains(await api.domains.list());
    } catch (err) {
      setDomainsError(getErrorMessage(err, "Failed to load domains from server."));
    } finally {
      setLoadingDomains(false);
    }
  }, []);

  const refreshBoxes = useCallback(async () => {
    if (!selected) {
      setBoxes([]);
      setLoadingBoxes(false);
      setBoxesError(null);
      return;
    }
    setLoadingBoxes(true);
    setBoxesError(null);
    try {
      setBoxes(await api.mailboxes.list(selected));
    } catch (err) {
      setBoxesError(getErrorMessage(err, "Failed to load mailboxes for this domain."));
    } finally {
      setLoadingBoxes(false);
    }
  }, [selected]);

  useEffect(() => {
    void refreshDomains();
  }, [refreshDomains]);

  useEffect(() => {
    void refreshBoxes();
  }, [refreshBoxes]);

  useEffect(() => {
    const unsubscribe = subscribeToLiveEvents((event) => {
      if (event.type === "mailbox_usage" && event.address && typeof event.usedMb === "number") {
        setBoxes((prev) =>
          prev.map((b) =>
            b.address.toLowerCase() === event.address?.toLowerCase()
              ? { ...b, usedMb: event.usedMb ?? b.usedMb }
              : b,
          ),
        );
      }
    });
    return unsubscribe;
  }, []);

  function openDomain(name: string) {
    navigate({ view: "dashboard", domain: name, tab: "mailboxes" });
  }

  const filtered = domains.filter((d) => d.name.toLowerCase().includes(query.toLowerCase()));
  const studioOpen = tplFor !== null && domain !== null;

  const crumbs: { label: string; onClick?: () => void }[] = domain
    ? [
        { label: "Domains", onClick: () => navigate({ view: "dashboard" }) },
        { label: domain.name },
      ]
    : [{ label: "Domains" }];

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <header className="sticky top-0 z-30 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center justify-between gap-3 px-4 md:px-6">
          <div className="flex items-center gap-2">
            <button className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1" onClick={onGoLanding} aria-label="MailerGo home" title="Back to landing page">
              <Mark size={24} />
              <span className="text-[15px] font-semibold tracking-tight">MailerGo</span>
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate({ view: "mail", folder: "inbox" })}
              className="hidden sm:inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-[12.5px] font-medium text-neutral-700 hover:border-neutral-900 hover:text-neutral-900 transition-colors"
            >
              Mailbox{accounts.length > 0 ? ` (${accounts.length})` : ""} →
            </button>

            <div className="relative">
            <button
              onClick={() => setMenu((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menu}
              aria-label="Account menu"
              className="grid h-8 cursor-pointer place-items-center rounded-md bg-neutral-900 px-3 text-[13px] font-semibold text-white hover:bg-neutral-700"
              style={{ minWidth: 32 }}
            >
              {user?.email.charAt(0).toUpperCase()}
            </button>
            {menu && (
              <>
                <button aria-label="Close menu" className="fixed inset-0 z-10 cursor-default" onClick={() => setMenu(false)} />
                <div role="menu" className="absolute right-0 top-11 z-20 w-64 overflow-hidden rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl">
                  <div className="px-3 py-2.5">
                    <p className="truncate text-[13px] font-semibold">{user?.email}</p>
                    <p className="mt-0.5 font-mono text-[11px] tabular-nums text-neutral-500">
                      {user?.plan === 1 ? (
                        <span className="font-semibold text-emerald-600">Plan 1 · Unlimited {user?.isAdmin ? "(Admin)" : "(Self-Hosted)"}</span>
                      ) : (
                        <span>Plan 0 (Free) · {domains.length}/1 domain · 5 mailboxes</span>
                      )}
                    </p>
                  </div>
                  {user?.isAdmin && (
                    <button
                      onClick={() => { navigate({ view: "admin" }); setMenu(false); }}
                      className="flex w-full cursor-pointer items-center justify-between rounded-md px-3 py-2 text-left text-[13px] font-medium text-neutral-800 hover:bg-neutral-100 hover:text-neutral-900"
                    >
                      <span className="flex items-center gap-2">
                        <Shield className="h-3.5 w-3.5 text-neutral-700" />
                        <span>Users & Approvals</span>
                      </span>
                      {pendingUsersCount > 0 && (
                        <span className="rounded-full bg-amber-500 px-1.5 py-0.2 font-mono text-[10px] font-bold text-white">
                          {pendingUsersCount}
                        </span>
                      )}
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      setMenu(false);
                      setExportError(null);
                      try {
                        await api.user.exportData();
                      } catch (err) {
                        setExportError(getErrorMessage(err, "Failed to export data zip."));
                      }
                    }}
                    className="flex w-full cursor-pointer items-center justify-between rounded-md px-3 py-2 text-left text-[13px] font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
                    title="Export your personal database, messages, and attachments to self-host anywhere"
                  >
                    <span>Export Data (Self-Host)</span>
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">.zip</span>
                  </button>
                  <button
                    onClick={() => { void logout(); }}
                    className="w-full cursor-pointer rounded-md px-3 py-2 text-left text-[13px] font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
                  >
                    Sign out
                  </button>
                </div>
              </>
            )}
            </div>
          </div>
        </div>
        {domain && !studioOpen && (
          <div>
            <div className="mx-auto flex w-full max-w-[1200px] items-center gap-1.5 px-4 py-2 text-[12.5px] md:px-6">
              {crumbs.map((c, i) => (
                <span key={i} className="flex items-center gap-1.5">
                  {i > 0 && <span className="text-neutral-300">/</span>}
                  {c.onClick ? (
                    <button onClick={c.onClick} className="font-medium text-neutral-500 hover:text-neutral-900">{c.label}</button>
                  ) : (
                    <span className="font-mono font-medium text-neutral-900">{c.label}</span>
                  )}
                </span>
              ))}
              {flowOpen && <span className="flex items-center gap-1.5"><span className="text-neutral-300">/</span><span className="text-neutral-500">New domain</span></span>}
            </div>
          </div>
        )}
      </header>

      <main className={`mx-auto w-full ${studioOpen ? "max-w-[1600px]" : "max-w-[1200px]"} px-4 pb-20 pt-6 md:px-6 transition-all duration-300`}>
        {exportError && (
          <div className="mb-6">
            <ErrorBox onDismiss={() => setExportError(null)} title="Export Failed">
              {exportError}
            </ErrorBox>
          </div>
        )}
        {flowOpen ? (
          <div className="mx-auto max-w-2xl">
          <AddDomainFlow
            existing={domains}
            onExit={() => {
              clearDomainWizardDraft();
              navigate({ view: "dashboard" });
            }}
            onDone={(d) => {
              clearDomainWizardDraft();
              setDomains((ds) => [...ds, d]);
              navigate({ view: "dashboard", domain: d.name, tab: "mailboxes" });
            }}
          />
          </div>
        ) : studioOpen && domain ? (
          <TemplateStudio
            domainName={domain.name}
            mailboxes={boxes}
            initialTemplate={studioTemplate}
            initialMailbox={tplFor}
            onBack={() => {
              setStudioTemplate(null);
              navigate({ view: "dashboard", domain: domain.name, tab: "templates" });
              void refreshBoxes();
            }}
            onSaved={(saved) => {
              setStudioTemplate(saved);
            }}
            onDeleted={() => {
              setStudioTemplate(null);
            }}
          />
        ) : domain ? (
          <div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="truncate text-[24px] font-semibold tracking-tight text-neutral-900">{domain.name}</h1>
              <StatusPill status={domain.status} />
            </div>
            <p className="mt-1 font-mono text-[11.5px] text-neutral-500">
              {domain.mxMode === "default" ? `mail via ${DEFAULT_MX_HOST}` : `${domain.mxServers.length} custom MX server(s)`} · added {domain.addedAt}
            </p>

            <div className="mt-5 flex flex-wrap items-end justify-between gap-3 border-b border-neutral-200">
              <div className="flex gap-5" role="tablist" aria-label="Domain sections">
              {(
                [
                  { id: "mailboxes" as const, label: `Mailboxes${boxes.length > 0 ? ` (${boxes.length})` : ""}` },
                  { id: "templates" as const, label: "Templates" },
                  { id: "api" as const, label: "API keys" },
                  { id: "settings" as const, label: "Settings" },
                ]
              ).map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={dtab === t.id}
                  onClick={() => navigate({ view: "dashboard", domain: domain.name, tab: t.id })}
                  className={`-mb-px shrink-0 border-b-2 pb-2 text-[13.5px] font-semibold transition-colors cursor-pointer ${
                    dtab === t.id ? "border-neutral-900 text-neutral-900" : "border-transparent text-neutral-400 hover:text-neutral-900"
                  }`}
                >
                  {t.label}
                </button>
              ))}
              </div>
              {dtab === "mailboxes" && (
                <div className="mb-2 flex shrink-0 items-center gap-2">
                  <PrimaryButton onClick={() => setMboxCreateOpen(true)}>
                    + New mailbox
                  </PrimaryButton>
                </div>
              )}
            </div>

            <div className="pt-5">
              {dtab === "mailboxes" ? (
                <MailboxesPanel
                  domain={domain}
                  boxes={boxes}
                  busy={loadingBoxes}
                  loadError={boxesError}
                  onRefresh={refreshBoxes}
                  createOpen={mboxCreateOpen}
                  onCreateOpenChange={setMboxCreateOpen}
                  onOpenTemplates={(a) => {
                    setStudioTemplate(null);
                    navigate({ view: "dashboard", domain: domain.name, tab: "templates", tplMailbox: a });
                  }}
                />
              ) : dtab === "templates" ? (
                <TemplatesTab
                  domainName={domain.name}
                  mailboxes={boxes}
                  onOpenStudio={(tpl, mbox) => {
                    setStudioTemplate(tpl ?? null);
                    navigate({
                      view: "dashboard",
                      domain: domain.name,
                      tab: "templates",
                      tplMailbox: mbox ?? tpl?.mailbox ?? `*@${domain.name}`,
                    });
                  }}
                />
              ) : dtab === "api" ? (
                <ApiKeysPanel domainName={domain.name} boxes={boxes} allDomains={domains.map((d) => d.name)} />
              ) : (
                <SettingsPanel
                  key={domain.name}
                  domain={domain}
                  boxes={boxes}
                  onDomainChanged={refreshDomains}
                  onDeleted={() => {
                    navigate({ view: "dashboard" });
                    void refreshDomains();
                  }}
                />
              )}
            </div>
          </div>
        ) : (
          <div>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Overview</p>
                <h1 className="mt-1 text-[26px] font-semibold tracking-tight text-neutral-900">Domains</h1>
                <p className="mt-1 font-mono text-[11.5px] tabular-nums text-neutral-500">
                  {user?.plan === 1
                    ? `${domains.length} domains · unlimited quota`
                    : `${domains.length} of 1 used · max 1 domain on Free plan`}
                </p>
              </div>
              <PrimaryButton
                onClick={() => {
                  if (user?.plan === 0 && domains.length >= 1) {
                    notify.error("Domain limit reached", "Free plan accounts are limited to 1 custom domain. Administrator accounts have unlimited domains.");
                    return;
                  }
                  navigate({ view: "dashboard", newDomain: true });
                }}
              >
                + Add domain
              </PrimaryButton>
            </div>

            {domainsError && (
              <div className="mt-4">
                <ErrorBox
                  title="Failed to Load Domains"
                  onDismiss={() => setDomainsError(null)}
                  action={{
                    label: "Retry",
                    onClick: () => { void refreshDomains(); },
                  }}
                >
                  {domainsError}
                </ErrorBox>
              </div>
            )}

            <div className="mt-6 flex items-center justify-between gap-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">All domains</p>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" aria-label="Search domains" className="w-44 rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-[13px] focus:border-neutral-900 focus:outline-none" />
            </div>
            {loadingDomains ? (
              <Card className="mt-3"><p className="px-5 py-12 text-center text-[13px] text-neutral-500">Loading domains…</p></Card>
            ) : filtered.length === 0 ? (
              <Card className="mt-3"><EmptyState
                title={domains.length === 0 ? "No domains yet" : "No matches"}
                body={domains.length === 0 ? "Add your first domain, verify its DNS, then open it to create mailboxes." : "Try a different search."}
                action={domains.length === 0 ? <PrimaryButton large onClick={() => navigate({ view: "dashboard", newDomain: true })}>Add your first domain →</PrimaryButton> : undefined}
              /></Card>
            ) : (
              <Card className="mt-3">
              <ul className="divide-y divide-neutral-100">
                {filtered.map((d) => (
                  <li key={d.name}>
                    <button onClick={() => openDomain(d.name)} className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-50">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-neutral-900 text-[14px] font-semibold text-white" aria-hidden="true">
                        {d.name.charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-semibold text-neutral-900">{d.name}</span>
                        <span className="mt-0.5 block font-mono text-[11px] tabular-nums text-neutral-400">
                          added {d.addedAt}
                        </span>
                      </span>
                      <StatusPill status={d.status} />
                      <span aria-hidden="true" className="text-neutral-300 transition-all group-hover:translate-x-0.5 group-hover:text-neutral-900">→</span>
                    </button>
                  </li>
                ))}
              </ul>
              </Card>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
