import { useCallback, useEffect, useState } from "react";

export type Route = {
  view: "landing" | "dashboard" | "mail" | "admin";
  domain?: string | null;
  tab?: "mailboxes" | "templates" | "api" | "settings";
  tplMailbox?: string | null;
  newDomain?: boolean;
  wizardStep?: number;
  account?: string | null;
  folder?: "inbox" | "starred" | "sent";
  messageId?: string | null;
};

const DEFAULT_ROUTE: Route = { view: "landing" };

export function parseHash(): Route {
  try {
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw || raw === "/") return { ...DEFAULT_ROUTE };
    const [pathPart, queryPart] = raw.split("?");
    const segs = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
    const q = new URLSearchParams(queryPart ?? "");

    if (segs[0] === "admin") {
      return { view: "admin" };
    }

    if (segs[0] === "dashboard" || segs[0] === "d") {
      if (segs[1] === "admin") {
        return { view: "admin" };
      }
      if (segs[1] === "new") {
        const stepNum = parseInt(q.get("step") || segs[2] || "", 10);
        return {
          view: "dashboard",
          newDomain: true,
          wizardStep: Number.isFinite(stepNum) && stepNum >= 1 && stepNum <= 3 ? stepNum : undefined,
        };
      }
      if (segs[1]) {
        const domain = segs[1];
        if (segs[2] === "settings") return { view: "dashboard", domain, tab: "settings" };
        if (segs[2] === "api") return { view: "dashboard", domain, tab: "api" };
        if (segs[2] === "templates") {
          return {
            view: "dashboard",
            domain,
            tab: "templates",
            tplMailbox: segs[3] ?? null,
          };
        }
        return { view: "dashboard", domain, tab: "mailboxes" };
      }
      return { view: "dashboard" };
    }
    if (segs[0] === "mail") {
      const folderRaw = segs[1];
      const folder =
        folderRaw === "starred" || folderRaw === "sent" ? folderRaw : ("inbox" as const);
      const messageId = segs[2] ?? null;
      return {
        view: "mail",
        folder,
        messageId,
        account: q.get("account"),
      };
    }
    return { ...DEFAULT_ROUTE };
  } catch {
    return { ...DEFAULT_ROUTE };
  }
}

export function buildHash(r: Route): string {
  const enc = encodeURIComponent;
  if (r.view === "admin") {
    return "#/admin";
  }
  if (r.view === "dashboard") {
    if (r.newDomain) {
      if (r.wizardStep && r.wizardStep > 1) {
        return `#/dashboard/new?step=${r.wizardStep}`;
      }
      return "#/dashboard/new";
    }
    if (r.domain) {
      if (r.tab === "templates") {
        if (r.tplMailbox) return `#/d/${enc(r.domain)}/templates/${enc(r.tplMailbox)}`;
        return `#/d/${enc(r.domain)}/templates`;
      }
      if (r.tplMailbox) return `#/d/${enc(r.domain)}/templates/${enc(r.tplMailbox)}`;
      if (r.tab === "settings") return `#/d/${enc(r.domain)}/settings`;
      if (r.tab === "api") return `#/d/${enc(r.domain)}/api`;
      return `#/d/${enc(r.domain)}`;
    }
    return "#/dashboard";
  }
  if (r.view === "mail") {
    let h = "#/mail";
    if (r.folder && r.folder !== "inbox") h += `/${r.folder}`;
    else if (r.messageId) h += `/inbox`;
    if (r.messageId) h += `/${enc(r.messageId)}`;
    if (r.account) h += `?account=${enc(r.account)}`;
    return h;
  }
  return "#/";
}

export function navigate(r: Route) {
  const h = buildHash(r);
  if (window.location.hash === h) return;
  window.location.hash = h;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => (typeof window === "undefined" ? DEFAULT_ROUTE : parseHash()));
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function useNavigateRoute() {
  return useCallback((patch: Partial<Route>, base?: Route) => {
    const current = base ?? parseHash();
    navigate({ ...current, ...patch });
  }, []);
}
