import { useState, useEffect, useMemo } from "react";
import { api, isDomainWideTemplate, getErrorMessage, type MailTemplate, type Mailbox } from "../lib/api";
import { extractVars, PRESET_TEMPLATES } from "../lib/templatePresets";
import { useConfirm } from "../lib/confirm";
import { notify } from "../lib/toast";

interface TemplatesTabProps {
  domainName: string;
  mailboxes: Mailbox[];
  onOpenStudio: (tpl?: MailTemplate | null, initialMailbox?: string | null) => void;
}

export default function TemplatesTab({
  domainName,
  mailboxes,
  onOpenStudio,
}: TemplatesTabProps) {
  const confirm = useConfirm();
  const [templates, setTemplates] = useState<MailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [startersModalOpen, setStartersModalOpen] = useState(false);

  
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api.templates
      .listDomain(domainName)
      .then((list) => {
        if (!live) return;
        setTemplates(list);
        setLoading(false);
      })
      .catch((err) => {
        if (!live) return;
        setError(getErrorMessage(err, "Failed to load templates."));
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [domainName]);

  
  const filteredTemplates = useMemo(() => {
    return templates.filter((t) => {
      const matchSearch =
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        t.subject.toLowerCase().includes(search.toLowerCase());
      if (!matchSearch) return false;

      if (scopeFilter === "domain") {
        return isDomainWideTemplate(t);
      }
      if (scopeFilter === "mailbox") {
        return !isDomainWideTemplate(t);
      }
      if (scopeFilter !== "all") {
        return t.mailbox.toLowerCase() === scopeFilter.toLowerCase();
      }
      return true;
    });
  }, [templates, search, scopeFilter]);

  
  async function handleDuplicate(tpl: MailTemplate) {
    let copyName = `${tpl.name}_copy`;
    let i = 2;
    while (templates.some((t) => t.name === copyName)) {
      copyName = `${tpl.name}_copy_${i}`;
      i++;
    }

    try {
      const created = await api.templates.create(domainName, {
        name: copyName,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        mailbox: tpl.mailbox,
      });
      setTemplates((prev) => [created, ...prev]);
      notify.success(`Duplicated as "${copyName}"`);
    } catch (err) {
      notify.error(getErrorMessage(err, "Failed to duplicate template."));
    }
  }

  async function handleDelete(tpl: MailTemplate) {
    const ok = await confirm({
      title: "Delete template?",
      message: `Are you sure you want to delete template "${tpl.name}"? This cannot be undone.`,
      confirmLabel: "Delete template",
      danger: true,
    });
    if (!ok) return;

    try {
      await api.templates.remove(tpl.id);
      setTemplates((prev) => prev.filter((t) => t.id !== tpl.id));
      notify.success("Template deleted");
    } catch (err) {
      notify.error(getErrorMessage(err, "Failed to delete template."));
    }
  }

  async function handleCreateFromStarter(preset: (typeof PRESET_TEMPLATES)[0]) {
    try {
      const isBlank = preset.id === "blank_canvas";
      const baseName = isBlank ? "blank_template" : preset.name;
      let tplName = baseName;
      let i = 2;
      while (templates.some((t) => t.name === tplName)) {
        tplName = `${baseName}_${i}`;
        i++;
      }
      const created = await api.templates.create(domainName, {
        name: tplName,
        subject: preset.subject,
        html: preset.html,
        text: preset.text,
        mailbox: `*@${domainName}`,
      });
      setTemplates((prev) => [created, ...prev]);
      setStartersModalOpen(false);
      notify.success(isBlank ? `Created clean blank template` : `Created "${tplName}" from starter`);
      onOpenStudio(created);
    } catch (err) {
      notify.error(getErrorMessage(err, "Failed to create template from starter."));
    }
  }

  return (
    <div className="space-y-6">
      
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-[19px] font-bold text-neutral-900">Email Templates</h2>
          <p className="mt-0.5 text-[13px] text-neutral-500">
            Create, design, and manage responsive transactional email templates for {domainName}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setStartersModalOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3.5 py-2 text-[13px] font-semibold text-neutral-700 shadow-2xs hover:border-neutral-400 hover:text-neutral-900 transition-colors cursor-pointer"
          >
            <span>Template Library</span>
            <span className="rounded-full bg-neutral-100 px-1.5 py-0.2 font-mono text-[10px] font-bold text-neutral-600">
              {PRESET_TEMPLATES.length}
            </span>
          </button>
          <button
            onClick={() => onOpenStudio(null, `*@${domainName}`)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-4 py-2 text-[13px] font-semibold text-white shadow-xs hover:bg-neutral-800 transition-colors cursor-pointer"
          >
            <span>+ New Template</span>
          </button>
        </div>
      </div>

      
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-white p-3 shadow-2xs">
        
        <div className="relative min-w-[260px] flex-1">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search templates by name or subject…"
            className="w-full rounded-lg border border-neutral-200 bg-neutral-50/50 px-3 py-1.5 text-[13px] text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:bg-white focus:outline-none"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 cursor-pointer"
            >
              ✕
            </button>
          )}
        </div>

        
        <div className="flex items-center gap-2 text-[12.5px]">
          <span className="font-medium text-neutral-500">Filter Scope:</span>
          <select
            value={scopeFilter}
            onChange={(e) => setScopeFilter(e.target.value)}
            className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-[12.5px] font-medium text-neutral-800 focus:border-neutral-900 focus:outline-none"
          >
            <option value="all">All Scopes ({templates.length})</option>
            <option value="domain">Domain-wide (*@{domainName})</option>
            <option value="mailbox">Mailbox-specific</option>
            {mailboxes.map((mb) => (
              <option key={mb.address} value={mb.address}>
                {mb.address}
              </option>
            ))}
          </select>
        </div>
      </div>

      
      {loading ? (
        <div className="rounded-xl border border-neutral-200 bg-white p-12 text-center">
          <p className="text-[13.5px] text-neutral-500">Loading email templates…</p>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-200 bg-red-50/50 p-6 text-center">
          <p className="text-[13.5px] font-medium text-red-700">{error}</p>
        </div>
      ) : filteredTemplates.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-10 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-neutral-100 text-neutral-500">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 6.5C4 5.12 5.12 4 6.5 4h11C18.88 4 20 5.12 20 6.5v11c0 1.38-1.12 2.5-2.5 2.5h-11C5.12 20 4 18.88 4 17.5v-11Z"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <path d="M4 7l8 5.5L20 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </div>
          <h3 className="text-[16px] font-bold text-neutral-900">
            {search ? "No matching templates found" : "No email templates yet"}
          </h3>
          <p className="mx-auto mt-1 max-w-md text-[13px] text-neutral-500">
            {search
              ? "Try clearing your search query or scope filter."
              : "Create reusable branded templates with dynamic variables like {{name}} and {{code}} to send via the REST API."}
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={() => onOpenStudio(null, `*@${domainName}`)}
              className="rounded-lg bg-neutral-900 px-4 py-2 text-[13px] font-semibold text-white shadow-xs hover:bg-neutral-800 transition-colors cursor-pointer"
            >
              Create from scratch
            </button>
            <button
              onClick={() => setStartersModalOpen(true)}
              className="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-[13px] font-semibold text-neutral-700 hover:border-neutral-400 hover:text-neutral-900 transition-colors cursor-pointer"
            >
              Choose from starter presets →
            </button>
          </div>

          
          {!search && (
            <div className="mt-8 border-t border-neutral-100 pt-6">
              <p className="text-[11.5px] font-bold uppercase tracking-wider text-neutral-400">
                OR START WITH A POPULAR PRESET:
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {PRESET_TEMPLATES.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => handleCreateFromStarter(p)}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors cursor-pointer ${
                      p.id === "blank_canvas"
                        ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:border-emerald-600 hover:bg-emerald-100"
                        : "border-neutral-200 bg-neutral-50 text-neutral-700 hover:border-neutral-900 hover:bg-white hover:text-neutral-900"
                    }`}
                  >
                    <span>{p.id === "blank_canvas" ? "Blank Canvas (Start from zero)" : p.subject.replace(/\{\{[^}]+\}\}/g, "…")}</span>
                    <span className="font-mono text-[10px] opacity-70">({p.name})</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredTemplates.map((tpl) => {
            const isDomainWide = isDomainWideTemplate(tpl);
            const vars = extractVars(tpl.subject, tpl.html || tpl.text || "");

            return (
              <div
                key={tpl.id}
                className="group flex flex-col justify-between rounded-xl border border-neutral-200 bg-white p-5 shadow-2xs transition-all hover:border-neutral-400 hover:shadow-xs"
              >
                <div>
                  
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3
                        onClick={() => onOpenStudio(tpl)}
                        className="truncate font-mono text-[14px] font-bold text-neutral-900 hover:text-neutral-600 transition-colors cursor-pointer"
                        title={tpl.name}
                      >
                        {tpl.name}
                      </h3>
                      <p className="mt-1 line-clamp-1 text-[13px] font-medium text-neutral-700" title={tpl.subject}>
                        {tpl.subject || "(no subject)"}
                      </p>
                    </div>

                    <span
                      className={`shrink-0 rounded-md px-2 py-0.5 font-mono text-[10.5px] font-bold ${
                        isDomainWide
                          ? "bg-indigo-50 text-indigo-700 border border-indigo-100"
                          : "bg-neutral-100 text-neutral-700 border border-neutral-200"
                      }`}
                      title={isDomainWide ? "Usable by all mailboxes in domain" : `Restricted to ${tpl.mailbox}`}
                    >
                      {isDomainWide ? "Domain-wide" : tpl.mailbox.split("@")[0]}
                    </span>
                  </div>

                  
                  <div className="mt-3">
                    {vars.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {vars.map((v) => (
                          <span
                            key={v}
                            className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-neutral-700"
                          >
                            {"{{"}{v}{"}}"}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[11.5px] text-neutral-400">No dynamic variables</span>
                    )}
                  </div>
                </div>

                
                <div className="mt-5 border-t border-neutral-100 pt-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-neutral-400">
                      {tpl.updatedAt ? new Date(tpl.updatedAt).toLocaleDateString() : "Saved"}
                    </span>

                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleDuplicate(tpl)}
                        className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 cursor-pointer"
                        title="Duplicate template"
                      >
                        ❐
                      </button>
                      <button
                        onClick={() => handleDelete(tpl)}
                        className="rounded p-1 text-neutral-400 hover:bg-red-50 hover:text-red-600 cursor-pointer"
                        title="Delete template"
                      >
                        ✕
                      </button>
                      <button
                        onClick={() => onOpenStudio(tpl)}
                        className="rounded-lg bg-neutral-900 px-3 py-1 text-[12px] font-semibold text-white hover:bg-neutral-800 transition-colors cursor-pointer"
                      >
                        Edit →
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      
      {startersModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-100 pb-4">
              <div>
                <p className="font-mono text-[11px] font-bold uppercase tracking-wider text-neutral-400">
                  TEMPLATES LIBRARY
                </p>
                <h3 className="text-[20px] font-bold text-neutral-900">Choose a Starter Email Template</h3>
                <p className="text-[13px] text-neutral-500">
                  Select any pre-built template to instantly customize with your brand details.
                </p>
              </div>
              <button
                onClick={() => setStartersModalOpen(false)}
                className="rounded-lg p-2 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {PRESET_TEMPLATES.map((preset) => {
                const isBlank = preset.id === "blank_canvas";
                return (
                  <div
                    key={preset.id}
                    className={`flex flex-col justify-between rounded-xl border p-4 transition-all hover:shadow-md ${
                      isBlank
                        ? "border-emerald-300 bg-emerald-50/20 hover:border-emerald-600 ring-1 ring-emerald-200"
                        : "border-neutral-200 bg-white hover:border-neutral-900"
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span
                          className={`rounded px-2 py-0.5 font-mono text-[10.5px] font-bold ${
                            isBlank
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-neutral-100 text-neutral-700"
                          }`}
                        >
                          {isBlank ? "Start From Zero" : preset.category}
                        </span>
                        <span className="font-mono text-[11px] text-neutral-400">{preset.name}</span>
                      </div>
                      <h4 className="mt-2 text-[14.5px] font-bold text-neutral-900">
                        {isBlank ? "Blank Canvas (Clean Template)" : preset.subject}
                      </h4>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-neutral-500">{preset.description}</p>
                    </div>

                    <div className="mt-4 pt-3 border-t border-neutral-100 flex items-center justify-between">
                      <span className="text-[11px] text-neutral-400 font-mono">
                        {isBlank ? "Clean slate" : `${preset.blocks.length} sections`}
                      </span>
                      <button
                        onClick={() => handleCreateFromStarter(preset)}
                        className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors cursor-pointer ${
                          isBlank
                            ? "bg-emerald-600 text-white hover:bg-emerald-700"
                            : "bg-neutral-900 text-white hover:bg-neutral-800"
                        }`}
                      >
                        {isBlank ? "Start from zero →" : "Use template →"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
