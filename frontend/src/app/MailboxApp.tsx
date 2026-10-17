import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Forward, Inbox, Reply, Search, Settings, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useMailbox } from "../lib/mailboxAuth";
import { navigate, useRoute } from "../lib/router";
import { Mark } from "../components/Header";
import GmailPreview from "../components/GmailPreview";
import ComposeModal from "../components/ComposeModal";
import SenderNameModal from "../components/SenderNameModal";
import { CopyButton, KeyboardShortcutsModal } from "../components/ui";
import { EnvelopeIcon, PencilIcon, StarIcon, TrashIcon } from "../components/icons";
import { notify } from "../lib/toast";
import { api, effectiveQuotaMb, formatMailboxStorage, getErrorMessage, subscribeToLiveEvents, type Mailbox, type MailMessage } from "../lib/api";
import { getCleanMessageContent } from "../lib/mailParser";

type Folder = "inbox" | "starred" | "sent";

const PAGE_SIZE = 50;

const AVATAR_COLORS = [
  "bg-neutral-900 text-white",
  "bg-neutral-800 text-white",
  "bg-neutral-700 text-white",
  "bg-neutral-600 text-white",
  "bg-neutral-200 text-neutral-900",
  "bg-neutral-100 text-neutral-900",
];

function avatarColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function initialOf(addr: string): string {
  return (addr.trim().charAt(0) || "?").toUpperCase();
}

function senderName(addr: string): string {
  const local = addr.split("@")[0] ?? addr;
  return local
    .split(/[._-]+/)
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : ""))
    .join(" ");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  if (now.getFullYear() === d.getFullYear()) {
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function snippet(body: string): string {
  const clean = getCleanMessageContent({ body }).text;
  return clean.replace(/\s+/g, " ").slice(0, 90);
}

function replyPrefill(m: MailMessage) {
  return {
    to: m.from,
    subject: m.subject.startsWith("Re:") ? m.subject : `Re: ${m.subject}`,
    body: `\n\n— — —\nOn ${new Date(m.date).toLocaleString()}, ${m.from} wrote:\n${getCleanMessageContent(m).text}`,
  };
}

function forwardPrefill(m: MailMessage) {
  return {
    subject: `Fwd: ${m.subject}`,
    body: `\n\n— — —\nForwarded from ${m.from}:\n${getCleanMessageContent(m).text}`,
  };
}

const NAV: { id: Folder; label: string; icon: React.ReactNode }[] = [
  { id: "inbox", label: "Inbox", icon: <EnvelopeIcon size={18} rx={2.5} aria-hidden /> },
  { id: "starred", label: "Starred", icon: <StarIcon size={18} aria-hidden /> },
  {
    id: "sent",
    label: "Sent",
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M3 10.5 17.5 3 10.5 17.5 8 11Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export default function MailboxApp({ onGoDashboard, onAddAccount, onGoLanding }: { onGoDashboard: () => void; onAddAccount?: (prefill?: string) => void; onGoLanding: () => void }) {
  const { user } = useAuth();
  const { mailbox, accounts, switchMailbox, removeMailbox, signOutAll, updateMailbox } = useMailbox();
  const route = useRoute();
  const folder = route.folder ?? "inbox";
  const openedId = route.messageId ?? null;
  const [all, setAll] = useState<MailMessage[]>([]);
  const [mailboxInfo, setMailboxInfo] = useState<Mailbox | null>(mailbox);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "unread" | "starred">("all");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [starred, setStarred] = useState<Set<string>>(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [page, setPage] = useState(0);

  const [composeOpen, setComposeOpen] = useState(false);
  const [composePrefill, setComposePrefill] = useState<{ to?: string; subject?: string; body?: string }>({});
  const [senderSettingsOpen, setSenderSettingsOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const address = mailbox?.address ?? "";
  const activeDisplayName =
    mailboxInfo?.displayName ||
    mailboxInfo?.display_name ||
    mailbox?.displayName ||
    mailbox?.display_name ||
    "";
  const routeAccount = route.account ?? null;

  const loadMessages = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [inbox, sent] = await Promise.all([
        api.messages.list(address, "inbox"),
        api.messages.list(address, "sent"),
      ]);
      const combined = [...inbox, ...sent];
      setAll(combined);
      setStarred((prev) => {
        const next = new Set(prev);
        for (const m of combined) {
          if (m.starred) next.add(m.id);
        }
        return next;
      });
    } catch (err) {
      setLoadError(getErrorMessage(err, "Failed to load messages from server."));
    } finally {
      setLoading(false);
    }
  }, [address]);

  const refreshMailboxInfo = useCallback(async () => {
    if (!address) return;
    const info = await api.mailboxes.get(address).catch(() => null);
    if (info) {
      setMailboxInfo(info);
      updateMailbox({ address, usedMb: info.usedMb });
    }
  }, [address, updateMailbox]);

  useEffect(() => {
    setMailboxInfo(mailbox);
  }, [mailbox]);

  useEffect(() => {
    if (!address) return;
    let active = true;
    api.mailboxes
      .get(address)
      .then((info) => {
        if (active && info) {
          setMailboxInfo(info);
          const dName = info.displayName ?? info.display_name;
          updateMailbox({
            address,
            usedMb: info.usedMb,
            kind: info.kind,
            enabled: info.enabled,
            displayName: dName,
            display_name: dName,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [address, updateMailbox]);

  function mailRoute(patch: { folder?: Folder; messageId?: string | null; account?: string | null }) {
    navigate({
      view: "mail",
      folder: patch.folder ?? folder,
      messageId: patch.messageId !== undefined ? patch.messageId : openedId,
      account: patch.account !== undefined ? patch.account : (route.account ?? undefined),
    });
  }

  function goFolder(next: Folder) {
    setChecked(new Set());
    setSidebarOpen(false);
    mailRoute({ folder: next, messageId: null });
  }

  function switchTo(nextAddress: string) {
    switchMailbox(nextAddress);
    setChecked(new Set());
    setPage(0);
    setAccountOpen(false);
    navigate({ view: "mail", folder: "inbox", messageId: null, account: nextAddress });
  }

  useEffect(() => {
    if (routeAccount && routeAccount !== address && accounts.some((a) => a.address === routeAccount)) {
      switchMailbox(routeAccount);
    }
  }, [routeAccount, address, accounts, switchMailbox]);

  useEffect(() => {
    setChecked(new Set());
    setPage(0);
    setSidebarOpen(false);
  }, [address]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    if (!address) return;
    const unsubscribe = subscribeToLiveEvents((event) => {
      if (
        event.type === "message_received" &&
        event.address?.toLowerCase() === address.toLowerCase() &&
        event.message
      ) {
        setAll((prev) => [
          event.message as MailMessage,
          ...prev.filter((m) => m.id !== (event.message as MailMessage).id),
        ]);
        void refreshMailboxInfo();
      }
      if (
        event.type === "message_deleted" &&
        event.address?.toLowerCase() === address.toLowerCase() &&
        event.message_id
      ) {
        setAll((prev) => prev.filter((m) => m.id !== event.message_id));
        void refreshMailboxInfo();
      }
      if (
        event.type === "messages_cleared" &&
        event.address?.toLowerCase() === address.toLowerCase()
      ) {
        const evFolder = (event as { folder?: string }).folder;
        setAll((prev) => (evFolder === "all" || !evFolder ? [] : prev.filter((m) => m.folder !== evFolder)));
        void refreshMailboxInfo();
      }
      if (
        event.type === "messages_deleted" &&
        event.address?.toLowerCase() === address.toLowerCase()
      ) {
        const ids = (event as { message_ids?: string[] }).message_ids;
        if (Array.isArray(ids) && ids.length > 0) {
          const idSet = new Set(ids);
          setAll((prev) => prev.filter((m) => !idSet.has(m.id)));
          void refreshMailboxInfo();
        }
      }
      if (
        event.type === "mailbox_usage" &&
        event.address?.toLowerCase() === address.toLowerCase() &&
        typeof event.usedMb === "number"
      ) {
        setMailboxInfo((prev) => (prev ? { ...prev, usedMb: event.usedMb ?? prev.usedMb } : prev));
        updateMailbox({ address, usedMb: event.usedMb });
      }
    });
    return unsubscribe;
  }, [address, refreshMailboxInfo, updateMailbox]);

  const isPremium = user?.plan === 1 || mailboxInfo?.plan === 1 || mailbox?.plan === 1;
  const maxMb = effectiveQuotaMb(mailboxInfo ?? mailbox ?? null, isPremium);

  const storageData = useMemo(
    () => formatMailboxStorage(mailboxInfo?.usedMb ?? 0, maxMb),
    [mailboxInfo?.usedMb, maxMb],
  );

  const unreadInbox = useMemo(
    () => all.filter((m) => m.folder === "inbox" && !m.read).length,
    [all],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter((m) => {
        if (folder === "starred") return starred.has(m.id);
        return m.folder === folder;
      })
      .filter((m) => {
        if (filter === "unread") return !m.read;
        if (filter === "starred") return starred.has(m.id);
        return true;
      })
      .filter((m) =>
        q
          ? `${m.from} ${m.to} ${m.subject} ${m.body}`.toLowerCase().includes(q)
          : true,
      )
      .sort((a, b) => +new Date(b.date) - +new Date(a.date));
  }, [all, filter, folder, query, starred]);

  const opened = openedId ? all.find((m) => m.id === openedId) ?? null : null;

  useEffect(() => {
    setPage(0);
    setSelectedIndex(0);
    setChecked(new Set());
  }, [folder, query, filter, address]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const paged = visible.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const rangeStart = visible.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const rangeEnd = Math.min(visible.length, safePage * PAGE_SIZE + PAGE_SIZE);
  const allChecked = paged.length > 0 && paged.every((m) => checked.has(m.id));

  function toggleCheck(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleStar(id: string) {
    setStarred((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function markRead(ids: string[], read: boolean) {
    setAll((ms) => ms.map((m) => (ids.includes(m.id) ? { ...m, read } : m)));
    ids.forEach((id) => void api.messages.markRead(address, id, read).catch(() => undefined));
  }

  function deleteMessages(ids: string[]) {
    if (ids.length === 0) return;
    setAll((prev) => prev.filter((m) => !ids.includes(m.id)));
    setChecked((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    if (openedId && ids.includes(openedId)) mailRoute({ messageId: null });

    const refreshUsage = refreshMailboxInfo;

    if (ids.length === 1) {
      void api.messages.remove(address, ids[0]).then(refreshUsage).catch(() => undefined);
    } else {
      void api.messages.deleteMany(address, ids).then(refreshUsage).catch(() => undefined);
    }
  }

  async function clearCurrentFolder() {
    const folderName = folder === "inbox" ? "Inbox" : folder === "sent" ? "Sent" : "Starred";
    const count = visible.length;
    if (count === 0) return;
    const confirmed = window.confirm(`Permanently clear all ${count} message${count === 1 ? "" : "s"} in ${folderName}?`);
    if (!confirmed) return;

    try {
      const res = await api.messages.clearFolder(address, folder);
      setAll((prev) => prev.filter((m) => (folder === "starred" ? !m.starred : m.folder !== folder)));
      setChecked(new Set());
      if (openedId) mailRoute({ messageId: null });
      await refreshMailboxInfo();
      notify.success(`Cleared ${res.deletedCount} message${res.deletedCount === 1 ? "" : "s"} from ${folderName}`);
    } catch (err) {
      notify.error("Failed to clear folder: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  function openMessage(m: MailMessage) {
    mailRoute({ messageId: m.id });
    if (!m.read) markRead([m.id], true);
  }

  function startCompose(prefill?: { to?: string; subject?: string; body?: string }) {
    setComposePrefill(prefill ?? {});
    setComposeOpen(true);
  }

  async function sendMail(to: string, subject: string, body: string) {
    const cleanTo = to.trim();
    if (!cleanTo) throw new Error("Add a recipient first.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanTo)) throw new Error("That recipient address doesn't look right.");
    const cleanSubject = subject.trim() || "(no subject)";
    await api.messages.send(address, cleanTo, cleanSubject, body, undefined, activeDisplayName || undefined);
    const now = new Date().toISOString();
    const sent: MailMessage = {
      id: `local-${Date.now()}`,
      mailbox: address,
      folder: "sent",
      from: address,
      to: cleanTo,
      subject: cleanSubject,
      body,
      date: now,
      read: true,
    };
    setAll((ms) => [sent, ...ms]);
    setComposeOpen(false);
    setComposePrefill({});
    navigate({ view: "mail", folder: "sent", messageId: sent.id, account: route.account ?? undefined });
  }

  const actionsRef = useRef({ openMessage, deleteMessages, mailRoute, startCompose, toggleStar });
  useEffect(() => {
    actionsRef.current = { openMessage, deleteMessages, mailRoute, startCompose, toggleStar };
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable ||
        composeOpen ||
        shortcutsOpen
      ) {
        return;
      }

      if (e.key === "c" || e.key === "n") {
        e.preventDefault();
        actionsRef.current.startCompose();
      } else if (e.key === "j" || e.key === "ArrowDown") {
        if (!openedId && paged.length > 0) {
          e.preventDefault();
          setSelectedIndex((idx) => Math.min(paged.length - 1, idx + 1));
        }
      } else if (e.key === "k" || e.key === "ArrowUp") {
        if (!openedId && paged.length > 0) {
          e.preventDefault();
          setSelectedIndex((idx) => Math.max(0, idx - 1));
        }
      } else if (e.key === "Enter" || e.key === "o") {
        if (!openedId && paged[selectedIndex]) {
          e.preventDefault();
          actionsRef.current.openMessage(paged[selectedIndex]);
        }
      } else if (e.key === "u" || e.key === "Escape") {
        if (openedId) {
          e.preventDefault();
          actionsRef.current.mailRoute({ messageId: null });
        }
      } else if (e.key === "s") {
        if (openedId) {
          e.preventDefault();
          actionsRef.current.toggleStar(openedId);
          notify.info(starred.has(openedId) ? "Unstarred message" : "Starred message");
        } else if (paged[selectedIndex]) {
          e.preventDefault();
          actionsRef.current.toggleStar(paged[selectedIndex].id);
          notify.info(starred.has(paged[selectedIndex].id) ? "Unstarred message" : "Starred message");
        }
      } else if (e.key === "e" || e.key === "#" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) {
        if (openedId) {
          e.preventDefault();
          actionsRef.current.deleteMessages([openedId]);
          notify.info("Deleted message");
        } else if (checked.size > 0) {
          e.preventDefault();
          actionsRef.current.deleteMessages([...checked]);
          notify.info(`Deleted ${checked.size} message${checked.size === 1 ? "" : "s"}`);
        } else if (paged[selectedIndex]) {
          e.preventDefault();
          actionsRef.current.deleteMessages([paged[selectedIndex].id]);
          notify.info("Deleted message");
        }
      } else if (e.key === "r") {
        if (opened) {
          e.preventDefault();
          actionsRef.current.startCompose(replyPrefill(opened));
        }
      } else if (e.key === "f") {
        if (opened) {
          e.preventDefault();
          actionsRef.current.startCompose(forwardPrefill(opened));
        }
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [checked, composeOpen, opened, openedId, paged, selectedIndex, shortcutsOpen, starred]);

  if (!mailbox) {
    return (
      <div className="grid min-h-screen place-items-center bg-white px-4 text-center">
        <div className="max-w-md">
          <div className="flex justify-center">
            <Mark size={44} />
          </div>
          <h2 className="mt-4 text-[20px] font-semibold text-neutral-900">No mailbox account signed in</h2>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-neutral-500">
            Sign in with your mailbox email and password to view and compose messages.
          </p>
          <div className="mt-6 flex justify-center gap-2.5">
            <button
              onClick={() => onAddAccount?.()}
              className="rounded-md bg-neutral-900 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-neutral-800"
            >
              Mailbox login →
            </button>
            <button
              onClick={onGoLanding}
              className="rounded-md border border-neutral-200 bg-white px-4 py-2 text-[13px] font-semibold text-neutral-700 transition-colors hover:border-neutral-400"
            >
              Back to home
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-white text-neutral-900 antialiased">
      <header className="sticky top-0 z-30 border-b border-neutral-200/80 bg-white/95 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center justify-between gap-3 px-4 md:px-6">
          
          <div className="flex shrink-0 items-center gap-2.5">
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              aria-label="Toggle navigation menu"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-neutral-200 text-neutral-600 transition hover:border-neutral-400 hover:text-neutral-900 md:hidden"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            </button>

            <button
              onClick={onGoLanding}
              aria-label="MailerGo Home"
              title="Back to landing page"
              className="flex items-center gap-2 rounded-md px-1 py-1 transition hover:opacity-80"
            >
              <Mark size={24} />
              <span className="hidden font-display text-[15.5px] font-bold tracking-tight text-neutral-900 sm:inline">
                MailerGo
              </span>
            </button>
          </div>

          
          <div className="flex flex-1 items-center justify-center px-1 sm:px-4">
            <div className="relative w-full max-w-md lg:max-w-lg">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search mail by from, subject, body… (press / to focus)"
                aria-label="Search mail"
                className="h-9 w-full rounded-lg border border-neutral-200/90 bg-neutral-50/70 py-1.5 pl-9 pr-12 text-[12.5px] text-neutral-900 outline-none transition placeholder:text-neutral-400 hover:bg-neutral-50 focus:border-neutral-900 focus:bg-white focus:ring-1 focus:ring-neutral-900"
              />
              {query ? (
                <button
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-neutral-400 hover:text-neutral-900"
                >
                  Clear
                </button>
              ) : (
                <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-neutral-200/80 bg-white px-1.5 py-0.5 font-mono text-[10px] text-neutral-400 shadow-[0_1px_1px_rgba(0,0,0,0.03)] sm:inline">
                  /
                </kbd>
              )}
            </div>
          </div>

          
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <div className="relative">
              <button
                onClick={() => setAccountOpen((v) => !v)}
                aria-expanded={accountOpen}
                aria-label="Account menu"
                title={address}
                className="grid h-8 w-8 place-items-center rounded-full transition hover:opacity-80"
              >
                <span className={`grid h-8 w-8 place-items-center rounded-full text-[13px] font-bold ${avatarColor(address)}`} aria-hidden="true">
                  {initialOf(address)}
                </span>
              </button>

              {accountOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setAccountOpen(false)} />
                  <div className="absolute right-0 top-full z-50 mt-1.5 w-80 rounded-xl border border-neutral-200 bg-white p-2 shadow-2xl">
                    <div className="border-b border-neutral-100 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-neutral-400">
                            Active account
                          </p>
                          <p className="mt-1 truncate font-mono text-[13px] font-semibold text-neutral-900" title={address}>
                            {address}
                          </p>
                          {activeDisplayName ? (
                            <p className="mt-0.5 truncate text-[11.5px] text-neutral-500" title={`Sender name: ${activeDisplayName}`}>
                              Sender: <span className="font-medium text-neutral-800">{activeDisplayName}</span>
                            </p>
                          ) : (
                            <p className="mt-0.5 text-[11px] text-neutral-400">
                              No sender name set
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setAccountOpen(false);
                            setSenderSettingsOpen(true);
                          }}
                          title="Sender name settings"
                          aria-label="Sender name settings"
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-900"
                        >
                          <Settings className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="mt-2.5">
                        <div className="flex items-center justify-between text-[11px] text-neutral-500">
                          <span>{storageData.formatted} used</span>
                          <span>{storageData.isUnlimited ? "Unlimited" : storageData.maxLabel}</span>
                        </div>
                        {!storageData.isUnlimited && (
                          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
                            <div className="h-full rounded-full bg-neutral-900 transition-all" style={{ width: `${storageData.pct}%` }} />
                          </div>
                        )}
                      </div>
                    </div>

                    {accounts.length > 1 && (
                      <div className="border-b border-neutral-100 py-1">
                        <p className="px-3 py-1 font-mono text-[10.5px] font-semibold uppercase tracking-wider text-neutral-400">
                          Switch mailbox ({accounts.length})
                        </p>
                        <div className="max-h-48 overflow-y-auto">
                          {accounts.map((acc) => {
                            const isCurrent = acc.address.toLowerCase() === address.toLowerCase();
                            return (
                              <div
                                key={acc.address}
                                className={`flex items-center justify-between gap-2 px-3 py-2 text-[12.5px] ${isCurrent ? "bg-neutral-100 font-semibold" : "hover:bg-neutral-50"
                                  }`}
                              >
                                <button
                                  onClick={() => switchTo(acc.address)}
                                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                >
                                  <span className={`grid h-5 w-5 shrink-0 place-items-center rounded text-[10px] font-bold ${avatarColor(acc.address)}`}>
                                    {initialOf(acc.address)}
                                  </span>
                                  <span className="truncate">{acc.address}</span>
                                </button>
                                <button
                                  onClick={() => void removeMailbox(acc.address)}
                                  title="Sign out this account"
                                  aria-label={`Sign out ${acc.address}`}
                                  className="text-neutral-400 hover:text-red-600"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div className="pt-1">
                      <button
                        onClick={() => {
                          setAccountOpen(false);
                          onAddAccount?.();
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[12.5px] font-semibold text-neutral-700 hover:bg-neutral-100"
                      >
                        <span>+</span> Add another mailbox…
                      </button>
                      <button
                        onClick={() => {
                          setAccountOpen(false);
                          void removeMailbox(address);
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[12.5px] font-semibold text-red-600 hover:bg-red-50"
                      >
                        Sign out {address}
                      </button>
                      {accounts.length > 1 && (
                        <button
                          onClick={() => {
                            setAccountOpen(false);
                            void signOutAll();
                          }}
                          className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[11.5px] font-semibold text-red-500 hover:bg-red-50"
                        >
                          Sign out of all ({accounts.length})
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1440px] flex-1 px-4 py-4 md:px-6 md:py-6">
        {sidebarOpen && (
          <div className="fixed inset-0 z-40 bg-neutral-950/40 md:hidden" onClick={() => setSidebarOpen(false)} />
        )}

        <aside
          className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-neutral-200 bg-white p-4 transition-transform md:static md:z-auto md:w-56 md:border-0 md:p-0 md:pr-6 md:translate-x-0 ${sidebarOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"
            }`}
        >
          <div className="mb-4 flex items-center justify-between md:hidden">
            <span className="font-display text-[15px] font-bold">Mailbox</span>
            <button onClick={() => setSidebarOpen(false)} aria-label="Close sidebar" className="rounded p-1 text-neutral-400 hover:text-neutral-900"><X className="h-4 w-4" /></button>
          </div>

          <button
            onClick={() => {
              setSidebarOpen(false);
              startCompose();
            }}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-neutral-900 py-2.5 text-[13px] font-semibold text-white transition hover:bg-neutral-800"
          >
            <PencilIcon size={14} />
            Compose
            <kbd className="hidden rounded bg-white/20 px-1 font-mono text-[10px] md:inline">c</kbd>
          </button>

          <nav className="mt-5 space-y-1" aria-label="Mail folders">
            {NAV.map((item) => {
              const active = folder === item.id;
              const count = item.id === "inbox" ? unreadInbox : item.id === "starred" ? starred.size : 0;
              return (
                <button
                  key={item.id}
                  onClick={() => goFolder(item.id)}
                  className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-[13px] font-semibold transition ${active ? "bg-neutral-100 text-neutral-950" : "text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900"
                    }`}
                >
                  <span className="flex items-center gap-2.5">
                    <span className={active ? "text-neutral-900" : "text-neutral-400"}>{item.icon}</span>
                    {item.label}
                  </span>
                  {count > 0 && (
                    <span className={`rounded-md px-1.5 py-0.2 font-mono text-[11px] font-bold ${active ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-600"
                      }`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="mt-auto border-t border-neutral-100 pt-4">
            <div className="rounded-xl border border-neutral-200 bg-neutral-50/70 p-3">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-mono font-medium text-neutral-500">QUOTA</span>
                <span className="font-mono text-neutral-700">{storageData.formatted} / {storageData.maxLabel}</span>
              </div>
              {!storageData.isUnlimited && (
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200">
                  <div
                    className="h-full rounded-full bg-neutral-900 transition-all duration-300"
                    style={{ width: `${storageData.pct}%` }}
                  />
                </div>
              )}
              <p className="mt-2 font-mono text-[10.5px] text-neutral-400">
                {storageData.isUnlimited
                  ? `Unlimited storage · ${mailboxInfo?.kind ?? "standard"}`
                  : `${storageData.pct.toFixed(0)}% full · ${mailboxInfo?.kind ?? "standard"}`}
              </p>
            </div>

            <div className="mt-3 flex items-center justify-between text-[11px] text-neutral-400">
              <button
                onClick={() => setShortcutsOpen(true)}
                className="hover:text-neutral-900"
              >
                Shortcuts (?)
              </button>
              <button
                onClick={onGoDashboard}
                className="hover:text-neutral-900"
              >
                Dashboard
              </button>
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white">
          {loadError && (
            <div className="border-b border-red-100 bg-red-50 p-4">
              <p className="text-[13px] text-red-700">{loadError}</p>
            </div>
          )}

          {opened ? (
            <ReadingView
              message={opened}
              starred={starred.has(opened.id)}
              onBack={() => mailRoute({ messageId: null })}
              onToggleStar={() => toggleStar(opened.id)}
              onDelete={() => deleteMessages([opened.id])}
              onToggleRead={() => markRead([opened.id], !opened.read)}
              onReply={() => startCompose(replyPrefill(opened))}
              onForward={() => startCompose(forwardPrefill(opened))}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 px-4 py-2.5">
                <div className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) => {
                      if (e.target.checked) setChecked(new Set(paged.map((m) => m.id)));
                      else setChecked(new Set());
                    }}
                    aria-label="Select all on this page"
                    className="h-4 w-4 rounded border-neutral-300"
                  />
                  <ToolbarButton label="Refresh" onClick={() => void loadMessages()}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>
                  </ToolbarButton>

                  {checked.size === 0 && visible.length > 0 && (
                    <ToolbarButton
                      label={folder === "inbox" ? "Clear Inbox" : `Clear ${folder}`}
                      onClick={() => void clearCurrentFolder()}
                    >
                      <TrashIcon />
                    </ToolbarButton>
                  )}

                  {checked.size > 0 && (
                    <>
                      <ToolbarButton label="Delete" onClick={() => deleteMessages([...checked])}>
                        <TrashIcon />
                      </ToolbarButton>
                      <ToolbarButton label="Mark read" onClick={() => markRead([...checked], true)}>
                        <EnvelopeIcon />
                      </ToolbarButton>
                      <ToolbarButton label="Mark unread" onClick={() => markRead([...checked], false)}>
                        <EnvelopeIcon filled />
                      </ToolbarButton>
                      <span className="ml-2 font-mono text-[11px] text-neutral-400">
                        {checked.size} selected
                      </span>
                    </>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <div className="hidden items-center gap-1 sm:flex">
                    {(["all", "unread", "starred"] as const).map((mode) => {
                      const active = filter === mode;
                      const count = mode === "unread" ? unreadInbox : mode === "starred" ? starred.size : null;
                      return (
                        <button
                          key={mode}
                          onClick={() => setFilter(mode)}
                          className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold capitalize transition ${active ? "bg-neutral-900 text-white" : "text-neutral-500 hover:text-neutral-900"
                            }`}
                        >
                          {mode}
                          {count !== null && count > 0 && <span className="ml-1 opacity-70">({count})</span>}
                        </button>
                      );
                    })}
                  </div>

                  <span className="font-mono text-[11.5px] text-neutral-400">
                    {visible.length === 0 ? "0" : `${rangeStart}–${rangeEnd} of ${visible.length}`}
                  </span>
                  <div className="flex items-center gap-0.5">
                    <button
                      disabled={page === 0}
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      aria-label="Previous page"
                      className="grid h-7 w-7 place-items-center rounded text-neutral-600 hover:bg-neutral-100 disabled:opacity-30"
                    >
                      ‹
                    </button>
                    <button
                      disabled={page >= totalPages - 1}
                      onClick={() => setPage((p) => p + 1)}
                      aria-label="Next page"
                      className="grid h-7 w-7 place-items-center rounded text-neutral-600 hover:bg-neutral-100 disabled:opacity-30"
                    >
                      ›
                    </button>
                  </div>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {loading && all.length === 0 ? (
                  <div className="grid place-items-center py-24 text-neutral-400">
                    <svg className="h-6 w-6 animate-spin text-neutral-900" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>
                    <p className="mt-3 text-[13px]">Loading messages…</p>
                  </div>
                ) : paged.length === 0 ? (
                  <div className="grid place-items-center py-24 text-center">
                    <div className="mb-2 grid h-12 w-12 place-items-center rounded-full bg-neutral-100 text-neutral-400">
                      <Inbox className="h-6 w-6 stroke-[1.5]" />
                    </div>
                    <p className="mt-2 text-[15px] font-semibold text-neutral-900">
                      {query ? "No matches" : folder === "inbox" ? "Inbox zero. Enjoy it." : folder === "starred" ? "No starred mail" : "Nothing sent yet"}
                    </p>
                    <p className="mt-1 max-w-xs text-[12.5px] text-neutral-500">
                      {query ? "Try a different search query." : "New messages appear here in real time via live WebSocket."}
                    </p>
                    {folder === "inbox" && !query && (
                      <button
                        onClick={() => startCompose()}
                        className="mt-4 rounded-md bg-neutral-900 px-4 py-2 text-[12.5px] font-semibold text-white"
                      >
                        Compose a message
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="divide-y divide-neutral-100">
                    {paged.map((m, idx) => {
                      const isChecked = checked.has(m.id);
                      const isStarred = starred.has(m.id);
                      const isSelected = idx === selectedIndex;
                      return (
                        <div
                          key={m.id}
                          onClick={() => openMessage(m)}
                          className={`group flex cursor-pointer items-center gap-3 px-4 py-3 transition ${!m.read ? "bg-white font-semibold" : "bg-neutral-50/40 text-neutral-700"
                            } ${isSelected ? "ring-1 ring-inset ring-neutral-900/30" : ""} hover:bg-neutral-100/70`}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleCheck(m.id)}
                            aria-label={`Select message from ${m.from}`}
                            className="h-4 w-4 shrink-0 rounded border-neutral-300"
                          />
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleStar(m.id);
                            }}
                            aria-label={isStarred ? "Unstar" : "Star"}
                            aria-pressed={isStarred}
                            className="grid h-6 w-6 shrink-0 place-items-center rounded text-neutral-300 hover:text-amber-500"
                          >
                            <StarIcon filled={isStarred} className={isStarred ? "text-amber-500" : ""} />
                          </button>

                          <div className="w-44 shrink-0 truncate text-[13px]">
                            {folder === "sent" ? `To: ${senderName(m.to)}` : senderName(m.from)}
                          </div>

                          <div className="min-w-0 flex-1 truncate text-[13px]">
                            <span className={!m.read ? "font-semibold text-neutral-950" : "font-normal text-neutral-800"}>
                              {m.subject || "(no subject)"}
                            </span>
                            <span className="mx-2 text-neutral-300">·</span>
                            <span className="font-normal text-neutral-400">
                              {snippet(m.body)}
                            </span>
                          </div>

                          <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
                            <RowAction label="Delete" onClick={() => deleteMessages([m.id])}>
                              <TrashIcon size={14} />
                            </RowAction>
                            <RowAction label={m.read ? "Mark unread" : "Mark read"} onClick={() => markRead([m.id], !m.read)}>
                              <EnvelopeIcon size={14} />
                            </RowAction>
                          </div>

                          <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-neutral-400">
                            {formatDate(m.date)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>

      <button
        onClick={() => startCompose()}
        aria-label="Compose"
        className="fixed bottom-6 right-6 grid h-14 w-14 place-items-center rounded-md bg-neutral-900 text-white md:hidden"
      >
        <PencilIcon size={22} />
      </button>

      {composeOpen && (
        <ComposeModal
          key={`${composePrefill.to ?? ""}|${composePrefill.subject ?? ""}`}
          from={address}
          fromName={activeDisplayName}
          prefill={composePrefill}
          onClose={() => setComposeOpen(false)}
          onSend={sendMail}
        />
      )}

      {senderSettingsOpen && (
        <SenderNameModal
          address={address}
          initialName={activeDisplayName}
          onClose={() => setSenderSettingsOpen(false)}
          onSaved={(newName) => {
            setMailboxInfo((prev) =>
              prev ? { ...prev, displayName: newName, display_name: newName } : prev
            );
            updateMailbox({
              address,
              displayName: newName,
              display_name: newName,
            });
          }}
        />
      )}

      {shortcutsOpen && <KeyboardShortcutsModal onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}

function ToolbarButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid h-8 w-8 place-items-center rounded-md text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
    >
      {children}
    </button>
  );
}

function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={label}
      aria-label={label}
      className="grid h-7 w-7 place-items-center rounded text-neutral-400 hover:bg-neutral-200/70 hover:text-neutral-900"
    >
      {children}
    </button>
  );
}

function ReadingView({
  message,
  starred,
  onBack,
  onToggleStar,
  onDelete,
  onToggleRead,
  onReply,
  onForward,
}: {
  message: MailMessage;
  starred: boolean;
  onBack: () => void;
  onToggleStar: () => void;
  onDelete: () => void;
  onToggleRead: () => void;
  onReply: () => void;
  onForward: () => void;
}) {
  const [view, setView] = useState<"reading" | "gmail">("reading");
  const [showHeaders, setShowHeaders] = useState(false);
  const content = useMemo(() => getCleanMessageContent(message), [message]);
  const [format, setFormat] = useState<"html" | "text">(() => (content.html ? "html" : "text"));

  useEffect(() => {
    setFormat(content.html ? "html" : "text");
    setView("reading");
    setShowHeaders(false);
  }, [message.id, content.html]);

  const dateLocale = useMemo(() => {
    const d = new Date(message.date);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
  }, [message.date]);
  const dateUtc = useMemo(() => {
    const d = new Date(message.date);
    return Number.isNaN(d.getTime()) ? "—" : d.toUTCString();
  }, [message.date]);

  const doc = useMemo(() => {
    if (!content.html) return "";
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:20px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#171717;font-size:14.5px;line-height:1.65;">${content.html}</body></html>`;
  }, [content.html]);

  return (
    <div>
      <div className="flex items-center gap-1 border-b border-neutral-100 px-3 py-2">
        <ToolbarButton label="Back" onClick={onBack}>
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M12.5 4 7 10l5.5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </ToolbarButton>
        <ToolbarButton label="Delete" onClick={onDelete}>
          <TrashIcon size={17} />
        </ToolbarButton>
        <ToolbarButton label={message.read ? "Mark unread" : "Mark read"} onClick={onToggleRead}>
          <EnvelopeIcon size={17} />
        </ToolbarButton>
        <div className="ml-auto flex items-center gap-2">
          <div className="grid grid-cols-2 rounded-md border border-neutral-200 bg-neutral-50 p-1" role="tablist" aria-label="Reading view">
            {(["reading", "gmail"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={view === t}
                onClick={() => setView(t)}
                className={`cursor-pointer rounded-md px-3.5 py-1 text-[12px] font-semibold transition-colors ${view === t ? "bg-neutral-900 text-white" : "text-neutral-500 hover:text-neutral-900"
                  }`}
              >
                {t === "gmail" ? "Receiver view" : "Reading"}
              </button>
            ))}
          </div>
          <span className="hidden font-mono text-[12px] tabular-nums text-neutral-400 lg:block">{dateLocale}</span>
        </div>
      </div>

      {view === "gmail" ? (
        <div className="bg-neutral-50 px-5 py-6 sm:px-8">
          <GmailPreview
            from={message.from}
            to={message.to}
            subject={message.subject}
            body={content.text}
            html={content.html}
            date={message.date}
          />
          <p className="mt-3 text-center font-mono text-[11px] text-neutral-400">
            receiver view · how this message renders inside Gmail
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button onClick={onReply} className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-neutral-900 px-5 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-neutral-700">
              <Reply className="h-4 w-4" />
              Reply
            </button>
            <button onClick={onForward} className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-neutral-200 px-5 py-2.5 text-[13px] font-semibold transition-colors hover:border-neutral-900">
              <Forward className="h-4 w-4" />
              Forward
            </button>
          </div>
        </div>
      ) : (
        <div className="px-5 pb-10 pt-4 sm:px-8">
          <div className="flex items-start justify-between gap-3">
            <h1 className="min-w-0 flex-1 text-[22px] font-semibold leading-tight tracking-tight sm:text-[26px]">
              {message.subject}
            </h1>
            <button
              onClick={onToggleStar}
              aria-label={starred ? "Unstar" : "Star"}
              aria-pressed={starred}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-md hover:bg-neutral-100"
            >
              <StarIcon size={19} filled={starred} className={starred ? "text-amber-500" : "text-neutral-300"} />
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-3.5">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-[14px] font-bold ${avatarColor(message.from)}`} aria-hidden="true">
                {initialOf(message.from)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px]">
                  <span className="font-semibold">{senderName(message.from)}</span>
                  <span className="ml-2 font-mono text-[12px] font-normal text-neutral-400">&lt;{message.from}&gt;</span>
                </p>
                <p className="truncate text-[12.5px] text-neutral-500">to {message.to}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowHeaders((v) => !v)}
                className="cursor-pointer rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-[11.5px] font-semibold text-neutral-600 transition-colors hover:border-neutral-400 hover:text-neutral-900"
              >
                {showHeaders ? "Hide details" : "View details"}
              </button>
              <CopyButton text={content.text} label="Copy body" notifyMessage="Email body copied to clipboard" />
              <span className="hidden shrink-0 text-[12px] tabular-nums text-neutral-400 sm:block">{formatDate(message.date)}</span>
            </div>
          </div>

          {showHeaders && (
            <div className="mt-2.5 rounded-xl border border-neutral-200 bg-white p-3.5 font-mono text-[11.5px] shadow-xs">
              <div className="grid gap-1.5 text-neutral-700">
                <div className="flex justify-between gap-2 border-b border-neutral-100 pb-1.5">
                  <span className="text-neutral-400">Message-ID</span>
                  <span className="truncate">{message.id}</span>
                </div>
                <div className="flex justify-between gap-2 border-b border-neutral-100 pb-1.5">
                  <span className="text-neutral-400">Date</span>
                  <span>{dateUtc}</span>
                </div>
                <div className="flex justify-between gap-2 border-b border-neutral-100 pb-1.5">
                  <span className="text-neutral-400">Security</span>
                  <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> Authenticated MX Transmission</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-neutral-400">Folder</span>
                  <span className="uppercase">{message.folder}</span>
                </div>
              </div>
            </div>
          )}

          {content.html && (
            <div className="mt-4 flex items-center justify-between border-b border-neutral-100 pb-2.5">
              <div className="inline-flex rounded-lg border border-neutral-200 bg-neutral-100/70 p-0.5 text-[11.5px] font-medium text-neutral-600">
                <button
                  type="button"
                  onClick={() => setFormat("html")}
                  className={`cursor-pointer rounded-md px-3 py-1 transition-all ${format === "html"
                    ? "bg-white font-semibold text-neutral-900 shadow-sm"
                    : "hover:text-neutral-900"
                    }`}
                >
                  Formatted (HTML)
                </button>
                <button
                  type="button"
                  onClick={() => setFormat("text")}
                  className={`cursor-pointer rounded-md px-3 py-1 transition-all ${format === "text"
                    ? "bg-white font-semibold text-neutral-900 shadow-sm"
                    : "hover:text-neutral-900"
                    }`}
                >
                  Plain text
                </button>
              </div>
              <span className="font-mono text-[11px] text-neutral-400">
                {format === "html" ? "Rich HTML view" : "Plain text view"}
              </span>
            </div>
          )}

          {format === "html" && content.html ? (
            <div className="mt-4 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
              <iframe
                title="Email HTML body"
                sandbox=""
                referrerPolicy="no-referrer"
                srcDoc={doc}
                className="h-[520px] w-full bg-white xl:h-[680px]"
              />
            </div>
          ) : (
            <div className="mt-5 max-w-3xl space-y-3 text-[14.5px] leading-[1.75] text-neutral-800">
              {content.text ? (
                content.text.split(/\n{2,}/).map((p: string, i: number) => (
                  <p key={i} className="whitespace-pre-wrap">
                    {p}
                  </p>
                ))
              ) : (
                <p className="text-neutral-400">(empty body)</p>
              )}
            </div>
          )}

          <div className="mt-8 flex flex-wrap gap-2">
            <button onClick={onReply} className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-neutral-900 px-5 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-neutral-700">
              <Reply className="h-4 w-4" />
              Reply
            </button>
            <button onClick={onForward} className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-neutral-200 px-5 py-2.5 text-[13px] font-semibold transition-colors hover:border-neutral-900">
              <Forward className="h-4 w-4" />
              Forward
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
