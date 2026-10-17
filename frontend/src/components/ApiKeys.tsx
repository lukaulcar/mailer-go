import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Check } from "lucide-react";
import { useConfirm } from "../lib/confirm";
import {
  api,
  getErrorMessage,
  describePermissions,
  describeScope,
  isKeyExpired,
  keyPermissions,
  scopeMailboxes,
  expiryDateForDays,
  API_KEY_PERMISSIONS,
  API_KEY_EXPIRY_PRESETS,
} from "../lib/api";
import type {
  ApiKey,
  ApiKeyExpiryPresetId,
  ApiKeyPermission,
  ApiKeyScope,
  CreatedApiKey,
  Mailbox,
} from "../lib/api";

import { CopyButton, Modal, CodeBlock, ErrorBox } from "./ui";
import { cx } from "../lib/utils";
import { notify } from "../lib/toast";

function PermissionsBadge({ perms }: { perms: ApiKeyPermission[] }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[11px] font-semibold text-neutral-700">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" aria-hidden="true" />
      {describePermissions(perms)}
    </span>
  );
}

function ExpiryBadge({ expiresAt }: { expiresAt?: string | null }) {
  if (!expiresAt) return null;
  const expired = isKeyExpired({ expiresAt });
  if (expired) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-red-600">
        Expired {expiresAt}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2 py-0.5 font-mono text-[11px] font-medium text-amber-500">
      Expires {expiresAt}
    </span>
  );
}

function ScopeBadge({ scope }: { scope: ApiKeyScope }) {
  return (
    <span className="inline-flex max-w-full items-center truncate rounded-md bg-neutral-900 px-2 py-0.5 font-mono text-[11px] font-medium text-white">
      <span className="truncate">{describeScope(scope)}</span>
    </span>
  );
}

function exampleFrom(k: ApiKey, domainName: string): string {
  const boxes = scopeMailboxes(k.scope);
  if (boxes.length > 0) return boxes[0];
  return `hello@${domainName}`;
}

function curlFor(k: ApiKey, domainName: string): string {
  return `curl -X POST https:
  -H "Authorization: Bearer ${k.prefix.replace("…", "_<redacted>")}" \\
  -H "Content-Type: application/json" \\
  -d '{"from": "${exampleFrom(k, domainName)}", "to": "user@example.com", "template": "welcome", "vars": {"name": "Sara"}}'`;
}

const WS_SNIPPET = `const ws = new WebSocket("wss://mailer.lukaulcar.com/v1/stream");

ws.onopen = () => {
  ws.send(JSON.stringify({ key: "mg_live_…" }));
};

ws.onmessage = (e) => {
  const mail = JSON.parse(e.data);
  console.log(mail.mailbox, mail.from, mail.subject);
};`;

export default function ApiKeysPanel({
  domainName,
  boxes,
  allDomains,
}: {
  domainName: string;
  boxes: Mailbox[];
  allDomains: string[];
}) {
  const confirm = useConfirm();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<CreatedApiKey | null>(null);

  const [label, setLabel] = useState("");
  const [permissions, setPermissions] = useState<ApiKeyPermission[]>(["send"]);
  const [scopeType, setScopeType] = useState<"domain" | "domains" | "mailboxes">("domain");
  const [scopeDomains, setScopeDomains] = useState<string[]>([domainName]);
  const [scopeBoxes, setScopeBoxes] = useState<string[]>([]);
  const [mailboxChoices, setMailboxChoices] = useState<Mailbox[]>(boxes);
  const [expiryPreset, setExpiryPreset] = useState<ApiKeyExpiryPresetId>("never");
  const [expiryDate, setExpiryDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setListError(null);
    void api.keys
      .list(domainName)
      .then((ks) => {
        if (!live) return;
        setKeys(ks);
        if (ks.length > 0) setExpandedId((prev) => prev ?? ks[0].id);
      })
      .catch((err) => {
        if (live) setListError(getErrorMessage(err, "Failed to load API keys."));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [domainName]);

  useEffect(() => {
    setScopeDomains([domainName]);
    setScopeBoxes((prev) => prev.filter((a) => boxes.some((b) => b.address === a)));
  }, [domainName, boxes]);

  useEffect(() => {
    let live = true;
    void api.mailboxes
      .listAll()
      .then((all) => {
        if (!live) return;
        setMailboxChoices(all.length > 0 ? all : boxes);
      })
      .catch(() => {
        if (live) setMailboxChoices(boxes);
      });
    return () => {
      live = false;
    };
  }, [boxes]);

  function openCreate() {
    setLabel("");
    setPermissions(["send"]);
    setScopeType("domain");
    setScopeDomains([domainName]);
    setScopeBoxes([]);
    setExpiryPreset("never");
    setExpiryDate(expiryDateForDays(30));
    setError(null);
    setCreateOpen(true);
  }

  function togglePermission(p: ApiKeyPermission) {
    setPermissions((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }

  function toggleDomain(d: string) {
    setScopeDomains((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d],
    );
  }

  function toggleScopeBox(address: string) {
    setScopeBoxes((prev) =>
      prev.includes(address) ? prev.filter((x) => x !== address) : [...prev, address],
    );
  }

  function selectAllBoxes() {
    setScopeBoxes((prev) =>
      prev.length === mailboxChoices.length ? [] : mailboxChoices.map((m) => m.address),
    );
  }

  function resolveExpiry(at = new Date()): string | null {
    const preset = API_KEY_EXPIRY_PRESETS.find((p) => p.id === expiryPreset);
    if (!preset) return null;
    if (preset.id === "custom") {
      const picked = expiryDate.trim();
      return picked ? picked : null;
    }
    if (preset.days === null) return null;
    return expiryDateForDays(preset.days, at);
  }

  async function submitCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (permissions.length === 0) throw new Error("Give the key at least one permission.");
      const scope: ApiKeyScope =
        scopeType === "mailboxes"
          ? {
              type: "mailboxes",
              domains: scopeDomains.length > 0 ? scopeDomains : [domainName],
              mailboxes: scopeBoxes,
              mailbox: scopeBoxes[0],
            }
          : scopeType === "domains"
            ? {
                type: "domains",
                domains: scopeDomains.length > 0 ? scopeDomains : [domainName],
              }
            : { type: "domain", domains: [domainName] };
      if (scopeType === "mailboxes" && scopeBoxes.length === 0) {
        throw new Error("Pick at least one mailbox for this key.");
      }
      if (scopeType === "mailboxes") {
        const parents = scopeBoxes
          .map((a) => a.split("@")[1]?.toLowerCase())
          .filter((d): d is string => Boolean(d));
        scope.domains = Array.from(new Set([...scope.domains, ...parents]));
      }
      const expiresAt = resolveExpiry();
      if (expiresAt && expiresAt < new Date().toISOString().slice(0, 10)) {
        throw new Error("Expiry must be in the future.");
      }
      const created = await api.keys.create(label, scope, "send", {
        permissions,
        expiresAt,
      });
      setKeys((ks) => [...ks, created]);
      setExpandedId(created.id);
      setNewKey(created);
      setCreateOpen(false);
      notify.success("API key created successfully");
    } catch (err) {
      setError(getErrorMessage(err, "Could not create API key."));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    const key = keys.find((k) => k.id === id);
    const labelText = key?.label ? `"${key.label}"` : "this key";
    const ok = await confirm({
      title: "Revoke API key",
      message: `Are you sure you want to revoke ${labelText}? Any requests using it will start failing immediately.`,
      confirmLabel: "Revoke key",
      danger: true,
    });
    if (!ok) return;
    setActionError(null);
    try {
      await api.keys.revoke(id);
      notify.success("API key revoked");
      setKeys((ks) => ks.filter((k) => k.id !== id));
      setExpandedId((prev) => {
        if (prev !== id) return prev;
        const remaining = keys.filter((k) => k.id !== id);
        return remaining[0]?.id ?? null;
      });
    } catch (err) {
      setActionError(getErrorMessage(err, "Failed to revoke API key."));
    }
  }

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-xl border border-neutral-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight text-neutral-900">
              API keys{" "}
              <span className="ml-1.5 rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-neutral-500">
                {keys.length}
              </span>
            </h2>
            <p className="mt-0.5 text-[12.5px] text-neutral-500">
              One key per app or environment. Authenticate with{" "}
              <code className="rounded bg-neutral-100 px-1 font-mono text-[11.5px]">Authorization: Bearer mg_live_…</code>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="#"
              onClick={(e) => e.preventDefault()}
              className="hidden text-[12.5px] font-medium text-neutral-500 underline-offset-4 hover:text-neutral-900 hover:underline sm:block"
            >
              Docs: POST /v1/send
            </a>
            <button
              onClick={openCreate}
              className="rounded-md bg-neutral-900 px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-neutral-700"
            >
              + Create key
            </button>
          </div>
        </div>

        {actionError && (
          <div className="border-b border-red-200 bg-red-50/70 p-4">
            <ErrorBox onDismiss={() => setActionError(null)}>{actionError}</ErrorBox>
          </div>
        )}

        {listError && (
          <div className="border-b border-red-100 p-4">
            <ErrorBox onDismiss={() => setListError(null)}>{listError}</ErrorBox>
          </div>
        )}

        {newKey && (
          <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12.5px] font-semibold text-emerald-900">
                Key created — copy it now. It won&apos;t be shown again.
              </p>
              <button
                onClick={() => setNewKey(null)}
                className="text-[12px] font-semibold text-emerald-700 hover:text-emerald-900"
              >
                Dismiss
              </button>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-white px-3 py-2.5">
              <code className="min-w-0 break-all font-mono text-[12.5px] text-neutral-900">{newKey.secret}</code>
              <CopyButton text={newKey.secret} notifyMessage="Copied API key to clipboard" />
            </div>
          </div>
        )}

        {loading ? (
          <p className="px-5 py-10 text-center text-[13px] text-neutral-500">Loading keys…</p>
        ) : listError ? (
          <div className="p-6 text-center">
            <div className="mx-auto max-w-md">
              <ErrorBox onDismiss={() => setListError(null)}>{listError}</ErrorBox>
            </div>
          </div>
        ) : keys.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-[13.5px] font-semibold text-neutral-900">No keys for {domainName} yet</p>
            <p className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-neutral-500">
              Create one to send mail or stream it live. Choose its permissions, what it controls, and when it expires.
            </p>
            <button
              onClick={openCreate}
              className="mt-4 rounded-md bg-neutral-900 px-4 py-2 text-[13px] font-semibold text-white hover:bg-neutral-700"
            >
              + Create your first key
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {keys.map((k) => {
              const open = k.id === expandedId;
              const perms = keyPermissions(k);
              const expired = isKeyExpired(k);
              const canSend = perms.includes("send");
              const canStream = perms.includes("events");
              const canDeleteMessages = perms.includes("delete_messages");
              const canDeleteMailbox = perms.includes("delete_mailbox");
              return (
                <li key={k.id} className={expired ? "opacity-70" : undefined}>
                  <button
                    onClick={() => setExpandedId((prev) => (prev === k.id ? null : k.id))}
                    aria-expanded={open}
                    className={cx(
                      "flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors",
                      open ? "bg-neutral-900/[0.04]" : "hover:bg-neutral-50",
                    )}
                  >
                    <span
                      className={cx(
                        "h-8 w-1 shrink-0 rounded-full",
                        open ? "bg-neutral-900" : "bg-neutral-200",
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-[13.5px] font-semibold text-neutral-900">{k.label}</span>
                        <PermissionsBadge perms={perms} />
                        <ExpiryBadge expiresAt={k.expiresAt} />
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <ScopeBadge scope={k.scope} />
                        <span className="font-mono text-[11px] text-neutral-400">
                          {k.prefix} · {k.createdAt}
                        </span>
                      </span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={cx(
                        "shrink-0 text-[16px] transition-transform",
                        open ? "rotate-90 text-neutral-900" : "text-neutral-300",
                      )}
                    >
                      ›
                    </span>
                  </button>
                  {open && (
                    <div className="border-t border-neutral-100 bg-neutral-50/60 px-5 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="font-mono text-[11.5px] text-neutral-500">
                          {k.prefix} · created {k.createdAt} · {expired ? "expired" : "active"}
                          {k.expiresAt && !expired && ` · expires ${k.expiresAt}`}
                        </p>
                        <button
                          onClick={() => revoke(k.id)}
                          className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-red-700 transition-colors hover:bg-red-50"
                        >
                          Revoke
                        </button>
                      </div>

                      <div className="mt-3 grid gap-3">
                        <div className="rounded-lg border border-neutral-200 bg-white p-3.5">
                          <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                            What this key can do
                          </p>
                          <ul className="mt-2 space-y-1.5">
                            {API_KEY_PERMISSIONS.map((p) => {
                              const granted = perms.includes(p.id);
                              return (
                                <li key={p.id} className="flex items-start gap-2">
                                  <span
                                    className={cx(
                                      "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold",
                                      granted ? "bg-emerald-100 text-emerald-700" : "bg-neutral-100 text-neutral-300",
                                    )}
                                    aria-hidden="true"
                                  >
                                    {granted ? <Check className="h-2.5 w-2.5 stroke-[3]" /> : "–"}
                                  </span>
                                  <span>
                                    <span className={cx("font-mono text-[11.5px] font-semibold", granted ? "text-neutral-900" : "text-neutral-400 line-through")}>
                                      {p.endpoint}
                                    </span>
                                    <span className="block text-[12px] text-neutral-500">{p.description}</span>
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        </div>

                        <div className="rounded-lg border border-neutral-200 bg-white p-3.5">
                          <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                            What this key controls
                          </p>
                          {k.scope.type === "mailbox" || k.scope.type === "mailboxes" ? (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {scopeMailboxes(k.scope).map((m) => (
                                <span key={m} className="break-all rounded-md bg-neutral-100 px-2 py-1 font-mono text-[11.5px] text-neutral-800">
                                  {m}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {k.scope.domains.map((d) => (
                                <span key={d} className="break-all rounded-md bg-neutral-100 px-2 py-1 font-mono text-[11.5px] text-neutral-800">
                                  {d}
                                </span>
                              ))}
                            </div>
                          )}
                          <p className="mt-2 text-[12px] leading-relaxed text-neutral-500">
                            {k.scope.type === "mailbox" || k.scope.type === "mailboxes"
                              ? scopeMailboxes(k.scope).length === 1
                                ? "Restricted to a single sender address. Requests with any other From address are rejected with 403."
                                : `Restricted to ${scopeMailboxes(k.scope).length} sender addresses. Requests with any other From address are rejected with 403.`
                              : k.scope.type === "domain"
                                ? `Any mailbox on ${describeScope(k.scope)} can send with this key.`
                                : `This key may send from ${k.scope.domains.length} domains. The From address must belong to one of them.`}
                            {canStream && " The live stream only carries mail from this scope."}
                          </p>
                        </div>

                        {canSend && (
                          <CodeBlock title="Example request" code={curlFor(k, domainName)} />
                        )}

                        {canStream && (
                          <CodeBlock title="Live stream — WebSocket" code={WS_SNIPPET} />
                        )}

                        {canDeleteMessages && (
                          <CodeBlock
                            title="Delete message by ID — cURL"
                            code={`curl -X DELETE "${window.location.origin}/api/messages/{id}" \\\n  -H "X-API-Key: ${k.prefix}..."`}
                          />
                        )}

                        {canDeleteMailbox && (
                          <CodeBlock
                            title="Clear mailbox inbox — cURL"
                            code={`curl -X POST "${window.location.origin}/api/mailboxes/{address}/messages/clear" \\\n  -H "X-API-Key: ${k.prefix}..."`}
                          />
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {createOpen && (
          <Modal
            title="Create API key"
            subtitle="Permissions, scope, expiry. Secret is shown once."
            onClose={() => setCreateOpen(false)}
          >
            <form onSubmit={submitCreate}>
              <div className="space-y-5">
                <fieldset>
                  <legend className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                    1 · What can this key do?
                  </legend>
                  <div className="mt-2 grid gap-2" role="group" aria-label="Key permissions">
                    {API_KEY_PERMISSIONS.map((p) => {
                      const on = permissions.includes(p.id);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => togglePermission(p.id)}
                          aria-pressed={on}
                          className={cx(
                            "rounded-lg border p-3 text-left transition-colors",
                            on
                              ? "border-neutral-900 bg-neutral-900/[0.03]"
                              : "border-neutral-200 bg-white hover:border-neutral-400",
                          )}
                        >
                          <span className="flex items-center gap-2">
                            <span
                              className={cx(
                                "grid h-4 w-4 shrink-0 place-items-center rounded border text-[11px] font-bold",
                                on ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300 text-transparent",
                              )}
                              aria-hidden="true"
                            >
                              {on && <Check className="h-3 w-3 stroke-[3]" />}
                            </span>
                            <span className="text-[13.5px] font-semibold text-neutral-900">{p.title}</span>
                            <span className="ml-auto shrink-0 font-mono text-[10.5px] text-neutral-400">{p.endpoint}</span>
                          </span>
                          <span className="mt-1 block pl-6 text-[12.5px] leading-relaxed text-neutral-500">
                            {p.description}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>

                <fieldset>
                  <legend className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                    2 · What can it control?
                  </legend>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Key scope">
                    {(
                      [
                        { id: "domain" as const, title: "Whole domain", sub: domainName },
                        { id: "domains" as const, title: "Multiple", sub: "2+ domains" },
                        { id: "mailboxes" as const, title: "Mailboxes", sub: "one or many" },
                      ]
                    ).map((o) => {
                      const on = scopeType === o.id;
                      return (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => setScopeType(o.id)}
                          aria-pressed={on}
                          className={cx(
                            "rounded-lg border p-3 text-left transition-colors",
                            on
                              ? "border-neutral-900 bg-neutral-900/[0.03]"
                              : "border-neutral-200 bg-white hover:border-neutral-400",
                          )}
                        >
                          <span className="block text-[13px] font-semibold text-neutral-900">{o.title}</span>
                          <span className="mt-0.5 block truncate font-mono text-[11px] text-neutral-500">{o.sub}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-neutral-500">
                    Sending and the live stream only ever cover this scope.
                  </p>

                  {scopeType === "domains" && (
                    <div className="mt-2 flex flex-wrap gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50 p-2.5">
                      {(allDomains.length > 0 ? allDomains : [domainName]).map((d) => {
                        const on = scopeDomains.includes(d);
                        return (
                          <button
                            key={d}
                            type="button"
                            onClick={() => toggleDomain(d)}
                            aria-pressed={on}
                            className={cx(
                              "rounded-md border px-2.5 py-1.5 font-mono text-[11.5px] transition-colors",
                              on
                                ? "border-neutral-900 bg-neutral-900 text-white"
                                : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-400",
                            )}
                          >
                            {d}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {scopeType === "mailboxes" && (
                    <div className="mt-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2.5">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-[12px] font-medium text-neutral-600">
                          Mailboxes{" "}
                          <span className="font-mono text-[11px] text-neutral-400">
                            {scopeBoxes.length} selected
                          </span>
                        </span>
                        {mailboxChoices.length > 0 && (
                          <button
                            type="button"
                            onClick={selectAllBoxes}
                            className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-[11px] font-semibold text-neutral-600 transition-colors hover:border-neutral-900 hover:text-neutral-900"
                          >
                            {scopeBoxes.length === mailboxChoices.length ? "Clear all" : "Select all"}
                          </button>
                        )}
                      </div>
                      {mailboxChoices.length === 0 ? (
                        <p className="px-1 py-1 text-[12.5px] text-neutral-500">
                          Create a mailbox first, then scope a key to it.
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Scoped mailboxes">
                          {mailboxChoices.map((m) => {
                            const on = scopeBoxes.includes(m.address);
                            return (
                              <button
                                key={m.address}
                                type="button"
                                onClick={() => toggleScopeBox(m.address)}
                                aria-pressed={on}
                                className={cx(
                                  "rounded-md border px-2.5 py-1.5 font-mono text-[11.5px] transition-colors",
                                  on
                                    ? "border-neutral-900 bg-neutral-900 text-white"
                                    : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-400",
                                )}
                              >
                                {m.address}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <p className="mt-2 px-1 text-[11.5px] leading-relaxed text-neutral-500">
                        Pick one or many. Only these From addresses are allowed; any other one is rejected with 403.
                      </p>
                    </div>
                  )}
                </fieldset>

                <div>
                  <label htmlFor="new-key-label" className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                    3 · Label
                  </label>
                  <input
                    id="new-key-label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. production"
                    autoComplete="off"
                    className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2.5 text-[13.5px] text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none"
                  />
                </div>

                <fieldset>
                  <legend className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                    4 · Expiry
                  </legend>
                  <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Key expiry">
                    {API_KEY_EXPIRY_PRESETS.map((p) => {
                      const on = expiryPreset === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setExpiryPreset(p.id)}
                          aria-pressed={on}
                          className={cx(
                            "rounded-md border px-2.5 py-1.5 text-[12.5px] font-semibold transition-colors",
                            on
                              ? "border-neutral-900 bg-neutral-900 text-white"
                              : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-400",
                          )}
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-neutral-500">
                    {expiryPreset === "never"
                      ? "This key never expires — revoke it manually when you're done with it."
                      : expiryPreset === "custom"
                        ? "Pick the exact day this key stops working."
                        : `This key stops working on ${resolveExpiry()}.`}
                  </p>
                  {expiryPreset === "custom" && (
                    <input
                      type="date"
                      value={expiryDate}
                      onChange={(e) => setExpiryDate(e.target.value)}
                      aria-label="Expiry date"
                      className="mt-2 w-full rounded-md border border-neutral-200 bg-white px-3 py-2.5 font-mono text-[13px] text-neutral-900 focus:border-neutral-900 focus:outline-none"
                    />
                  )}
                </fieldset>

                {error && (
                  <ErrorBox onDismiss={() => setError(null)}>
                    {error}
                  </ErrorBox>
                )}
              </div>

              <div className="-mx-5 -mb-4 mt-5 flex items-center justify-end gap-2 border-t border-neutral-200 bg-neutral-50 px-5 py-3.5">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="rounded-md px-4 py-2 text-[13px] font-semibold text-neutral-500 hover:text-neutral-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-md bg-neutral-900 px-5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
                >
                  {busy ? "Creating…" : "Create key"}
                </button>
              </div>
            </form>
          </Modal>
        )}
      </div>
  );
}
