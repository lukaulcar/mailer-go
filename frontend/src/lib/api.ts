export const DEFAULT_MX_HOST = "smtp.lukaulcar.com";
export const CHECK_COOLDOWN_S = 30;

export interface MXServer {
  host: string;
  priority: string;
  secret1: string;
  secret2: string;
}

export type DnsStatus = "pending" | "ok" | "fail";

export interface DnsRecord {
  kind: "MX" | "SPF" | "DKIM" | "DMARC" | "TXT" | string;
  host: string;
  value: string;
  status: DnsStatus;
  error?: string;
  current_value?: string;
}

export interface Domain {
  name: string;
  status: "pending" | "verified";
  addedAt: string;
  mxMode: "default" | "custom";
  mxServers: MXServer[];
  dns: DnsRecord[];
  lastCheck: number | null;
}

export type MailboxKind = "standard" | "send-only" | "catch-all";

export interface Mailbox {
  address: string;
  domain: string;
  displayName?: string;
  display_name?: string;
  usedMb: number;
  used_bytes?: number;
  quota_bytes?: number;
  quotaMb?: number;
  enabled: boolean;
  passwordSet: boolean;
  kind: MailboxKind;
  token?: string;
  plan?: number;
}

export function effectiveQuotaMb(m: Pick<Mailbox, "quota_bytes" | "quotaMb" | "plan"> | null | undefined, isPremium: boolean): number {
  if (!isPremium) return 100;
  const qb = m?.quota_bytes ?? 0;
  if (qb > 0) return qb / (1024 * 1024);
  const qm = m?.quotaMb ?? 0;
  if (qm > 0) return qm;
  return 0;
}

export interface MailTemplate {
  id: string;
  domain: string;
  mailbox: string;
  name: string;
  subject: string;
  html: string;
  text: string;
  updatedAt: string;
}

export function isDomainWideTemplate(t: { mailbox?: string | null }): boolean {
  if (!t.mailbox) return true;
  const m = t.mailbox.trim().toLowerCase();
  return m.startsWith("*@") || m === "*" || m.startsWith("@") || m === "";
}

export interface ApiKeyScope {
  type: "domain" | "domains" | "mailbox" | "mailboxes";
  domains: string[];
  mailbox?: string;
  mailboxes?: string[];
}

export type ApiKeyCapability = "send" | "templates" | "full";
export type ApiKeyPermission = "send" | "templates" | "events" | "delete_messages" | "delete_mailbox";

export const API_KEY_PERMISSIONS: { id: ApiKeyPermission; title: string; description: string; endpoint: string }[] = [
  {
    id: "send",
    title: "Send email",
    description: "POST /v1/send with a raw subject + body, or a stored template.",
    endpoint: "POST /v1/send",
  },
  {
    id: "templates",
    title: "Use templates",
    description: "Render stored templates with variables when sending.",
    endpoint: "templates.render",
  },
  {
    id: "events",
    title: "Live mail stream",
    description: "Authenticate a WebSocket stream of incoming mail (wss://…/v1/stream).",
    endpoint: "WSS /v1/stream",
  },
  {
    id: "delete_messages",
    title: "Delete individual emails",
    description: "Delete specific messages by ID via API endpoints.",
    endpoint: "DELETE /api/messages/{id}",
  },
  {
    id: "delete_mailbox",
    title: "Clear or delete whole mailbox",
    description: "Clear whole inbox/folders or delete entire mailbox via API endpoints.",
    endpoint: "DELETE /api/mailboxes/{address}",
  },
];

export function keyPermissions(key: Pick<ApiKey, "permissions" | "capability">): ApiKeyPermission[] {
  if (key.permissions && key.permissions.length > 0) return key.permissions;
  if (key.capability === "full") return ["send", "templates", "events"];
  if (key.capability === "templates") return ["send", "templates"];
  return ["send"];
}

export function describePermissions(perms: ApiKeyPermission[]): string {
  const s = new Set(perms);
  if (s.has("send") && s.has("templates") && s.has("events") && s.has("delete_messages") && s.has("delete_mailbox")) return "Full access";
  if (s.size === 0) return "No permissions";
  return perms
    .map((p) => {
      switch (p) {
        case "send": return "Send";
        case "templates": return "Templates";
        case "events": return "Live stream";
        case "delete_messages": return "Delete emails";
        case "delete_mailbox": return "Delete mailbox";
        default: return p;
      }
    })
    .join(" + ");
}

export function isKeyExpired(key: Pick<ApiKey, "expiresAt">, now = new Date()): boolean {
  if (!key.expiresAt) return false;
  const today = now.toISOString().slice(0, 10);
  return key.expiresAt < today;
}

export const API_KEY_EXPIRY_PRESETS = [
  { id: "never", label: "Never", days: null as number | null, hint: "until revoked" },
  { id: "1d", label: "1 day", days: 1 as number | null, hint: "+1 day" },
  { id: "3d", label: "3 days", days: 3 as number | null, hint: "+3 days" },
  { id: "7d", label: "7 days", days: 7 as number | null, hint: "+7 days" },
  { id: "30d", label: "30 days", days: 30 as number | null, hint: "+30 days" },
  { id: "90d", label: "90 days", days: 90 as number | null, hint: "+90 days" },
  { id: "180d", label: "180 days", days: 180 as number | null, hint: "+180 days" },
  { id: "1y", label: "1 year", days: 365 as number | null, hint: "+365 days" },
  { id: "custom", label: "Custom", days: null as number | null, hint: "pick a date" },
] as const;

export type ApiKeyExpiryPresetId = (typeof API_KEY_EXPIRY_PRESETS)[number]["id"];

export function expiryDateForDays(days: number, now = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function scopeMailboxes(scope: ApiKeyScope): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (m?: string) => {
    const clean = (m ?? "").trim().toLowerCase();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  };
  for (const m of scope.mailboxes ?? []) push(m);
  push(scope.mailbox);
  return out;
}

export interface ApiKey {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  scope: ApiKeyScope;
  capability?: ApiKeyCapability;
  permissions?: ApiKeyPermission[];
  expiresAt?: string | null;
  domain?: string | null;
}

export interface CreatedApiKey extends ApiKey {
  secret: string;
}

export type SubscriptionEvent =
  | "message.received"
  | "message.sent"
  | "message.bounced";

export const SUBSCRIPTION_EVENTS: SubscriptionEvent[] = [
  "message.received",
  "message.sent",
  "message.bounced",
];

export interface Subscription {
  id: string;
  domain: string;
  url: string;
  events: SubscriptionEvent[];
  enabled: boolean;
  createdAt: string;
}

export interface CreatedSubscription {
  subscription: Subscription;
  secret: string;
}

export function describeScope(scope: ApiKeyScope): string {
  if (scope.type === "mailbox" || scope.type === "mailboxes") {
    const boxes = scopeMailboxes(scope);
    if (boxes.length === 0) return scope.domains[0] ?? "mailbox";
    if (boxes.length === 1) return boxes[0];
    return `${boxes.length} mailboxes`;
  }
  if (scope.type === "domain") return scope.domains[0] ?? "domain";
  if (scope.domains.length === 0) return "all domains";
  if (scope.domains.length === 1) return scope.domains[0];
  return `${scope.domains.length} domains`;
}

export function keyCovers(key: ApiKey, domain: string, mailbox?: string): boolean {
  const s = key.scope;
  if (!s) return true;
  if (s.type === "mailbox" || s.type === "mailboxes") {
    const boxes = scopeMailboxes(s).map((b) => b.toLowerCase());
    if (mailbox) return boxes.includes(mailbox.toLowerCase());
    if (s.domains.includes(domain)) return true;
    return boxes.some((b) => b.split("@")[1]?.toLowerCase() === domain.toLowerCase());
  }
  if (s.domains.length === 0) return true;
  return s.domains.includes(domain);
}

export function randomPassword(n = 14): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!#";
  const rand = new Uint32Array(n);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(rand);
  } else {
    for (let i = 0; i < n; i++) rand[i] = Math.floor(Math.random() * 0xffffffff);
  }
  let out = "";
  for (let i = 0; i < n; i++) out += chars[rand[i] % chars.length];
  return out;
}

export function buildRecords(domain: string, mxMode: "default" | "custom", servers: MXServer[]): DnsRecord[] {
  const recs: DnsRecord[] = [];
  if (mxMode === "default") {
    recs.push({ kind: "MX", host: "@", value: `10 ${DEFAULT_MX_HOST}`, status: "pending" });
  } else {
    servers
      .filter((s) => s.host.trim())
      .forEach((s) =>
        recs.push({ kind: "MX", host: "@", value: `${s.priority.trim() || "10"} ${s.host.trim()}`, status: "pending" }),
      );
  }
  recs.push({ kind: "SPF", host: "@", value: "v=spf1 mx ~all", status: "pending" });
  recs.push({ kind: "DKIM", host: "mail._domainkey", value: `v=DKIM1; k=rsa; p=...`, status: "pending" });
  recs.push({ kind: "DMARC", host: "_dmarc", value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}`, status: "pending" });
  return recs;
}

export function extractVars(...sources: string[]): string[] {
  const seen: string[] = [];
  const re = /{{\s*([a-zA-Z0-9_.-]+)\s*}}/g;
  for (const src of sources) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (!seen.includes(m[1])) seen.push(m[1]);
    }
  }
  return seen;
}

export function renderWithVars(source: string, vars: Record<string, string>): string {
  if (!source) return "";
  return source.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (full, key: string) => {
    const k = key.trim();
    return vars[k] !== undefined && vars[k] !== "" ? vars[k] : full;
  });
}

export function formatMailboxStorage(usedMb: number, maxMb = 0) {
  const safeUsed = Math.max(0, usedMb);
  const isUnlimited = maxMb <= 0 || !Number.isFinite(maxMb);
  const pct = isUnlimited ? 0 : Math.min(100, Math.max(0, (safeUsed / maxMb) * 100));
  let formatted: string;
  if (safeUsed === 0) {
    formatted = "0 MB";
  } else if (safeUsed < 0.1) {
    formatted = `${Math.max(1, Math.round(safeUsed * 1024))} KB`;
  } else if (safeUsed < 10) {
    formatted = `${safeUsed.toFixed(1)} MB`;
  } else if (safeUsed < 1024) {
    formatted = `${Math.round(safeUsed)} MB`;
  } else {
    formatted = `${(safeUsed / 1024).toFixed(2)} GB`;
  }
  const maxLabel = isUnlimited
    ? "∞"
    : maxMb >= 1024
      ? `${(maxMb / 1024).toFixed(0)} GB`
      : `${maxMb} MB`;
  return {
    formatted,
    maxLabel,
    display: isUnlimited ? `${formatted} / ∞` : `${formatted} / ${maxLabel}`,
    pct,
    isUnlimited,
  };
}

export const STARTER_TEMPLATE_HTML = `<div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px;">
  <h1 style="font-size: 24px; margin: 0 0 12px;">Hi {{name}},</h1>
  <p style="font-size: 15px; line-height: 1.6; color: #333; margin: 0 0 16px;">
    Your verification code is:
  </p>
  <p style="font-size: 32px; font-weight: bold; letter-spacing: 6px; margin: 0 0 16px;">{{code}}</p>
  <p style="font-size: 13px; color: #888;">It expires in 10 minutes. If you didn't ask for this, ignore this email.</p>
</div>`;

export const STARTER_TEMPLATE_TEXT = `Hi {{name}},\n\nYour verification code is: {{code}}\n\nIt expires in 10 minutes.`;

export const API_BASE_URL =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export interface ApiUser {
  id: string;
  email: string;
  plan?: number;
  status?: "pending" | "approved" | "blocked";
  isAdmin?: boolean;
  mode?: "live" | "local";
}

export interface AdminUserItem {
  id: string;
  email: string;
  plan: number;
  status: "pending" | "approved" | "blocked";
  created_at: number;
  updated_at: number;
  domains_count?: number;
  mailboxes_count?: number;
  is_admin?: boolean;
}

export function getAuthToken(): string | null {
  try {
    const raw = localStorage.getItem("mailergo.session");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.token || (typeof parsed === "string" ? parsed : null);
  } catch {
    return null;
  }
}

export function getActiveMailboxToken(): string | null {
  try {
    const active = localStorage.getItem("mailergo.mailboxActive");
    const rawSessions = localStorage.getItem("mailergo.mailboxSessions");
    if (!rawSessions) return null;
    const accounts = JSON.parse(rawSessions);
    if (!Array.isArray(accounts)) return null;
    const current = accounts.find((a: Mailbox) => a && typeof a === "object" && a.address === active) ?? accounts[0];
    return current?.token ?? null;
  } catch {
    return null;
  }
}

export interface Attachment {
  id: string;
  message_id: string;
  mailbox?: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  content_id?: string;
  is_inline?: boolean;
}

export interface MailMessage {
  id: string;
  mailbox: string;
  folder: "inbox" | "sent";
  from: string;
  to: string;
  subject: string;
  body: string;
  body_html?: string;
  date: string;
  read: boolean;
  starred?: boolean;
  attachments?: Attachment[];
}

export function formatAttachmentSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isDangerousAttachment(filename: string): boolean {
  if (!filename) return false;
  const dangerousExts = [
    ".exe", ".bat", ".cmd", ".sh", ".vbs", ".js", ".scr", ".msi",
    ".iso", ".jar", ".ps1", ".com", ".hta", ".cpl", ".wsf", ".vbe",
  ];
  const lower = filename.toLowerCase();
  return dangerousExts.some((ext) => lower.endsWith(ext));
}

function attachmentUrl(attId: string, action: "download" | "view"): string {
  const token = getAuthToken() || getActiveMailboxToken();
  const base = `${API_BASE_URL}/api/attachments/${encodeURIComponent(attId)}/${action}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function getAttachmentDownloadUrl(attId: string): string {
  return attachmentUrl(attId, "download");
}

export function getAttachmentPreviewUrl(attId: string): string {
  return attachmentUrl(attId, "view");
}

export function downloadAttachment(att: Attachment): void {
  const url = getAttachmentDownloadUrl(att.id);
  const a = document.createElement("a");
  a.href = url;
  a.download = att.filename || "attachment";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export class ApiError extends Error {
  status: number;
  statusText: string;
  raw?: string;

  constructor(message: string, status: number, statusText = "", raw?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
    this.raw = raw;
  }
}

function defaultStatusMessage(status: number): string {
  switch (status) {
    case 400:
      return "Invalid request. Please verify the information entered and try again.";
    case 401:
      return "Authentication required. Please check your credentials or log in again.";
    case 403:
      return "Access denied. You do not have permission to perform this action.";
    case 404:
      return "The requested resource could not be found.";
    case 405:
      return "This action is not supported for this endpoint.";
    case 408:
      return "The request timed out. Please try again.";
    case 409:
      return "A conflicting record already exists.";
    case 413:
      return "The payload is too large. Please reduce file or message size.";
    case 422:
      return "Validation error. Please check the entered data.";
    case 429:
      return "Rate limit exceeded. Too many attempts, please wait a moment.";
    case 500:
      return "A server error occurred. Please try again in a few moments.";
    case 502:
      return "Bad gateway. Unable to reach the central server.";
    case 503:
      return "Service temporarily unavailable. Please try again shortly.";
    case 504:
      return "Gateway timeout. The server took too long to reply.";
    default:
      return `Request failed with status code ${status}.`;
  }
}

export async function parseResponseError(res: Response): Promise<ApiError> {
  let rawText = "";
  try {
    rawText = (await res.text()).trim();
  } catch {}

  let extracted = "";

  if (rawText) {
    try {
      const parsed = JSON.parse(rawText);
      if (typeof parsed === "string") {
        extracted = parsed;
      } else if (parsed && typeof parsed === "object") {
        extracted =
          parsed.message ||
          parsed.error ||
          parsed.detail ||
          parsed.msg ||
          parsed.title ||
          (typeof parsed.errors === "string"
            ? parsed.errors
            : Array.isArray(parsed.errors)
            ? parsed.errors.join(", ")
            : "");
      }
    } catch {
      extracted = rawText;
    }
  }

  extracted = (extracted || "").replace(/^["']|["']$/g, "").trim();
  extracted = extracted.replace(/^http:\s*/i, "");

  const isGenericStatus =
    !extracted ||
    (res.statusText && extracted.toLowerCase() === res.statusText.toLowerCase()) ||
    extracted.toLowerCase() === "unauthorized" ||
    extracted.toLowerCase() === "forbidden" ||
    extracted.toLowerCase() === "not found" ||
    extracted.toLowerCase() === "bad request" ||
    extracted.toLowerCase() === "internal server error";

  const message = isGenericStatus ? defaultStatusMessage(res.status) : extracted;
  const finalMessage = message.charAt(0).toUpperCase() + message.slice(1);

  return new ApiError(finalMessage, res.status, res.statusText, rawText);
}

export function getErrorMessage(err: unknown, fallback = "An unexpected error occurred. Please try again."): string {
  if (!err) return fallback;
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) {
    if (err.name === "TypeError" && err.message.toLowerCase().includes("fetch")) {
      return "Unable to connect to the server. Please check your network connection.";
    }
    return err.message;
  }
  if (typeof err === "string" && err.trim()) return err.trim();
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
  }
  return fallback;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isPrivilegedRoute =
    path.startsWith("/api/auth") ||
    path.startsWith("/api/admin") ||
    path.startsWith("/api/user");
  const token = isPrivilegedRoute ? getAuthToken() : getAuthToken() || getActiveMailboxToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      credentials: "include",
      ...init,
      headers,
    });
  } catch {
    throw new ApiError(
      "Unable to connect to the server. Please verify your connection.",
      0,
      "NetworkError",
    );
  }

  if (!res.ok) {
    throw await parseResponseError(res);
  }
  if (res.status === 204) return undefined as unknown as T;
  const text = await res.text();
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

export interface LiveEvent {
  type: "mailbox_usage" | "message_received" | "message_deleted" | "messages_cleared" | "messages_deleted";
  address?: string;
  folder?: string;
  used_bytes?: number;
  usedMb?: number;
  message?: MailMessage;
  message_id?: string;
  message_ids?: string[];
  timestamp?: number;
}

let sharedLiveWS: WebSocket | null = null;
const liveListeners = new Set<(event: LiveEvent) => void>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function ensureLiveWS() {
  if (typeof window === "undefined") return;
  if (sharedLiveWS && (sharedLiveWS.readyState === WebSocket.OPEN || sharedLiveWS.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const activeToken = getAuthToken() || getActiveMailboxToken() || "";
  const tokenQuery = activeToken ? `?token=${encodeURIComponent(activeToken)}` : "";
  const wsUrl = `${protocol}//${window.location.host}/ws/live${tokenQuery}`;
  try {
    sharedLiveWS = new WebSocket(wsUrl);
    sharedLiveWS.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data) as LiveEvent;
        liveListeners.forEach((listener) => {
          try {
            listener(parsed);
          } catch {}
        });
      } catch {}
    };
    sharedLiveWS.onclose = () => {
      sharedLiveWS = null;
      if (liveListeners.size > 0 && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          ensureLiveWS();
        }, 3000);
      }
    };
    sharedLiveWS.onerror = () => {};
  } catch {
    if (liveListeners.size > 0 && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        ensureLiveWS();
      }, 5000);
    }
  }
}

export function subscribeToLiveEvents(onEvent: (event: LiveEvent) => void): () => void {
  liveListeners.add(onEvent);
  ensureLiveWS();

  return () => {
    liveListeners.delete(onEvent);
    if (liveListeners.size === 0 && sharedLiveWS) {
      sharedLiveWS.close();
      sharedLiveWS = null;
    }
  };
}

interface RawApiKeyResponse {
  id: string;
  label: string;
  prefix: string;
  createdAt?: string;
  created_at?: number;
  scope?: ApiKeyScope;
  scope_type?: "domain" | "domains" | "mailbox" | "mailboxes";
  domains?: string[];
  mailbox?: string;
  mailboxes?: string[];
  capability?: ApiKeyCapability;
  permissions?: ApiKeyPermission[];
  expiresAt?: string | null;
  expires_at?: number | null;
}

function toFrontendKey(k: RawApiKeyResponse): ApiKey {
  const scope: ApiKeyScope = k.scope ?? {
    type: k.scope_type ?? "domain",
    domains: k.domains ?? [],
    mailbox: k.mailbox,
    mailboxes: k.mailboxes,
  };
  return {
    id: k.id,
    label: k.label,
    prefix: k.prefix,
    createdAt: k.createdAt ?? (k.created_at ? new Date(k.created_at * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)),
    scope,
    capability: k.capability ?? "send",
    permissions: k.permissions,
    expiresAt: k.expiresAt ?? (k.expires_at ? new Date(k.expires_at * 1000).toISOString().slice(0, 10) : null),
  };
}

interface RawTemplateResponse {
  id: string;
  domain: string;
  mailbox: string;
  name: string;
  subject?: string;
  html?: string;
  text?: string;
  updatedAt?: string;
  updated_at?: number;
}

function toFrontendTemplate(t: RawTemplateResponse): MailTemplate {
  return {
    id: t.id,
    domain: t.domain,
    mailbox: t.mailbox,
    name: t.name,
    subject: t.subject || "",
    html: t.html || "",
    text: t.text || "",
    updatedAt: t.updatedAt ?? (t.updated_at ? new Date(t.updated_at * 1000).toISOString() : new Date().toISOString()),
  };
}

async function patchMailbox(address: string, body: Record<string, unknown>): Promise<Mailbox> {
  const res = await request<{ mailbox: Mailbox }>(`/api/mailboxes/${encodeURIComponent(address)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return res.mailbox;
}

export const api = {
  mailbox: {
    login: async (address: string, password: string): Promise<Mailbox> => {
      const res = await request<{ mailbox: Mailbox; token?: string }>("/api/mailbox/login", {
        method: "POST",
        body: JSON.stringify({ address, password }),
      });
      return {
        ...res.mailbox,
        displayName: res.mailbox.display_name ?? res.mailbox.displayName ?? "",
        token: res.token,
      };
    },
    get: async (address: string): Promise<Mailbox> => {
      const res = await request<{ mailbox: Mailbox }>(`/api/mailboxes/${encodeURIComponent(address)}`);
      return {
        ...res.mailbox,
        displayName: res.mailbox.display_name ?? res.mailbox.displayName ?? "",
      };
    },
  },

  messages: {
    list: async (mailbox: string, folder: "inbox" | "sent" = "inbox"): Promise<MailMessage[]> => {
      const res = await request<{ messages: MailMessage[] }>(
        `/api/mailboxes/${encodeURIComponent(mailbox)}/messages?folder=${folder}`
      );
      return res.messages || [];
    },
    send: async (from: string, to: string, subject: string, body: string, html?: string, fromName?: string): Promise<void> => {
      await request(`/api/mailboxes/${encodeURIComponent(from)}/send`, {
        method: "POST",
        body: JSON.stringify({ to, subject, body, html, from_name: fromName }),
      });
    },
    markRead: async (_mailbox: string, id: string, read = true): Promise<void> => {
      await request(`/api/messages/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ read }),
      });
    },
    remove: async (_mailbox: string, id: string): Promise<void> => {
      await request(`/api/messages/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    },
    deleteMany: async (
      mailbox: string,
      ids: string[]
    ): Promise<{ deletedCount: number; freedBytes: number; deletedIds: string[] }> => {
      const res = await request<{
        success: boolean;
        deleted_count: number;
        deleted_ids: string[];
        freed_bytes: number;
      }>(`/api/mailboxes/${encodeURIComponent(mailbox)}/messages`, {
        method: "DELETE",
        body: JSON.stringify({ ids }),
      });
      return {
        deletedCount: res.deleted_count,
        freedBytes: res.freed_bytes,
        deletedIds: res.deleted_ids || [],
      };
    },
    clearFolder: async (
      mailbox: string,
      folder: string = "inbox"
    ): Promise<{ deletedCount: number; freedBytes: number; deletedIds: string[] }> => {
      const res = await request<{
        success: boolean;
        deleted_count: number;
        deleted_ids: string[];
        freed_bytes: number;
      }>(`/api/mailboxes/${encodeURIComponent(mailbox)}/messages?folder=${encodeURIComponent(folder)}`, {
        method: "DELETE",
      });
      return {
        deletedCount: res.deleted_count,
        freedBytes: res.freed_bytes,
        deletedIds: res.deleted_ids || [],
      };
    },
  },

  auth: {
    login: (email: string, password: string) =>
      request<{ user: ApiUser; token: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    signup: (email: string, password: string) =>
      request<{ user: ApiUser; token?: string; pendingApproval?: boolean; message?: string }>("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    me: () => request<{ user: ApiUser }>("/api/auth/me"),
    logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  },

  admin: {
    listUsers: () => request<{ users: AdminUserItem[]; mode: string }>("/api/admin/users"),
    setUserStatus: (id: string, status: "approved" | "blocked" | "pending") =>
      request<{ success: boolean; user: AdminUserItem }>(`/api/admin/users/${encodeURIComponent(id)}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      }),
    deleteUser: (id: string) =>
      request<{ success: boolean }>(`/api/admin/users/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  },

  user: {
    exportData: async (): Promise<void> => {
      const token = getAuthToken();
      let res: Response;
      try {
        res = await fetch(`${API_BASE_URL}/api/user/export`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: "include",
        });
      } catch {
        throw new ApiError("Unable to connect to the server to download data archive.", 0, "NetworkError");
      }
      if (!res.ok) {
        throw await parseResponseError(res);
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mailergo-selfhost-data.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    },
  },

  domains: {
    list: async (): Promise<Domain[]> => {
      const res = await request<{ domains: Domain[] }>("/api/domains");
      return res.domains || [];
    },
    create: async (input: { name: string; mxMode: "default" | "custom"; mxServers: MXServer[]; dns: DnsRecord[]; lastCheck: number | null }): Promise<Domain> => {
      const res = await request<{ domain: Domain }>("/api/domains", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return res.domain;
    },
    remove: async (name: string): Promise<void> => {
      await request(`/api/domains/${encodeURIComponent(name)}`, { method: "DELETE" });
    },
    verify: async (name: string): Promise<DnsRecord[]> => {
      const res = await request<{ dns: DnsRecord[] }>(`/api/domains/${encodeURIComponent(name)}/verify`, {
        method: "POST",
      });
      return res.dns || [];
    },
    recheck: (name: string) => api.domains.verify(name),
    updateMx: async (name: string, mxMode: "default" | "custom", mxServers: MXServer[]): Promise<Domain> => {
      const res = await request<{ domain: Domain }>(`/api/domains/${encodeURIComponent(name)}/mx`, {
        method: "PUT",
        body: JSON.stringify({ mxMode, mxServers }),
      });
      return res.domain;
    },
  },

  mailboxes: {
    get: (address: string): Promise<Mailbox> => api.mailbox.get(address),
    list: async (domain: string): Promise<Mailbox[]> => {
      const res = await request<{ mailboxes: Mailbox[] }>(`/api/domains/${encodeURIComponent(domain)}/mailboxes`);
      return res.mailboxes || [];
    },
    listAll: async (): Promise<Mailbox[]> => {
      const res = await request<{ mailboxes: Mailbox[] }>("/api/mailboxes");
      return res.mailboxes || [];
    },
    create: async (domain: string, local: string, password: string, kind: MailboxKind = "standard"): Promise<Mailbox> => {
      const res = await request<{ mailbox: Mailbox }>(`/api/domains/${encodeURIComponent(domain)}/mailboxes`, {
        method: "POST",
        body: JSON.stringify({ local, password, kind }),
      });
      return res.mailbox;
    },
    setPassword: async (address: string, password: string): Promise<void> => {
      await request(`/api/mailboxes/${encodeURIComponent(address)}/password`, {
        method: "PATCH",
        body: JSON.stringify({ password }),
      });
    },
    setEnabled: (address: string, enabled: boolean): Promise<Mailbox> =>
      patchMailbox(address, { enabled }),
    setKind: (address: string, kind: MailboxKind): Promise<Mailbox> =>
      patchMailbox(address, { kind }),
    setQuota: (address: string, quotaMb: number): Promise<Mailbox> =>
      patchMailbox(address, { quota_mb: quotaMb }),
    setDisplayName: async (address: string, displayName: string): Promise<Mailbox> => {
      const mailbox = await patchMailbox(address, { display_name: displayName });
      return {
        ...mailbox,
        displayName: mailbox.display_name ?? mailbox.displayName ?? displayName,
      };
    },
    remove: async (address: string): Promise<void> => {
      await request(`/api/mailboxes/${encodeURIComponent(address)}`, { method: "DELETE" });
    },
  },

  templates: {
    list: async (mailbox: string): Promise<MailTemplate[]> => {
      const res = await request<{ templates: RawTemplateResponse[] }>(`/api/mailboxes/${encodeURIComponent(mailbox)}/templates`);
      return (res.templates || []).map(toFrontendTemplate);
    },
    listDomain: async (domain: string): Promise<MailTemplate[]> => {
      const res = await request<{ templates: RawTemplateResponse[] }>(`/api/domains/${encodeURIComponent(domain)}/templates`);
      return (res.templates || []).map(toFrontendTemplate);
    },
    create: async (
      target: string,
      input: { name: string; subject: string; html: string; text?: string; mailbox?: string }
    ): Promise<MailTemplate> => {
      const isMailbox = target.includes("@") && !target.startsWith("*@");
      const url = isMailbox
        ? `/api/mailboxes/${encodeURIComponent(target)}/templates`
        : `/api/domains/${encodeURIComponent(target)}/templates`;
      const res = await request<{ template: RawTemplateResponse }>(url, {
        method: "POST",
        body: JSON.stringify(input),
      });
      return toFrontendTemplate(res.template);
    },
    update: async (
      id: string,
      patch: { name?: string; subject?: string; html?: string; text?: string; mailbox?: string }
    ): Promise<MailTemplate> => {
      const res = await request<{ template: RawTemplateResponse }>(`/api/templates/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return toFrontendTemplate(res.template);
    },
    remove: async (id: string): Promise<void> => {
      await request(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  },

  keys: {
    list: async (domain?: string): Promise<ApiKey[]> => {
      const q = domain ? `?domain=${encodeURIComponent(domain)}` : "";
      const res = await request<{ keys: RawApiKeyResponse[] }>(`/api/keys${q}`);
      return (res.keys || []).map(toFrontendKey);
    },
    listAll: () => api.keys.list(),
    create: async (
      label: string,
      scope: ApiKeyScope,
      capability: ApiKeyCapability = "send",
      opts?: { permissions?: ApiKeyPermission[]; expiresAt?: string | null },
    ): Promise<CreatedApiKey> => {
      void capability;
      const res = await request<{ key: RawApiKeyResponse; secret: string }>("/api/keys", {
        method: "POST",
        body: JSON.stringify({ label, scope, permissions: opts?.permissions, expiresAt: opts?.expiresAt ?? null }),
      });
      return { ...toFrontendKey(res.key), secret: res.secret };
    },
    revoke: async (id: string): Promise<void> => {
      await request(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  },

  subscriptions: {
    list: async (domain: string): Promise<Subscription[]> => {
      const res = await request<{ subscriptions: Subscription[] }>(`/api/domains/${encodeURIComponent(domain)}/subscriptions`);
      return res.subscriptions || [];
    },
    create: async (domain: string, url: string, events: SubscriptionEvent[]): Promise<CreatedSubscription> => {
      return await request<{ subscription: Subscription; secret: string }>(
        `/api/domains/${encodeURIComponent(domain)}/subscriptions`,
        { method: "POST", body: JSON.stringify({ url, events }) },
      );
    },
    setEnabled: async (_domain: string, id: string, enabled: boolean): Promise<Subscription> => {
      const res = await request<{ subscription: Subscription }>(`/api/subscriptions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      return res.subscription;
    },
    remove: async (_domain: string, id: string): Promise<void> => {
      await request(`/api/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  },
};
