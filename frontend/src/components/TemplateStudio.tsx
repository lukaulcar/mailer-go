import { useState, useMemo, useRef } from "react";
import {
  api,
  isDomainWideTemplate,
  getErrorMessage,
  type MailTemplate,
  type Mailbox,
} from "../lib/api";
import {
  type TemplateBlock,
  type TemplateTheme,
  DEFAULT_THEME,
  FONT_OPTIONS,
  PRESET_TEMPLATES,
  BLANK_TEMPLATE,
  compileVisualBlocksToHtml,
  extractVars,
  renderWithVars,
  htmlToPlainText,
} from "../lib/templatePresets";
import { useConfirm } from "../lib/confirm";
import { notify } from "../lib/toast";
import GmailPreview from "./GmailPreview";
import { CodeBlock, ErrorBox } from "./ui";
import HtmlCodeEditor from "./HtmlCodeEditor";

interface TemplateStudioProps {
  domainName: string;
  mailboxes: Mailbox[];
  initialTemplate?: MailTemplate | null;
  initialMailbox?: string | null;
  onBack: () => void;
  onSaved: (template: MailTemplate) => void;
  onDeleted?: (id: string) => void;
}

type EditorMode = "visual" | "code";
type PreviewDevice = "desktop" | "mobile";

const FIELD_LABEL = "block text-[11px] font-semibold text-neutral-600";
const STUDIO_INPUT = "mt-1 w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-[12.5px]";

export default function TemplateStudio({
  domainName,
  mailboxes,
  initialTemplate,
  initialMailbox,
  onBack,
  onSaved,
  onDeleted,
}: TemplateStudioProps) {
  const confirm = useConfirm();

  
  const [selectedId, setSelectedId] = useState<string | null>(initialTemplate?.id ?? null);
  const [name, setName] = useState(initialTemplate?.name ?? "");
  const [subject, setSubject] = useState(initialTemplate?.subject ?? "");
  const [scopeMailbox, setScopeMailbox] = useState<string>(() => {
    if (initialTemplate) {
      return isDomainWideTemplate(initialTemplate) ? "*@" + domainName : initialTemplate.mailbox;
    }
    if (initialMailbox && initialMailbox !== "*@" + domainName) {
      return initialMailbox;
    }
    return "*@" + domainName;
  });

  
  const [editorMode, setEditorMode] = useState<EditorMode>("visual");
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>("desktop");
  const [theme, setTheme] = useState<TemplateTheme>(() => {
    if (initialTemplate) {
      const match = PRESET_TEMPLATES.find((p) => p.name === initialTemplate.name);
      if (match) return { ...match.theme };
    }
    return { ...DEFAULT_THEME };
  });

  const [visualBlocks, setVisualBlocks] = useState<TemplateBlock[]>(() => {
    if (initialTemplate) {
      const match = PRESET_TEMPLATES.find((p) => p.name === initialTemplate.name);
      if (match) return JSON.parse(JSON.stringify(match.blocks));
    }
    return JSON.parse(JSON.stringify(BLANK_TEMPLATE.blocks));
  });

  const [htmlCode, setHtmlCode] = useState<string>(() => {
    if (initialTemplate?.html) return initialTemplate.html;
    return BLANK_TEMPLATE.html || compileVisualBlocksToHtml(BLANK_TEMPLATE.blocks, BLANK_TEMPLATE.theme);
  });

  const [plainText, setPlainText] = useState<string>(() => {
    if (initialTemplate?.text) return initialTemplate.text;
    return BLANK_TEMPLATE.text;
  });

  const [plainTextCustomized, setPlainTextCustomized] = useState(() => {
    if (initialTemplate?.text && initialTemplate?.html) {
      return initialTemplate.text.trim() !== htmlToPlainText(initialTemplate.html).trim();
    }
    return false;
  });

  const [showPlainText, setShowPlainText] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [apiDrawerOpen, setApiDrawerOpen] = useState(false);
  const [sendTestOpen, setSendTestOpen] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [sendingTest, setSendingTest] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const [sampleVars, setSampleVars] = useState<Record<string, string>>(() => ({
    name: "Alex Johnson",
    code: "839 204",
    company: domainName,
    expires_in: "10 minutes",
    amount: "$29.00",
    order_id: "MG-88492",
    date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    dashboard_url: `https://${domainName}/dashboard`,
  }));

  const lastCompiledFromVisual = useRef<string>("");

  function updateVisualBlocks(updater: (prev: TemplateBlock[]) => TemplateBlock[]) {
    setVisualBlocks((prev) => {
      const next = updater(prev);
      const compiled = compileVisualBlocksToHtml(next, theme);
      lastCompiledFromVisual.current = compiled;
      setHtmlCode(compiled);
      if (!plainTextCustomized) {
        setPlainText(htmlToPlainText(compiled));
      }
      return next;
    });
    setDirty(true);
  }

  function updateTheme(patch: Partial<TemplateTheme>) {
    setTheme((prev) => {
      const next = { ...prev, ...patch };
      const compiled = compileVisualBlocksToHtml(visualBlocks, next);
      lastCompiledFromVisual.current = compiled;
      setHtmlCode(compiled);
      if (!plainTextCustomized) {
        setPlainText(htmlToPlainText(compiled));
      }
      return next;
    });
    setDirty(true);
  }

  function handleHtmlCodeChange(val: string) {
    setHtmlCode(val);
    setPlainText(htmlToPlainText(val));
    setDirty(true);
  }

  function handlePlaintextAutoGenerate() {
    const text = htmlToPlainText(htmlCode);
    setPlainText(text);
    setPlainTextCustomized(false);
    setDirty(true);
    notify.success("Plain text fallback updated from HTML");
  }

  function applyPreset(preset: typeof PRESET_TEMPLATES[0]) {
    setVisualBlocks(JSON.parse(JSON.stringify(preset.blocks)));
    setTheme({ ...preset.theme });
    const compiled = compileVisualBlocksToHtml(preset.blocks, preset.theme);
    setHtmlCode(compiled);
    setPlainText(preset.text);
    setPlainTextCustomized(false);
    if (preset.id === "blank_canvas") {
      if (!selectedId) setName("");
      setSubject("");
    } else {
      if (!name.trim()) setName(preset.name);
      if (!subject.trim()) setSubject(preset.subject);
    }
    setSampleVars((prev) => ({ ...prev, ...preset.defaultVars }));
    setDirty(true);
    setLibraryOpen(false);
    notify.success(
      preset.id === "blank_canvas"
        ? "Loaded blank canvas — starting from zero"
        : `Loaded starter: ${preset.description.split("—")[0].slice(0, 30)}…`
    );
  }

  const detectedVars = useMemo(() => {
    return extractVars(subject, htmlCode);
  }, [subject, htmlCode]);

  const renderedSubject = useMemo(() => renderWithVars(subject, sampleVars), [subject, sampleVars]);
  const renderedHtml = useMemo(() => renderWithVars(htmlCode, sampleVars), [htmlCode, sampleVars]);

  async function handleGoBack() {
    if (dirty) {
      const ok = await confirm({
        title: "Discard unsaved changes?",
        message: "You have unsaved changes in this template. Are you sure you want to exit without saving?",
        confirmLabel: "Discard & Exit",
        danger: true,
      });
      if (!ok) return;
    }
    onBack();
  }

  async function handleSave() {
    const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    if (!cleanName || cleanName.length < 2) {
      setError("Please give the template a valid name (2+ alphanumeric characters or underscores, e.g. verify_code).");
      return;
    }
    if (!subject.trim()) {
      setError("Please enter a subject line for the email template.");
      return;
    }
    if (!htmlCode.trim()) {
      setError("HTML body cannot be empty.");
      return;
    }

    setSaving(true);
    setError(null);

    const effectiveText = plainTextCustomized && plainText.trim() ? plainText.trim() : htmlToPlainText(htmlCode);
    const targetScope = scopeMailbox.trim();

    try {
      let savedTpl: MailTemplate;
      if (selectedId) {
        savedTpl = await api.templates.update(selectedId, {
          name: cleanName,
          subject: subject.trim(),
          html: htmlCode,
          text: effectiveText,
          mailbox: targetScope,
        });
        notify.success(`Template "${cleanName}" saved successfully`);
      } else {
        savedTpl = await api.templates.create(domainName, {
          name: cleanName,
          subject: subject.trim(),
          html: htmlCode,
          text: effectiveText,
          mailbox: targetScope,
        });
        setSelectedId(savedTpl.id);
        notify.success(`Template "${cleanName}" created successfully`);
      }
      setDirty(false);
      onSaved(savedTpl);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to save template."));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selectedId) return;
    const ok = await confirm({
      title: "Delete template?",
      message: `Are you sure you want to permanently delete template "${name}"? This cannot be undone.`,
      confirmLabel: "Delete template",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.templates.remove(selectedId);
      notify.success("Template deleted");
      if (onDeleted) onDeleted(selectedId);
      onBack();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete template."));
    }
  }

  async function handleSendTest() {
    if (!testTo.trim() || !testTo.includes("@")) {
      setTestResult("Please enter a valid recipient email address.");
      return;
    }
    setSendingTest(true);
    setTestResult(null);

    const sender =
      scopeMailbox && !scopeMailbox.startsWith("*@")
        ? scopeMailbox
        : mailboxes[0]?.address || `noreply@${domainName}`;

    try {
      const renderedText = plainText.trim() ? renderWithVars(plainText, sampleVars) : htmlToPlainText(renderedHtml);
      await api.messages.send(
        sender,
        testTo.trim(),
        renderedSubject || `Test Email: ${name || "Template"}`,
        renderedText,
        renderedHtml,
      );
      setTestResult(`Test email sent successfully!`);
      notify.success(`Test email delivered to ${testTo.trim()}`);
    } catch (err) {
      setTestResult(`Failed to send test: ${getErrorMessage(err, "Unknown delivery error")}`);
    } finally {
      setSendingTest(false);
    }
  }


  function formatHtmlCode() {
    try {
      let indent = 0;
      const tab = "  ";
      const unformatted = htmlCode.replace(/>\s*</g, ">\n<").trim();
      const lines = unformatted.split("\n");
      const formattedLines = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return "";
        if (/^<\/[^>]+>/.test(trimmed)) {
          indent = Math.max(0, indent - 1);
        }
        const currentIndent = tab.repeat(indent);
        const isOpening =
          /^<[a-zA-Z0-9]+[^>]*>/.test(trimmed) &&
          !trimmed.includes("/>") &&
          !trimmed.startsWith("<!") &&
          !trimmed.startsWith("<!--");
        const hasClosingOnSameLine = /<[a-zA-Z0-9]+[^>]*>.*<\/[a-zA-Z0-9]+>/.test(trimmed);
        if (isOpening && !hasClosingOnSameLine) {
          indent++;
        }
        return currentIndent + trimmed;
      });
      setHtmlCode(formattedLines.join("\n"));
      setDirty(true);
      notify.success("HTML formatted");
    } catch {
    }
  }

  const [dragIdx, setDragIdx] = useState<number | null>(null);

  function moveBlock(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= visualBlocks.length || to >= visualBlocks.length) return;
    updateVisualBlocks((blocks) => {
      const copy = [...blocks];
      const [b] = copy.splice(from, 1);
      copy.splice(to, 0, b);
      return copy;
    });
  }

  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiRequest, setAiRequest] = useState("");

  function buildAiPrompt(): string {
    const varsLine =
      detectedVars.length > 0
        ? detectedVars.map((v) => `{{${v}}}`).join(", ")
        : "{{name}}, {{code}}, {{company}}";
    const bodyFont = FONT_OPTIONS.find((f) => f.value === theme.fontFamily)?.stack ?? theme.fontFamily;
    return `You are an expert transactional-email HTML developer. Generate a production-ready responsive email as a SINGLE self-contained HTML document.

Brand / domain: ${domainName}
Template: ${name.trim() || "new_template"}
Subject: ${subject.trim() || "(match this email)"}
Style: primary ${theme.primaryColor}, page ${theme.bgColor}, card ${theme.cardBgColor}, text ${theme.textColor}, body font ${bodyFont}, max-width ${theme.maxWidth}px, radius ${theme.borderRadius}.

What I want:
${aiRequest.trim() || "(describe your email here — content, look, buttons, links...)"}

Variables (keep EXACTLY as {{snake_case}}, never rename or escape): ${varsLine}. You may add new {{snake_case}} variables only if needed. Example: <p>Hi {{name}}, your code is {{code}}.</p>

Rules: table-based layout only (role="presentation" tables), inline styles on every element, no <style>/<script>/external fonts, max-width ${theme.maxWidth}px centered card, bulletproof <a> buttons, include header, message, CTA, footer with ${domainName} + unsubscribe/support links.

Return ONLY the complete HTML starting with <!DOCTYPE html> — no explanations, no markdown fences — so I can paste it into my editor and save.`;
  }

  async function copyAiPrompt() {
    try {
      await navigator.clipboard.writeText(buildAiPrompt());
      notify.success("AI prompt copied — paste it into ChatGPT / Gemini / Claude");
      setAiModalOpen(false);
    } catch {
      notify.error("Copy failed — your browser blocked clipboard access.");
    }
  }

  const cleanTemplateSlug = (name.trim() || "verify_code").replace(/[^a-zA-Z0-9_-]/g, "_");
  const varsPayloadObj: Record<string, string> = {};
  for (const v of detectedVars) varsPayloadObj[v] = sampleVars[v] ?? v;
  const varsJsonPayload =
    detectedVars.length > 0 ? `, "vars": ${JSON.stringify(varsPayloadObj)}` : "";
  const templateJsonValue = JSON.stringify(cleanTemplateSlug);

  const effectiveSenderExample =
    scopeMailbox && !scopeMailbox.startsWith("*@") ? scopeMailbox : `hello@${domainName}`;
  const senderJsonValue = JSON.stringify(effectiveSenderExample);

  const curlSnippet = `curl -X POST https:
  -H "Authorization: Bearer mg_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": ${senderJsonValue},
    "to": "customer@example.com",
    "template": ${templateJsonValue}${varsJsonPayload}
  }'`;

  const nodeSnippet = `import fetch from "node-fetch";

await fetch("https://mailer.lukaulcar.com/v1/send", {
  method: "POST",
  headers: {
    "Authorization": "Bearer " + process.env.MAILERGO_API_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    from: ${senderJsonValue},
    to: "customer@example.com",
    template: ${templateJsonValue}${varsJsonPayload}
  })
});`;

  const pythonSnippet = `import requests, os

resp = requests.post(
    "https://mailer.lukaulcar.com/v1/send",
    headers={"Authorization": f"Bearer {os.environ['MAILERGO_API_KEY']}"},
    json={
        "from": ${senderJsonValue},
        "to": "customer@example.com",
        "template": ${templateJsonValue}${varsJsonPayload}
    }
)
print(resp.json())`;

  return (
    <div className="min-h-[85vh] flex flex-col">
      
      <div className="sticky top-14 z-20 -mx-4 -mt-6 border-b border-neutral-200 bg-white/95 px-4 py-3 backdrop-blur-md md:-mx-6 md:px-6">
        <div className="mx-auto flex flex-wrap items-center justify-between gap-3">
          
          <div className="flex items-center gap-1.5 text-[12.5px]">
            <button
              type="button"
              onClick={handleGoBack}
              className="font-medium text-neutral-500 hover:text-neutral-900 cursor-pointer"
            >
              Domains
            </button>
            <span className="text-neutral-300">/</span>
            <button
              type="button"
              onClick={handleGoBack}
              className="font-medium text-neutral-500 hover:text-neutral-900 cursor-pointer"
            >
              {domainName}
            </button>
            <span className="text-neutral-300">/</span>
            <button
              type="button"
              onClick={handleGoBack}
              className="font-medium text-neutral-500 hover:text-neutral-900 cursor-pointer"
            >
              Templates
            </button>
            <span className="text-neutral-300">/</span>
            <span className="font-mono font-semibold text-neutral-900">
              {name.trim() || "(untitled template)"}
            </span>
            {dirty ? (
              <span className="ml-1.5 rounded-full bg-amber-100 px-2 py-0.5 font-mono text-[10.5px] font-bold text-amber-800">
                unsaved changes
              </span>
            ) : selectedId ? (
              <span className="ml-1.5 rounded-full bg-emerald-50 px-2 py-0.5 font-mono text-[10.5px] font-bold text-emerald-700">
                saved ✓
              </span>
            ) : null}
          </div>

          
          <div className="flex items-center rounded-lg border border-neutral-200 bg-neutral-100/80 p-0.5">
            <button
              type="button"
              onClick={() => setEditorMode("visual")}
              className={`flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[12px] font-semibold transition-all cursor-pointer ${
                editorMode === "visual"
                  ? "bg-white text-neutral-900 shadow-xs"
                  : "text-neutral-600 hover:text-neutral-900"
              }`}
            >
              <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
                <rect x="3" y="3" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
                <rect x="11" y="3" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
                <rect x="3" y="11" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
                <rect x="11" y="11" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
              </svg>
              <span>Visual Builder</span>
            </button>
            <button
              type="button"
              onClick={() => setEditorMode("code")}
              className={`flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[12px] font-semibold transition-all cursor-pointer ${
                editorMode === "code"
                  ? "bg-white text-neutral-900 shadow-xs"
                  : "text-neutral-600 hover:text-neutral-900"
              }`}
            >
              <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
                <path d="M7 6 3 10l4 4M13 6l4 4-4 4M11 4l-2 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>HTML Code</span>
            </button>
          </div>

          
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLibraryOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-neutral-700 hover:border-neutral-400 hover:text-neutral-900 transition-colors cursor-pointer"
              title="Pick a pre-designed email template starter"
            >
              <span>Template Library</span>
              <span className="rounded bg-neutral-100 px-1 font-mono text-[10px] text-neutral-500">{PRESET_TEMPLATES.length}</span>
            </button>
            <button
              onClick={() => setSendTestOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-neutral-700 hover:border-neutral-400 hover:text-neutral-900 transition-colors cursor-pointer"
            >
              <span>Send Test</span>
            </button>
            <button
              onClick={() => setApiDrawerOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-neutral-700 hover:border-neutral-400 hover:text-neutral-900 transition-colors cursor-pointer"
            >
              <span>Use via API</span>
            </button>
            {selectedId && (
              <button
                onClick={handleDelete}
                className="rounded-lg border border-red-200 bg-red-50/50 px-2.5 py-1.5 text-[12.5px] font-semibold text-red-600 hover:bg-red-100 hover:text-red-700 transition-colors cursor-pointer"
                title="Delete template"
              >
                Delete
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded-lg bg-neutral-900 px-4 py-1.5 text-[12.5px] font-semibold text-white shadow-xs transition-all hover:bg-neutral-800 disabled:opacity-50 cursor-pointer"
            >
              {saving ? "Saving…" : selectedId ? "Save changes" : "Create template"}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-4">
          <ErrorBox onDismiss={() => setError(null)} title="Template Error">
            {error}
          </ErrorBox>
        </div>
      )}

      
      <div className="mt-4 grid flex-1 items-start gap-6 lg:grid-cols-12">
        
        <div className="lg:col-span-7 space-y-4">
          
          <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-xs">
            <div className="grid gap-4 sm:grid-cols-2">
              
              <div>
                <label className="block text-[12.5px] font-bold text-neutral-800">
                  Template ID / Name <span className="text-red-500">*</span>
                </label>
                <div className="mt-1.5 flex items-center rounded-lg border border-neutral-200 bg-neutral-50/60 px-3 py-2 focus-within:border-neutral-900 focus-within:bg-white transition-colors">
                  <span className="font-mono text-[12px] text-neutral-400 select-none mr-1">template:</span>
                  <input
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value.toLowerCase().replace(/\s+/g, "_"));
                      setDirty(true);
                    }}
                    placeholder="welcome_email"
                    className="w-full bg-transparent font-mono text-[13px] font-semibold text-neutral-900 focus:outline-none"
                  />
                </div>
                <p className="mt-1 text-[11px] text-neutral-400">Used as identifier in API payload: <code className="font-mono text-neutral-600">"template": "{name || "name"}"</code></p>
              </div>

              
              <div>
                <label className="block text-[12.5px] font-bold text-neutral-800">
                  Availability / Scope
                </label>
                <select
                  value={scopeMailbox}
                  onChange={(e) => {
                    setScopeMailbox(e.target.value);
                    setDirty(true);
                  }}
                  className="mt-1.5 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-[13px] font-medium text-neutral-800 focus:border-neutral-900 focus:outline-none"
                >
                  <option value={`*@${domainName}`}>All mailboxes in {domainName} (Domain-wide)</option>
                  {mailboxes.map((mb) => (
                    <option key={mb.address} value={mb.address}>
                      Only {mb.address}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-neutral-400">
                  {scopeMailbox.startsWith("*@")
                    ? "✓ Any sender address under this domain can send this template"
                    : `Scoped strictly to ${scopeMailbox}`}
                </p>
              </div>
            </div>

            
            <div className="mt-4">
              <div>
                <label className="block text-[12.5px] font-bold text-neutral-800">
                  Subject Line <span className="text-red-500">*</span>
                </label>
              </div>
              <input
                value={subject}
                onChange={(e) => {
                  setSubject(e.target.value);
                  setDirty(true);
                }}
                placeholder="e.g. Welcome to {{company}}, {{name}}!"
                className="mt-1.5 w-full rounded-lg border border-neutral-200 bg-white px-3.5 py-2 text-[13.5px] font-medium text-neutral-900 focus:border-neutral-900 focus:outline-none"
              />
            </div>
          </div>

          
          {editorMode === "visual" && (
            <div className="space-y-4">
              
              <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-xs">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-bold text-neutral-700">Theme Styling:</span>
                    <div className="flex items-center gap-1.5">
                      {[
                        { label: "Obsidian", color: "#0f172a" },
                        { label: "Indigo", color: "#4f46e5" },
                        { label: "Emerald", color: "#059669" },
                        { label: "Blue", color: "#2563eb" },
                        { label: "Rose", color: "#e11d48" },
                        { label: "Violet", color: "#7c3aed" },
                      ].map((t) => (
                        <button
                          key={t.color}
                          type="button"
                          onClick={() => updateTheme({ primaryColor: t.color })}
                          title={t.label}
                          className={`h-5 w-5 rounded-full border transition-all cursor-pointer ${
                            theme.primaryColor === t.color ? "ring-2 ring-neutral-900 ring-offset-1 scale-110" : "opacity-80 hover:opacity-100"
                          }`}
                          style={{ backgroundColor: t.color, borderColor: "rgba(0,0,0,0.1)" }}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 text-[12px]">
                    <label className="flex items-center gap-1.5 text-neutral-600 font-medium">
                      <span>Font:</span>
                      <select
                        value={FONT_OPTIONS.some((f) => f.value === theme.fontFamily) ? theme.fontFamily : "sans"}
                        onChange={(e) => updateTheme({ fontFamily: e.target.value as any })}
                        className="rounded border border-neutral-200 bg-white px-2 py-1 text-[11.5px] font-medium text-neutral-800"
                      >
                        {FONT_OPTIONS.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="flex items-center gap-1.5 text-neutral-600 font-medium">
                      <span>Radius:</span>
                      <select
                        value={theme.borderRadius}
                        onChange={(e) => updateTheme({ borderRadius: e.target.value as any })}
                        className="rounded border border-neutral-200 bg-white px-2 py-1 text-[11.5px] font-medium text-neutral-800"
                      >
                        <option value="rounded">Rounded</option>
                        <option value="curved">Curved (Pill)</option>
                        <option value="sharp">Sharp</option>
                      </select>
                    </label>
                  </div>
                </div>
              </div>

              
              <div className="space-y-3">
                <div className="flex items-center justify-between px-1">
                  <p className="font-mono text-[11px] font-bold tracking-wider uppercase text-neutral-400">
                    EMAIL SECTIONS & CONTENT BLOCKS ({visualBlocks.length})
                  </p>
                  <div className="flex items-center gap-3">
                    {visualBlocks.length > 0 && (
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await confirm({
                            title: "Clear all sections?",
                            message: "This will remove all content blocks and give you a completely empty template starting from zero.",
                            confirmLabel: "Clear all blocks",
                            danger: true,
                          });
                          if (!ok) return;
                          updateVisualBlocks(() => []);
                          notify.success("All sections cleared — blank canvas");
                        }}
                        className="text-[11.5px] font-semibold text-neutral-400 hover:text-red-600 cursor-pointer transition-colors"
                      >
                        Clear all (start from zero)
                      </button>
                    )}
                    <p className="text-[11.5px] text-neutral-500">Drag ⋮⋮ or use ↑ ↓ to reorder</p>
                  </div>
                </div>

                {visualBlocks.map((block, idx) => (
                  <div
                    key={block.id}
                    onDragOver={(e) => {
                      if (dragIdx !== null && dragIdx !== idx) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragIdx !== null && dragIdx !== idx) {
                        moveBlock(dragIdx, idx);
                        setDragIdx(null);
                      }
                    }}
                    className={`group relative rounded-xl border bg-white p-4 transition-all shadow-xs ${
                      dragIdx === idx ? "border-neutral-900 opacity-60" : "border-neutral-200 hover:border-neutral-300"
                    }`}
                  >
                    
                    <div className="mb-3 flex items-center justify-between border-b border-neutral-100 pb-2">
                      <div className="flex items-center gap-2">
                        <span
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = "move";
                            setDragIdx(idx);
                          }}
                          onDragEnd={() => setDragIdx(null)}
                          title="Drag to reorder"
                          className="grid h-5 w-6 cursor-grab place-items-center rounded bg-neutral-100 font-mono text-[11px] font-bold text-neutral-500 hover:text-neutral-900 active:cursor-grabbing"
                        >
                          ⋮⋮
                        </span>
                        <span className="grid h-5 w-5 place-items-center rounded bg-neutral-100 font-mono text-[10px] font-bold text-neutral-600">
                          {idx + 1}
                        </span>
                        <span className="font-mono text-[11.5px] font-bold uppercase tracking-wide text-neutral-800">
                          {block.type}
                        </span>
                      </div>

                      
                      <div className="flex items-center gap-1 opacity-70 group-hover:opacity-100 transition-opacity">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => moveBlock(idx, idx - 1)}
                          className="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-30 cursor-pointer"
                          title="Move Up"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={idx === visualBlocks.length - 1}
                          onClick={() => moveBlock(idx, idx + 1)}
                          className="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-30 cursor-pointer"
                          title="Move Down"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            updateVisualBlocks((blocks) => {
                              const copy = [...blocks];
                              const dup = JSON.parse(JSON.stringify(block));
                              dup.id = `${dup.type}-${Date.now()}`;
                              copy.splice(idx + 1, 0, dup);
                              return copy;
                            })
                          }
                          className="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 cursor-pointer"
                          title="Duplicate Section"
                        >
                          ❐
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            updateVisualBlocks((blocks) => blocks.filter((_, i) => i !== idx))
                          }
                          className="rounded p-1 text-red-500 hover:bg-red-50 hover:text-red-700 cursor-pointer"
                          title="Delete Section"
                        >
                          ✕
                        </button>
                      </div>
                    </div>

                    
                    {block.type === "header" && (
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div>
                          <label className={FIELD_LABEL}>Brand Name</label>
                          <input
                            value={block.brandName}
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "header" ? { ...b, brandName: e.target.value } : b))
                              )
                            }
                            className={STUDIO_INPUT}
                          />
                        </div>
                        <div>
                          <label className={FIELD_LABEL}>Logo Image URL (Optional)</label>
                          <input
                            value={block.logoUrl ?? ""}
                            placeholder="https://.../logo.png"
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "header" ? { ...b, logoUrl: e.target.value } : b))
                              )
                            }
                            className={STUDIO_INPUT}
                          />
                        </div>
                        <div>
                          <label className={FIELD_LABEL}>Badge Text (Optional)</label>
                          <input
                            value={block.badgeText ?? ""}
                            placeholder="Security, New, etc."
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "header" ? { ...b, badgeText: e.target.value } : b))
                              )
                            }
                            className={STUDIO_INPUT}
                          />
                        </div>
                      </div>
                    )}
                    {block.type === "header" && (
                      <div className="mt-2 flex items-center gap-2">
                        <label className={FIELD_LABEL}>Align:</label>
                        <select
                          value={block.align}
                          onChange={(e) =>
                            updateVisualBlocks((blocks) =>
                              blocks.map((b, i) => (i === idx && b.type === "header" ? { ...b, align: e.target.value as any } : b))
                            )
                          }
                          className="rounded-md border border-neutral-200 px-2 py-1 text-[12px]"
                        >
                          <option value="left">Left</option>
                          <option value="center">Center</option>
                        </select>
                      </div>
                    )}

                    {block.type === "hero" && (
                      <div className="space-y-2.5">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <label className={FIELD_LABEL}>Eyebrow / Category</label>
                            <input
                              value={block.eyebrow ?? ""}
                              placeholder="Account Security, Welcome, etc."
                              onChange={(e) =>
                                updateVisualBlocks((blocks) =>
                                  blocks.map((b, i) => (i === idx && b.type === "hero" ? { ...b, eyebrow: e.target.value } : b))
                                )
                              }
                              className={STUDIO_INPUT}
                            />
                          </div>
                          <div>
                            <label className={FIELD_LABEL}>Alignment</label>
                            <select
                              value={block.align}
                              onChange={(e) =>
                                updateVisualBlocks((blocks) =>
                                  blocks.map((b, i) => (i === idx && b.type === "hero" ? { ...b, align: e.target.value as any } : b))
                                )
                              }
                              className={STUDIO_INPUT}
                            >
                              <option value="left">Left Aligned</option>
                              <option value="center">Center Aligned</option>
                            </select>
                          </div>
                        </div>
                        <div>
                          <label className={FIELD_LABEL}>Main Title</label>
                          <input
                            value={block.title}
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "hero" ? { ...b, title: e.target.value } : b))
                              )
                            }
                            className="mt-1 w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-[13.5px] font-bold"
                          />
                        </div>
                        <div>
                          <label className={FIELD_LABEL}>Subtitle</label>
                          <input
                            value={block.subtitle ?? ""}
                            placeholder="Brief description below title"
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "hero" ? { ...b, subtitle: e.target.value } : b))
                              )
                            }
                            className={`${STUDIO_INPUT} text-neutral-600`}
                          />
                        </div>
                      </div>
                    )}

                    {block.type === "text" && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <label className={FIELD_LABEL}>
                            Body Paragraph Content (Markdown / Variables supported)
                          </label>
                        </div>
                        <textarea
                          rows={3}
                          value={block.content}
                          onChange={(e) =>
                            updateVisualBlocks((blocks) =>
                              blocks.map((b, i) => (i === idx && b.type === "text" ? { ...b, content: e.target.value } : b))
                            )
                          }
                          className="w-full rounded-md border border-neutral-200 p-2.5 text-[13px] leading-relaxed text-neutral-900 focus:border-neutral-900 focus:outline-none"
                        />
                        <div className="flex flex-wrap items-center gap-3">
                          <label className="flex items-center gap-1.5 text-[11px] font-semibold text-neutral-600">
                            Size:
                            <select
                              value={block.fontSize}
                              onChange={(e) =>
                                updateVisualBlocks((blocks) =>
                                  blocks.map((b, i) => (i === idx && b.type === "text" ? { ...b, fontSize: e.target.value as any } : b))
                                )
                              }
                              className="rounded-md border border-neutral-200 px-2 py-1 text-[12px]"
                            >
                              <option value="sm">Small</option>
                              <option value="base">Medium</option>
                              <option value="lg">Large</option>
                            </select>
                          </label>
                          <label className="flex items-center gap-1.5 text-[11px] font-semibold text-neutral-600">
                            Align:
                            <select
                              value={block.align ?? "left"}
                              onChange={(e) =>
                                updateVisualBlocks((blocks) =>
                                  blocks.map((b, i) => (i === idx && b.type === "text" ? { ...b, align: e.target.value as any } : b))
                                )
                              }
                              className="rounded-md border border-neutral-200 px-2 py-1 text-[12px]"
                            >
                              <option value="left">Left</option>
                              <option value="center">Center</option>
                              <option value="right">Right</option>
                            </select>
                          </label>
                        </div>
                      </div>
                    )}

                    {block.type === "button" && (
                      <div className="space-y-2">
                        <div className="grid gap-3 sm:grid-cols-3">
                        <div>
                          <label className={FIELD_LABEL}>Button Label</label>
                          <input
                            value={block.text}
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "button" ? { ...b, text: e.target.value } : b))
                              )
                            }
                            className={`${STUDIO_INPUT} font-semibold`}
                          />
                        </div>
                        <div>
                          <label className={FIELD_LABEL}>Destination URL</label>
                          <input
                            value={block.url}
                            placeholder="https://... or {{link}}"
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "button" ? { ...b, url: e.target.value } : b))
                              )
                            }
                            className={`${STUDIO_INPUT} font-mono`}
                          />
                        </div>
                        <div>
                          <label className={FIELD_LABEL}>Button Style</label>
                          <select
                            value={block.colorTheme}
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "button" ? { ...b, colorTheme: e.target.value as any } : b))
                              )
                            }
                            className={STUDIO_INPUT}
                          >
                            <option value="primary">Theme Primary Color</option>
                            <option value="emerald">Emerald Green</option>
                            <option value="indigo">Indigo</option>
                            <option value="dark">Solid Dark</option>
                            <option value="outline">Clean Outline</option>
                          </select>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <label className={FIELD_LABEL}>Align:</label>
                        <select
                          value={block.align}
                          onChange={(e) =>
                            updateVisualBlocks((blocks) =>
                              blocks.map((b, i) => (i === idx && b.type === "button" ? { ...b, align: e.target.value as any } : b))
                            )
                          }
                          className="rounded-md border border-neutral-200 px-2 py-1 text-[12px]"
                        >
                          <option value="left">Left</option>
                          <option value="center">Center</option>
                          <option value="full">Full width</option>
                        </select>
                      </div>
                      </div>
                    )}

                    {block.type === "otp" && (
                      <div className="space-y-2.5">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <label className={FIELD_LABEL}>OTP Code Variable</label>
                            <input
                              value={block.codeVar}
                              onChange={(e) =>
                                updateVisualBlocks((blocks) =>
                                  blocks.map((b, i) => (i === idx && b.type === "otp" ? { ...b, codeVar: e.target.value } : b))
                                )
                              }
                              className="mt-1 w-full rounded-md border border-neutral-200 px-2.5 py-1.5 font-mono text-[13px] font-bold text-center"
                            />
                          </div>
                          <div>
                            <label className={FIELD_LABEL}>Expiry Notice</label>
                            <input
                              value={block.expiryText ?? ""}
                              placeholder="This code expires in 10 minutes."
                              onChange={(e) =>
                                updateVisualBlocks((blocks) =>
                                  blocks.map((b, i) => (i === idx && b.type === "otp" ? { ...b, expiryText: e.target.value } : b))
                                )
                              }
                              className={STUDIO_INPUT}
                            />
                          </div>
                        </div>
                        <div>
                          <label className={FIELD_LABEL}>Security Warning</label>
                          <input
                            value={block.securityNotice ?? ""}
                            placeholder="Never share this code with anyone."
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "otp" ? { ...b, securityNotice: e.target.value } : b))
                              )
                            }
                            className="mt-1 w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-[12px] text-neutral-500"
                          />
                        </div>
                      </div>
                    )}

                    {block.type === "callout" && (
                      <div className="space-y-3">
                        <div>
                          <label className={FIELD_LABEL}>Title (optional)</label>
                          <input
                            value={block.title ?? ""}
                            placeholder="e.g. Didn't request this?"
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "callout" ? { ...b, title: e.target.value } : b))
                              )
                            }
                            className={`${STUDIO_INPUT} font-semibold`}
                          />
                        </div>
                        <div className="grid gap-3 sm:grid-cols-3">
                        <div>
                          <label className={FIELD_LABEL}>Variant</label>
                          <select
                            value={block.variant}
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "callout" ? { ...b, variant: e.target.value as any } : b))
                              )
                            }
                            className={STUDIO_INPUT}
                          >
                            <option value="info">Info (Blue)</option>
                            <option value="success">Success (Green)</option>
                            <option value="warning">Warning (Amber)</option>
                            <option value="neutral">Neutral (Slate)</option>
                          </select>
                        </div>
                        <div className="sm:col-span-2">
                          <label className={FIELD_LABEL}>Callout Text</label>
                          <input
                            value={block.text}
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "callout" ? { ...b, text: e.target.value } : b))
                              )
                            }
                            className={STUDIO_INPUT}
                          />
                        </div>
                        </div>
                      </div>
                    )}

                    {block.type === "keyvalue" && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <label className={FIELD_LABEL}>Key-Value Items</label>
                          <button
                            type="button"
                            onClick={() =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) =>
                                  i === idx && b.type === "keyvalue"
                                    ? { ...b, items: [...b.items, { key: "Item", value: "{{value}}" }] }
                                    : b
                                )
                              )
                            }
                            className="text-[11px] font-semibold text-neutral-800 hover:underline cursor-pointer"
                          >
                            + Add Item
                          </button>
                        </div>
                        {block.items.map((it, itemIdx) => (
                          <div key={itemIdx} className="flex items-center gap-2">
                            <input
                              value={it.key}
                              placeholder="Label"
                              onChange={(e) =>
                                updateVisualBlocks((blocks) =>
                                  blocks.map((b, i) => {
                                    if (i !== idx || b.type !== "keyvalue") return b;
                                    const nextItems = [...b.items];
                                    nextItems[itemIdx].key = e.target.value;
                                    return { ...b, items: nextItems };
                                  })
                                )
                              }
                              className="w-1/2 rounded-md border border-neutral-200 px-2 py-1 text-[12px]"
                            />
                            <input
                              value={it.value}
                              placeholder="Value or {{var}}"
                              onChange={(e) =>
                                updateVisualBlocks((blocks) =>
                                  blocks.map((b, i) => {
                                    if (i !== idx || b.type !== "keyvalue") return b;
                                    const nextItems = [...b.items];
                                    nextItems[itemIdx].value = e.target.value;
                                    return { ...b, items: nextItems };
                                  })
                                )
                              }
                              className="w-1/2 rounded-md border border-neutral-200 px-2 py-1 text-[12px] font-mono"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                updateVisualBlocks((blocks) =>
                                  blocks.map((b, i) => {
                                    if (i !== idx || b.type !== "keyvalue") return b;
                                    return { ...b, items: b.items.filter((_, k) => k !== itemIdx) };
                                  })
                                )
                              }
                              className="p-1 text-red-500 hover:text-red-700 cursor-pointer"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {block.type === "divider" && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <label className={FIELD_LABEL}>Spacing</label>
                          <select
                            value={block.spacing}
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "divider" ? { ...b, spacing: e.target.value as any } : b))
                              )
                            }
                            className={STUDIO_INPUT}
                          >
                            <option value="sm">Tight</option>
                            <option value="md">Normal</option>
                            <option value="lg">Loose</option>
                          </select>
                        </div>
                        <div>
                          <label className={FIELD_LABEL}>Line style</label>
                          <select
                            value={block.lineStyle ?? "solid"}
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "divider" ? { ...b, lineStyle: e.target.value as any } : b))
                              )
                            }
                            className={STUDIO_INPUT}
                          >
                            <option value="solid">Line</option>
                            <option value="dashed">Dashed</option>
                            <option value="dots">Dots ● ● ●</option>
                          </select>
                        </div>
                      </div>
                    )}

                    {block.type === "footer" && (
                      <div className="space-y-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <label className={FIELD_LABEL}>Company Name</label>
                          <input
                            value={block.companyName}
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "footer" ? { ...b, companyName: e.target.value } : b))
                              )
                            }
                            className={STUDIO_INPUT}
                          />
                        </div>
                        <div>
                          <label className={FIELD_LABEL}>Support Email</label>
                          <input
                            value={block.supportEmail ?? ""}
                            placeholder="support@example.com"
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "footer" ? { ...b, supportEmail: e.target.value } : b))
                              )
                            }
                            className={STUDIO_INPUT}
                          />
                        </div>
                      </div>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <div>
                          <label className={FIELD_LABEL}>Address (optional)</label>
                          <input
                            value={block.address ?? ""}
                            placeholder="Street, City"
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "footer" ? { ...b, address: e.target.value } : b))
                              )
                            }
                            className={STUDIO_INPUT}
                          />
                        </div>
                        <div>
                          <label className={FIELD_LABEL}>Unsubscribe URL (optional)</label>
                          <input
                            value={block.unsubscribeUrl ?? ""}
                            placeholder="https://.../unsubscribe"
                            onChange={(e) =>
                              updateVisualBlocks((blocks) =>
                                blocks.map((b, i) => (i === idx && b.type === "footer" ? { ...b, unsubscribeUrl: e.target.value } : b))
                              )
                            }
                            className="mt-1 w-full rounded-md border border-neutral-200 px-2.5 py-1.5 font-mono text-[12.5px]"
                          />
                        </div>
                      </div>
                      </div>
                    )}
                  </div>
                ))}

                
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-neutral-300 bg-neutral-50/70 p-4">
                  <span className="text-[12px] font-bold text-neutral-600 mr-2">+ Add Section:</span>
                  {[
                    { label: "Text Block", type: "text" },
                    { label: "CTA Button", type: "button" },
                    { label: "OTP Code Box", type: "otp" },
                    { label: "Callout Alert", type: "callout" },
                    { label: "Table / Items", type: "keyvalue" },
                    { label: "Divider", type: "divider" },
                    { label: "Footer", type: "footer" },
                  ].map((s) => (
                    <button
                      key={s.type}
                      type="button"
                      onClick={() => {
                        let newBlock: TemplateBlock;
                        if (s.type === "text") {
                          newBlock = { type: "text", id: `txt-${Date.now()}`, content: "Write your custom message here…", fontSize: "base" };
                        } else if (s.type === "button") {
                          newBlock = { type: "button", id: `btn-${Date.now()}`, text: "Click Here →", url: "https://example.com", colorTheme: "primary", align: "center", borderRadius: "rounded" };
                        } else if (s.type === "otp") {
                          newBlock = { type: "otp", id: `otp-${Date.now()}`, codeVar: "{{code}}", expiryText: "Expires in 10 minutes." };
                        } else if (s.type === "callout") {
                          newBlock = { type: "callout", id: `call-${Date.now()}`, variant: "info", text: "Important notice: please review your account settings." };
                        } else if (s.type === "keyvalue") {
                          newBlock = { type: "keyvalue", id: `kv-${Date.now()}`, items: [{ key: "Details", value: "{{details}}" }] };
                        } else if (s.type === "divider") {
                          newBlock = { type: "divider", id: `div-${Date.now()}`, spacing: "md" };
                        } else {
                          newBlock = { type: "footer", id: `ft-${Date.now()}`, companyName: domainName, supportEmail: `support@${domainName}` };
                        }
                        updateVisualBlocks((blocks) => [...blocks, newBlock]);
                      }}
                      className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-[11.5px] font-semibold text-neutral-700 shadow-2xs hover:border-neutral-900 hover:text-neutral-900 transition-colors cursor-pointer"
                    >
                      + {s.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          
          {editorMode === "code" && (
            <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-xs">
              
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 pb-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-neutral-400">
                    HTML EMAIL SOURCE
                  </span>
                  <span className="font-mono text-[11px] text-neutral-400 tabular-nums">
                    {htmlCode.length} chars
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={formatHtmlCode}
                    className="ml-2 rounded border border-neutral-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-neutral-600 hover:border-neutral-900 hover:text-neutral-900 cursor-pointer"
                    title="Clean and re-indent HTML"
                  >
                    Format HTML
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Reset HTML to blank template?",
                        message: "This will replace the HTML editor content with clean, minimal boilerplate starting from zero.",
                        confirmLabel: "Clear to Blank",
                        danger: false,
                      });
                      if (!ok) return;
                      const blankHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Email</title>
</head>
<body style="margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #0f172a;">
  <p>Start writing your custom HTML here...</p>
</body>
</html>`;
                      setHtmlCode(blankHtml);
                      if (!plainTextCustomized) {
                        setPlainText("Start writing your custom HTML here...");
                      }
                      setDirty(true);
                      notify.success("Reset HTML to blank template (started from zero)");
                    }}
                    className="ml-1 rounded border border-neutral-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-neutral-600 hover:border-neutral-900 hover:text-neutral-900 cursor-pointer"
                    title="Reset HTML to clean minimal boilerplate starting from zero"
                  >
                    Clear to Blank
                  </button>
                  <button
                    type="button"
                    onClick={() => setAiModalOpen(true)}
                    className="ml-1 rounded border border-neutral-900 bg-neutral-900 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-neutral-700 cursor-pointer"
                    title="Describe your email, get a prompt for ChatGPT / Gemini / Claude — paste their HTML back here"
                  >
                    Make with AI
                  </button>
                </div>
              </div>

              
              <HtmlCodeEditor
                value={htmlCode}
                onChange={handleHtmlCodeChange}
                placeholder="<!DOCTYPE html><html>...</html>"
              />

              
              <div className="mt-3 border-t border-neutral-100 pt-3">
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setShowPlainText((v) => !v)}
                    className="text-[12.5px] font-semibold text-neutral-600 hover:text-neutral-900 cursor-pointer"
                  >
                    {showPlainText ? "▾ Plain-text fallback" : "▸ Plain-text fallback (click to expand)"}
                  </button>
                  {showPlainText && (
                    <button
                      type="button"
                      onClick={handlePlaintextAutoGenerate}
                      className="text-[11.5px] font-semibold text-neutral-500 hover:text-neutral-900 cursor-pointer"
                    >
                      ↻ Auto-generate from HTML
                    </button>
                  )}
                </div>
                {showPlainText && (
                  <textarea
                    value={plainText}
                    onChange={(e) => {
                      setPlainText(e.target.value);
                      setPlainTextCustomized(true);
                      setDirty(true);
                    }}
                    rows={6}
                    placeholder="Plain-text version for email clients that do not render HTML..."
                    className="mt-2 w-full rounded-lg border border-neutral-200 bg-white p-3 font-mono text-[12.5px] leading-relaxed text-neutral-900 focus:border-neutral-900 focus:outline-none"
                  />
                )}
              </div>
            </div>
          )}
        </div>

        
        <div className="lg:col-span-5 lg:sticky lg:top-24 space-y-4">
          
          <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-mono text-[11px] font-bold uppercase tracking-wider text-neutral-400">
                  REAL-TIME PREVIEW
                </p>
                <p className="text-[12px] text-neutral-500">Rendered with active test variables</p>
              </div>

              <div className="flex items-center gap-1 rounded-lg border border-neutral-200 bg-neutral-100/70 p-0.5">
                <button
                  type="button"
                  onClick={() => setPreviewDevice("desktop")}
                  className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold cursor-pointer transition-all ${
                    previewDevice === "desktop" ? "bg-white text-neutral-900 shadow-2xs" : "text-neutral-600 hover:text-neutral-900"
                  }`}
                >
                  Desktop (600px)
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewDevice("mobile")}
                  className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold cursor-pointer transition-all ${
                    previewDevice === "mobile" ? "bg-white text-neutral-900 shadow-2xs" : "text-neutral-600 hover:text-neutral-900"
                  }`}
                >
                  Mobile (375px)
                </button>
              </div>
            </div>

            
            {detectedVars.length > 0 ? (
              <div className="mt-3 border-t border-neutral-100 pt-3">
                <div className="flex items-center justify-between">
                  <p className="text-[11.5px] font-bold text-neutral-700">
                    Template Variables ({detectedVars.length}):
                  </p>
                  <span className="text-[10.5px] font-medium text-emerald-600">
                    ● Live from template
                  </span>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {detectedVars.map((v) => (
                    <div key={v} className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50/50 p-1.5 focus-within:border-neutral-900 focus-within:bg-white transition-colors">
                      <span className="shrink-0 rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[10.5px] font-bold text-white">
                        {"{{"}{v}{"}}"}
                      </span>
                      <input
                        value={sampleVars[v] ?? ""}
                        onChange={(e) => setSampleVars((s) => ({ ...s, [v]: e.target.value }))}
                        placeholder={`Sample ${v}…`}
                        className="w-full bg-transparent text-[12px] text-neutral-900 focus:outline-none"
                      />
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mt-3 border-t border-neutral-100 pt-3">
                <div className="flex items-center justify-between text-[11.5px]">
                  <span className="font-semibold text-neutral-700">Template Variables (0)</span>
                  <span className="font-mono text-[10.5px] text-neutral-400">Zero active variables</span>
                </div>
                <p className="mt-1 text-[11.5px] text-neutral-400 leading-relaxed">
                  No dynamic placeholders. Add <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[10.5px] text-neutral-700">{"{{variable_name}}"}</code> to your HTML or subject line to inject dynamic values.
                </p>
              </div>
            )}
          </div>

          
          <div className="flex justify-center">
            <div className={`w-full transition-all duration-300 ${previewDevice === "mobile" ? "max-w-[440px]" : "max-w-full"}`}>
              {previewDevice === "mobile" ? (
                <>
                  <p className="mb-2 text-center font-mono text-[10.5px] font-bold tracking-wider text-neutral-400 uppercase">
                    📱 Mobile · 440px — Gmail app width
                  </p>
                  <div className="overflow-hidden rounded-[24px] border-[3px] border-neutral-900 bg-neutral-900 shadow-xl">
                    
                    <div className="mx-auto my-2 h-1 w-16 rounded-full bg-neutral-700" />
                    <div className="overflow-hidden rounded-[18px] bg-white">
                      <GmailPreview
                        from={scopeMailbox.startsWith("*@") ? `support@${domainName}` : scopeMailbox}
                        to="customer@example.com"
                        subject={renderedSubject || "(no subject)"}
                        html={renderedHtml}
                        iframeHeightClass="h-[500px] w-full bg-white"
                      />
                    </div>
                  </div>
                </>
              ) : (
                <GmailPreview
                  from={scopeMailbox.startsWith("*@") ? `support@${domainName}` : scopeMailbox}
                  to="customer@example.com"
                  subject={renderedSubject || "(no subject)"}
                  html={renderedHtml}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      
      {aiModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-100 pb-3">
              <div>
                <h3 className="text-[17px] font-bold text-neutral-900">Make with AI</h3>
                <p className="mt-0.5 text-[12.5px] text-neutral-500">
                  Describe it → copy → paste into any AI chatbot → paste their HTML back into the editor.
                </p>
              </div>
              <button onClick={() => setAiModalOpen(false)} className="rounded-lg p-2 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900 cursor-pointer">
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-[12px] font-bold text-neutral-800">What do you want?</label>
                <textarea
                  value={aiRequest}
                  onChange={(e) => setAiRequest(e.target.value)}
                  rows={5}
                  placeholder="e.g. Black and white professional email with a button and a verification link for people to verify themselves, no code, link embedded…"
                  className="mt-1.5 w-full rounded-lg border border-neutral-200 bg-white p-2.5 text-[13px] leading-relaxed text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none"
                />
              </div>
              <p className="rounded-lg bg-neutral-50 px-3 py-2 text-[11.5px] leading-relaxed text-neutral-500">
                Template name, subject, variables ({detectedVars.length || "default"}) and your current theme colors are
                added to the prompt automatically.
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setAiModalOpen(false)}
                  className="rounded-lg border border-neutral-200 px-4 py-2 text-[12.5px] font-semibold text-neutral-700 hover:bg-neutral-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={copyAiPrompt}
                  className="rounded-lg bg-neutral-900 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-neutral-700 cursor-pointer"
                >
                  ⧉ Copy prompt
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      
      {libraryOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-100 pb-4">
              <div>
                <p className="font-mono text-[11px] font-bold uppercase tracking-wider text-neutral-400">
                  STARTER TEMPLATES
                </p>
                <h3 className="text-[20px] font-bold text-neutral-900">Choose a Professional Email Template</h3>
                <p className="text-[13px] text-neutral-500">
                  Pre-tested across Gmail, Apple Mail, Outlook, and mobile clients with zero configuration.
                </p>
              </div>
              <button
                onClick={() => setLibraryOpen(false)}
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
                        onClick={() => applyPreset(preset)}
                        className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors cursor-pointer ${
                          isBlank
                            ? "bg-emerald-600 text-white hover:bg-emerald-700"
                            : "bg-neutral-900 text-white hover:bg-neutral-800"
                        }`}
                      >
                        {isBlank ? "Start from zero →" : "Use this template →"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      
      {sendTestOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-100 pb-3">
              <h3 className="text-[17px] font-bold text-neutral-900">Send Test Email</h3>
              <button
                onClick={() => setSendTestOpen(false)}
                className="text-neutral-400 hover:text-neutral-900 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <p className="mt-3 text-[13px] text-neutral-600">
              Sends a live preview of this template rendered with the current test variables to your actual inbox.
            </p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-[11.5px] font-semibold text-neutral-700">Recipient Email</label>
                <input
                  type="email"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder="your.email@example.com"
                  className="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-[13px] font-medium text-neutral-900 focus:border-neutral-900 focus:outline-none"
                />
              </div>

              {testResult && (
                <div
                  className={`rounded-lg p-3 text-[12.5px] ${
                    testResult.startsWith("Test email sent")
                      ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                      : "bg-red-50 text-red-700 border border-red-200"
                  }`}
                >
                  {testResult}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setSendTestOpen(false)}
                  className="rounded-lg border border-neutral-200 px-4 py-2 text-[12.5px] font-semibold text-neutral-700 hover:bg-neutral-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSendTest}
                  disabled={sendingTest || !testTo.trim()}
                  className="rounded-lg bg-neutral-900 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-neutral-800 disabled:opacity-40 cursor-pointer"
                >
                  {sendingTest ? "Sending…" : "Send Test Now"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      
      {apiDrawerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
          onClick={() => setApiDrawerOpen(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-neutral-100 pb-4">
              <div>
                <p className="font-mono text-[11px] font-bold uppercase tracking-wider text-neutral-400">
                  DEVELOPER REST API
                </p>
                <h3 className="text-[18px] font-bold text-neutral-900">Send Template via API</h3>
                <p className="mt-0.5 text-[13px] text-neutral-500">
                  Trigger this template from your backend with a single request.
                </p>
              </div>
              <button
                onClick={() => setApiDrawerOpen(false)}
                className="rounded-lg p-2 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <p className="mt-4 text-[13px] leading-relaxed text-neutral-600">
              POST to <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[12px] text-neutral-900">/v1/send</code> with{" "}
              <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[12px] text-neutral-900">"template": "{cleanTemplateSlug}"</code>. MailerGo injects
              your dynamic variables server-side and DKIM-signs the outbound mail.
            </p>

            <div className="mt-4 space-y-4">
              <CodeBlock title="cURL" code={curlSnippet} />
              <CodeBlock title="JavaScript / Node.js" code={nodeSnippet} />
              <CodeBlock title="Python" code={pythonSnippet} />
            </div>

            <p className="mt-4 rounded-lg bg-neutral-50 px-3 py-2 text-[11.5px] leading-relaxed text-neutral-500">
              Authenticate with a scoped API key via <span className="font-mono text-neutral-700">Authorization: Bearer mg_live_…</span>.
              Create one under Domain → API keys.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
