import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api, getErrorMessage, type ApiUser } from "./api";
import { useConfirm } from "./confirm";

const STORAGE_KEY = "mailergo.session";

interface AuthContextValue {
  user: ApiUser | null;
  loading: boolean;
  authBusy: boolean;
  authError: string | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<{ pendingApproval?: boolean; message?: string }>;
  logout: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredUser(): ApiUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const user = parsed?.user ?? parsed;
    if (!user || typeof user !== "object" || typeof user.email !== "string" || typeof user.id !== "string") {
      return null;
    }
    return user as ApiUser;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const confirm = useConfirm();
  const [user, setUser] = useState<ApiUser | null>(readStoredUser);
  const [loading, setLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.auth
      .me()
      .then(({ user }) => {
        if (!active) return;
        setUser(user);
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...parsed, user }));
          } catch {}
        }
      })
      .catch(() => {
        if (!active) return;
        localStorage.removeItem(STORAGE_KEY);
        setUser(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const { user, token } = await api.auth.login(email, password);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ user, token }));
      setUser(user);
    } catch (err) {
      const message = getErrorMessage(err, "Login failed. Please check your credentials.");
      setAuthError(message);
      throw new Error(message);
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const signup = useCallback(async (email: string, password: string) => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const res = await api.auth.signup(email, password);
      if (res.pendingApproval) {
        localStorage.removeItem(STORAGE_KEY);
        setUser(null);
        return { pendingApproval: true, message: res.message };
      }
      if (res.token && res.user) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ user: res.user, token: res.token }));
        setUser(res.user);
      }
      return { pendingApproval: false };
    } catch (err) {
      const message = getErrorMessage(err, "Sign up failed. Please try again.");
      setAuthError(message);
      throw new Error(message);
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const logout = useCallback(async () => {
    const ok = await confirm({
      title: "Sign out",
      message: "Are you sure you want to sign out?",
      confirmLabel: "Sign out",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.auth.logout();
    } finally {
      localStorage.removeItem(STORAGE_KEY);
      setUser(null);
    }
  }, [confirm]);

  const clearError = useCallback(() => setAuthError(null), []);

  const value = useMemo(
    () => ({ user, loading, authBusy, authError, login, signup, logout, clearError }),
    [user, loading, authBusy, authError, login, signup, logout, clearError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
};
