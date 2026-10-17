import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api, type Mailbox } from "./api";
import { useConfirm } from "./confirm";

const LIST_KEY = "mailergo.mailboxSessions";
const ACTIVE_KEY = "mailergo.mailboxActive";
const LEGACY_KEY = "mailergo.mailboxSession";

interface MailboxContextValue {
  mailbox: Mailbox | null;
  accounts: Mailbox[];
  activeAddress: string | null;
  mailboxLoading: boolean;
  mailboxBusy: boolean;
  mailboxLogin: (address: string, password: string) => Promise<void>;
  switchMailbox: (address: string) => void;
  openMailboxSession: (box: Mailbox) => void;
  updateMailbox: (patch: Partial<Mailbox> & { address: string }) => void;
  removeMailbox: (address: string) => Promise<void> | void;
  signOutAll: () => Promise<void> | void;
  mailboxLogout: () => Promise<void> | void;
}

const MailboxContext = createContext<MailboxContextValue | null>(null);

function isMailbox(v: unknown): v is Mailbox {
  return typeof v === "object" && v !== null && typeof (v as Mailbox).address === "string";
}

function readStoredAccounts(): { accounts: Mailbox[]; active: string | null } {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const accounts = parsed.filter(isMailbox);
        const activeRaw = localStorage.getItem(ACTIVE_KEY);
        const active = accounts.some((a) => a.address === activeRaw) ? activeRaw : (accounts[0]?.address ?? null);
        return { accounts, active };
      }
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as unknown;
      if (isMailbox(parsed)) {
        localStorage.setItem(LIST_KEY, JSON.stringify([parsed]));
        localStorage.setItem(ACTIVE_KEY, parsed.address);
        localStorage.removeItem(LEGACY_KEY);
        return { accounts: [parsed], active: parsed.address };
      }
    }
  } catch {}
  return { accounts: [], active: null };
}

function persist(accounts: Mailbox[], active: string | null) {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(accounts));
    if (active) localStorage.setItem(ACTIVE_KEY, active);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {}
}

export function MailboxProvider({ children }: { children: ReactNode }) {
  const confirm = useConfirm();
  const [initialData] = useState(readStoredAccounts);
  const [accounts, setAccounts] = useState<Mailbox[]>(initialData.accounts);
  const [activeAddress, setActiveAddress] = useState<string | null>(initialData.active);
  const [mailboxLoading] = useState(false);
  const [mailboxBusy, setMailboxBusy] = useState(false);

  const mailbox = useMemo(
    () => accounts.find((a) => a.address === activeAddress) ?? accounts[0] ?? null,
    [accounts, activeAddress],
  );

  const mailboxLogin = useCallback(async (address: string, password: string) => {
    setMailboxBusy(true);
    try {
      const box = await api.mailbox.login(address, password);
      setAccounts((prev) => {
        const rest = prev.filter((a) => a.address.toLowerCase() !== box.address.toLowerCase());
        const next = [box, ...rest];
        persist(next, box.address);
        return next;
      });
      setActiveAddress(box.address);
    } finally {
      setMailboxBusy(false);
    }
  }, []);

  const switchMailbox = useCallback(
    (address: string) => {
      const found = accounts.find((a) => a.address.toLowerCase() === address.toLowerCase());
      if (!found) return;
      setActiveAddress(found.address);
      persist(accounts, found.address);
    },
    [accounts],
  );

  const openMailboxSession = useCallback((box: Mailbox) => {
    setAccounts((prev) => {
      const rest = prev.filter((a) => a.address.toLowerCase() !== box.address.toLowerCase());
      const next = [box, ...rest];
      persist(next, box.address);
      return next;
    });
    setActiveAddress(box.address);
  }, []);

  const updateMailbox = useCallback((patch: Partial<Mailbox> & { address: string }) => {
    setAccounts((prev) => {
      const next = prev.map((a) =>
        a.address.toLowerCase() === patch.address.toLowerCase() ? { ...a, ...patch } : a
      );
      persist(next, activeAddress);
      return next;
    });
  }, [activeAddress]);

  const removeMailbox = useCallback(
    async (address: string) => {
      const ok = await confirm({
        title: "Sign out mailbox",
        message: `Are you sure you want to sign out of ${address}?`,
        confirmLabel: "Sign out",
        danger: true,
      });
      if (!ok) return;
      setAccounts((prev) => {
        const next = prev.filter((a) => a.address.toLowerCase() !== address.toLowerCase());
        const nextActive = activeAddress && activeAddress.toLowerCase() === address.toLowerCase() ? (next[0]?.address ?? null) : activeAddress;
        setActiveAddress(nextActive);
        persist(next, nextActive);
        return next;
      });
    },
    [activeAddress, confirm],
  );

  const signOutAll = useCallback(async () => {
    if (accounts.length === 0) return;
    const ok = await confirm({
      title: "Sign out of all mailboxes",
      message: `Are you sure you want to sign out of all ${accounts.length} mailbox${accounts.length === 1 ? "" : "es"}?`,
      confirmLabel: "Sign out all",
      danger: true,
    });
    if (!ok) return;
    setAccounts([]);
    setActiveAddress(null);
    persist([], null);
  }, [accounts.length, confirm]);

  const mailboxLogout = useCallback(async () => {
    const current = accounts.find((a) => a.address === activeAddress) ?? accounts[0];
    if (!current) return;
    await removeMailbox(current.address);
  }, [accounts, activeAddress, removeMailbox]);

  const value = useMemo(
    () => ({
      mailbox,
      accounts,
      activeAddress: mailbox?.address ?? null,
      mailboxLoading,
      mailboxBusy,
      mailboxLogin,
      switchMailbox,
      openMailboxSession,
      updateMailbox,
      removeMailbox,
      signOutAll,
      mailboxLogout,
    }),
    [mailbox, accounts, mailboxLoading, mailboxBusy, mailboxLogin, switchMailbox, openMailboxSession, updateMailbox, removeMailbox, signOutAll, mailboxLogout],
  );

  return <MailboxContext.Provider value={value}>{children}</MailboxContext.Provider>;
}

export const useMailbox = (): MailboxContextValue => {
  const ctx = useContext(MailboxContext);
  if (!ctx) throw new Error("useMailbox must be used inside <MailboxProvider>");
  return ctx;
};
