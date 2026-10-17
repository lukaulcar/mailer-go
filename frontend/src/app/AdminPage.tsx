import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../lib/auth";
import { useMailbox } from "../lib/mailboxAuth";
import { useConfirm } from "../lib/confirm";
import { navigate } from "../lib/router";
import { Mark } from "../components/Header";
import { api, getErrorMessage, type AdminUserItem } from "../lib/api";
import { notify } from "../lib/toast";
import { Search, RefreshCw, Check, Ban, Trash2, ArrowLeft } from "lucide-react";

export default function AdminPage({
  onGoDashboard,
  onGoLanding,
}: {
  onGoDashboard: () => void;
  onGoLanding: () => void;
}) {
  const { user, logout } = useAuth();
  const { accounts } = useMailbox();
  const confirm = useConfirm();

  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "pending" | "approved" | "blocked">("all");
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<string>("live");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.admin.listUsers();
      setUsers(res.users);
      if (res.mode) setMode(res.mode);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load registered users"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const handleSetStatus = async (targetUser: AdminUserItem, newStatus: "approved" | "blocked") => {
    setActionBusy(targetUser.id);
    try {
      await api.admin.setUserStatus(targetUser.id, newStatus);
      setUsers((prev) =>
        prev.map((u) => (u.id === targetUser.id ? { ...u, status: newStatus } : u)),
      );
      notify.success(
        newStatus === "approved" ? "User approved" : "User blocked",
        `${targetUser.email} is now ${newStatus}.`,
      );
    } catch (err) {
      notify.error("Status update failed", getErrorMessage(err, "Could not update user status"));
    } finally {
      setActionBusy(null);
    }
  };

  const handleDelete = async (targetUser: AdminUserItem) => {
    const ok = await confirm({
      title: "Delete User",
      message: `Are you sure you want to delete user ${targetUser.email}? This will permanently remove all their domains, mailboxes, and stored emails.`,
      confirmLabel: "Delete User",
      danger: true,
    });
    if (!ok) return;

    setActionBusy(targetUser.id);
    try {
      await api.admin.deleteUser(targetUser.id);
      setUsers((prev) => prev.filter((u) => u.id !== targetUser.id));
      notify.success("User deleted", `${targetUser.email} was removed permanently.`);
    } catch (err) {
      notify.error("Delete failed", getErrorMessage(err, "Could not delete user"));
    } finally {
      setActionBusy(null);
    }
  };

  const counts = useMemo(() => {
    const total = users.length;
    const pending = users.filter((u) => u.status === "pending").length;
    const approved = users.filter((u) => u.status === "approved").length;
    const blocked = users.filter((u) => u.status === "blocked").length;
    return { total, pending, approved, blocked };
  }, [users]);

  const filteredUsers = useMemo(() => {
    return users.filter((u) => {
      if (filter !== "all" && u.status !== filter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return u.email.toLowerCase().includes(q) || u.id.toLowerCase().includes(q);
      }
      return true;
    });
  }, [users, filter, search]);

  return (
    <div className="min-h-screen bg-white text-neutral-900">

      <header className="sticky top-0 z-30 border-b border-neutral-200 bg-white/95 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center justify-between gap-3 px-4 md:px-6">
          <div className="flex items-center gap-2">
            <button
              className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1"
              onClick={onGoLanding}
              aria-label="MailerGo home"
            >
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
                  <button
                    aria-label="Close menu"
                    className="fixed inset-0 z-10 cursor-default"
                    onClick={() => setMenu(false)}
                  />
                  <div
                    role="menu"
                    className="absolute right-0 top-11 z-20 w-64 overflow-hidden rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl"
                  >
                    <div className="px-3 py-2.5">
                      <p className="truncate text-[13px] font-semibold">{user?.email}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-neutral-500">
                        {user?.isAdmin ? "Administrator" : "User"}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        onGoDashboard();
                        setMenu(false);
                      }}
                      className="w-full cursor-pointer rounded-md px-3 py-2 text-left text-[13px] font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
                    >
                      Domains Dashboard
                    </button>
                    <button
                      onClick={() => {
                        navigate({ view: "mail", folder: "inbox" });
                        setMenu(false);
                      }}
                      className="w-full cursor-pointer rounded-md px-3 py-2 text-left text-[13px] font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
                    >
                      Go to webmail
                    </button>
                    <button
                      onClick={() => {
                        void logout();
                      }}
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
      </header>

      <main className="mx-auto w-full max-w-[1200px] px-4 pb-20 pt-6 md:px-6">

        <div className="mb-4 flex items-center justify-between">
          <button
            onClick={onGoDashboard}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-neutral-500 hover:text-neutral-900 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back to Domains</span>
          </button>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-neutral-200 pb-6">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-[26px] font-bold tracking-tight text-neutral-900">
                User Approvals & Quotas
              </h1>
              <span className="rounded-full bg-neutral-100 border border-neutral-200 px-3 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-neutral-700">
                {mode === "live" ? "Live Mode (Quotas & Approvals)" : "Local Mode (Unlimited)"}
              </span>
            </div>
            <p className="mt-1 text-[14px] text-neutral-600">
              Review and approve signups, control user access, and enforce multi-tenant quotas.
            </p>
          </div>

          <button
            onClick={fetchUsers}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3.5 py-2 text-[13px] font-semibold text-neutral-700 shadow-xs hover:border-neutral-900 hover:text-neutral-900 transition-colors disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <button
            onClick={() => setFilter("pending")}
            className={`rounded-xl border p-4 text-left transition-all ${
              filter === "pending"
                ? "border-neutral-900 bg-white ring-1 ring-neutral-900 shadow-xs"
                : "border-neutral-200 bg-white hover:border-neutral-400"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-neutral-500">Pending Approval</span>
              {counts.pending > 0 && (
                <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
              )}
            </div>
            <p className={`mt-2 text-[26px] font-bold tabular-nums ${counts.pending > 0 ? "text-amber-600" : "text-neutral-900"}`}>
              {counts.pending}
            </p>
          </button>

          <button
            onClick={() => setFilter("approved")}
            className={`rounded-xl border p-4 text-left transition-all ${
              filter === "approved"
                ? "border-emerald-500 bg-emerald-50/50 ring-2 ring-emerald-500/20"
                : "border-neutral-200 bg-white hover:border-neutral-400"
            }`}
          >
            <span className="text-[12px] font-medium text-neutral-500">Approved & Active</span>
            <p className="mt-2 text-[26px] font-bold tabular-nums text-emerald-600">
              {counts.approved}
            </p>
          </button>

          <button
            onClick={() => setFilter("blocked")}
            className={`rounded-xl border p-4 text-left transition-all ${
              filter === "blocked"
                ? "border-neutral-900 bg-neutral-50 ring-2 ring-neutral-900/10"
                : "border-neutral-200 bg-white hover:border-neutral-400"
            }`}
          >
            <span className="text-[12px] font-medium text-neutral-500">Blocked</span>
            <p className="mt-2 text-[26px] font-bold tabular-nums text-neutral-700">
              {counts.blocked}
            </p>
          </button>

          <button
            onClick={() => setFilter("all")}
            className={`rounded-xl border p-4 text-left transition-all ${
              filter === "all"
                ? "border-neutral-900 bg-neutral-50 ring-2 ring-neutral-900/10"
                : "border-neutral-200 bg-white hover:border-neutral-400"
            }`}
          >
            <span className="text-[12px] font-medium text-neutral-500">Total Users</span>
            <p className="mt-2 text-[26px] font-bold tabular-nums text-neutral-900">
              {counts.total}
            </p>
          </button>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-neutral-50/60 p-3">
          <div className="relative min-w-[280px] flex-1 max-w-md">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-neutral-400" />
            <input
              type="text"
              placeholder="Filter by email address or ID..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-lg border border-neutral-200 bg-white py-1.5 pl-9 pr-3 text-[13px] text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1">
            {(["all", "pending", "approved", "blocked"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium capitalize transition-colors ${
                  filter === f
                    ? "bg-neutral-900 text-white font-semibold"
                    : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-neutral-200 bg-white p-4 text-[13px] text-red-600 shadow-xs">
            {error}
          </div>
        )}

        <div className="mt-6 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xs">
          {loading && users.length === 0 ? (
            <div className="grid place-items-center py-20 text-neutral-400">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-900" />
              <p className="mt-3 text-[13.5px]">Loading registered users...</p>
            </div>
          ) : filteredUsers.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-[15px] font-semibold text-neutral-700">No users found</p>
              <p className="mt-1 text-[13px] text-neutral-400">
                {search ? "No accounts match your search filter." : `No users with status "${filter}".`}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="border-b border-neutral-200 bg-neutral-50/80 font-semibold text-neutral-600">
                  <tr>
                    <th className="py-3 pl-5 pr-3">User Email</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Plan / Quotas</th>
                    <th className="px-3 py-3 text-center">Resources</th>
                    <th className="px-3 py-3 text-right">Signed Up</th>
                    <th className="py-3 pl-3 pr-5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200">
                  {filteredUsers.map((u) => {
                    const isBusy = actionBusy === u.id;
                    const dateStr = u.created_at
                      ? new Date(u.created_at * 1000).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })
                      : "—";

                    return (
                      <tr key={u.id} className="hover:bg-neutral-50/60 transition-colors">
                        <td className="py-4 pl-5 pr-3">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-neutral-900">{u.email}</span>
                            {u.is_admin && (
                              <span className="rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                                Admin
                              </span>
                            )}
                          </div>
                          <span className="font-mono text-[11px] text-neutral-400">{u.id}</span>
                        </td>

                        <td className="px-3 py-4">
                          {u.status === "pending" ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-0.5 text-[11.5px] font-semibold text-amber-500">
                              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                              Pending Approval
                            </span>
                          ) : u.status === "blocked" ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-0.5 text-[11.5px] font-semibold text-red-600">
                              <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                              Blocked
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-0.5 text-[11.5px] font-semibold text-emerald-600">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                              Approved
                            </span>
                          )}
                        </td>

                        <td className="px-3 py-4">
                          {u.is_admin || u.plan === 1 ? (
                            <span className="font-medium text-emerald-700">Unlimited (Plan 1)</span>
                          ) : (
                            <span className="font-medium text-neutral-600">
                              Free (1 Domain · 5 Mailboxes · 100MB)
                            </span>
                          )}
                        </td>

                        <td className="px-3 py-4 text-center font-mono text-[12px] tabular-nums text-neutral-600">
                          {u.domains_count ?? 0} dom · {u.mailboxes_count ?? 0} mbx
                        </td>

                        <td className="px-3 py-4 text-right font-mono text-[12px] text-neutral-500">
                          {dateStr}
                        </td>

                        <td className="py-4 pl-3 pr-5 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {u.status === "pending" && (
                              <>
                                <button
                                  onClick={() => handleSetStatus(u, "approved")}
                                  disabled={isBusy}
                                  className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-emerald-700 transition-colors disabled:opacity-50"
                                >
                                  <Check className="h-3 w-3 stroke-[2.5]" />
                                  <span>Approve</span>
                                </button>
                                <button
                                  onClick={() => handleSetStatus(u, "blocked")}
                                  disabled={isBusy}
                                  className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2.5 py-1 text-[12px] font-semibold text-neutral-700 hover:bg-neutral-100 transition-colors disabled:opacity-50"
                                >
                                  <Ban className="h-3 w-3" />
                                  <span>Block</span>
                                </button>
                              </>
                            )}

                            {u.status === "approved" && !u.is_admin && (
                              <button
                                onClick={() => handleSetStatus(u, "blocked")}
                                disabled={isBusy}
                                className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2.5 py-1 text-[12px] font-medium text-neutral-600 hover:border-red-300 hover:text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
                              >
                                <Ban className="h-3 w-3" />
                                <span>Block</span>
                              </button>
                            )}

                            {u.status === "blocked" && (
                              <button
                                onClick={() => handleSetStatus(u, "approved")}
                                disabled={isBusy}
                                className="inline-flex items-center gap-1 rounded-md bg-neutral-900 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-neutral-800 transition-colors disabled:opacity-50"
                              >
                                <Check className="h-3 w-3" />
                                <span>Unblock</span>
                              </button>
                            )}

                            {!u.is_admin && (
                              <button
                                onClick={() => handleDelete(u)}
                                disabled={isBusy}
                                title="Delete user"
                                aria-label={`Delete ${u.email}`}
                                className="rounded-md p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600 transition-colors disabled:opacity-50"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="mt-8 rounded-xl border border-neutral-200 bg-neutral-50/70 p-4 text-[13px] text-neutral-600">
          <p>
            <strong className="text-neutral-900">Live Multi-Tenant Mode: </strong>
            Regular user signups remain in <span className="font-semibold text-amber-700">Pending Approval</span> status until an administrator approves them.
            Approved users are restricted to 1 custom domain and 5 mailboxes (100MB storage per mailbox).
            Switch to local mode in <code className="rounded bg-neutral-200/70 px-1 py-0.5 font-mono text-[11.5px]">.env</code> for unlimited self-hosted operation.
          </p>
        </div>
      </main>
    </div>
  );
}
