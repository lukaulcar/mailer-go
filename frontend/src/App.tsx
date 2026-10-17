import { useEffect, useRef, useState } from "react";
import { ToastProvider } from "./lib/toast";
import { ConfirmProvider } from "./lib/confirm";
import { AuthProvider, useAuth } from "./lib/auth";
import { MailboxProvider, useMailbox } from "./lib/mailboxAuth";
import { navigate, useRoute } from "./lib/router";
import Header from "./components/Header";
import Hero from "./components/Hero";
import Sections from "./components/Sections";
import Footer from "./components/Footer";
import AuthModal from "./components/AuthModal";
import MailboxLoginModal from "./components/MailboxLoginModal";
import DashboardApp from "./app/DashboardApp";
import MailboxApp from "./app/MailboxApp";
import AdminPage from "./app/AdminPage";

function MarketingSite({
  onAuth,
  onMailboxLogin,
  onGoDashboard,
  onGoMail,
}: {
  onAuth: (mode: "login" | "signup") => void;
  onMailboxLogin: () => void;
  onGoDashboard: () => void;
  onGoMail: () => void;
}) {
  return (
    <>
      <Header onAuth={onAuth} onMailboxLogin={onMailboxLogin} onGoDashboard={onGoDashboard} onGoMail={onGoMail} />
      <Hero onAuth={onAuth} />
      <Sections onAuth={onAuth} />
      <Footer />
    </>
  );
}

function Shell() {
  const { user, loading } = useAuth();
  const { mailbox, mailboxLoading, accounts } = useMailbox();
  const [authMode, setAuthMode] = useState<"login" | "signup" | null>(null);
  const [mailboxLoginOpen, setMailboxLoginOpen] = useState(false);
  const [mailboxPrefill, setMailboxPrefill] = useState("");
  const openAuth = (mode: "login" | "signup") => setAuthMode(mode);

  const route = useRoute();

  function openMailboxLogin(prefill = "") {
    setMailboxPrefill(prefill);
    setMailboxLoginOpen(true);
  }

  const bootstrapped = useRef(false);
  useEffect(() => {
    if (loading || mailboxLoading || bootstrapped.current) return;
    if (window.location.hash && window.location.hash !== "#/" && window.location.hash !== "#") {
      bootstrapped.current = true;
      return;
    }
    bootstrapped.current = true;
    if (mailbox) navigate({ view: "mail", folder: "inbox" });
    else if (user) navigate({ view: "dashboard" });
    else navigate({ view: "landing" });
  }, [loading, mailboxLoading, mailbox, user]);

  const prevUser = useRef<string | null>(null);
  const prevMailCount = useRef(0);
  useEffect(() => {
    const email = user?.email ?? null;
    if (email && !prevUser.current && route.view === "landing") navigate({ view: "dashboard" });
    prevUser.current = email;
  }, [user, route.view]);
  useEffect(() => {
    if (accounts.length > 0 && prevMailCount.current === 0 && route.view === "landing") {
      navigate({ view: "mail", folder: "inbox" });
    }
    prevMailCount.current = accounts.length;
  }, [accounts.length, route.view]);

  const goLanding = () => navigate({ view: "landing" });
  const goDashboard = () => {
    if (user) navigate({ view: "dashboard" });
    else setAuthMode("login");
  };
  const goMail = () => {
    if (mailbox || accounts.length > 0) navigate({ view: "mail", folder: "inbox" });
    else openMailboxLogin();
  };

  if (loading || mailboxLoading) {
    return (
      <div className="grid min-h-screen place-items-center bg-white">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-900" role="status" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div id="top" className="min-h-screen bg-white text-neutral-900 antialiased">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-neutral-900 focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>
      {route.view === "mail" ? (
        <MailboxApp
          onGoDashboard={goDashboard}
          onAddAccount={openMailboxLogin}
          onGoLanding={goLanding}
        />
      ) : route.view === "admin" && user?.isAdmin ? (
        <AdminPage
          onGoDashboard={goDashboard}
          onGoLanding={goLanding}
        />
      ) : route.view === "dashboard" && user ? (
        <DashboardApp
          onGoLanding={goLanding}
        />
      ) : (
        <MarketingSite
          onAuth={openAuth}
          onMailboxLogin={openMailboxLogin}
          onGoDashboard={goDashboard}
          onGoMail={goMail}
        />
      )}
      {authMode && !user && (
        <AuthModal
          mode={authMode}
          onClose={() => setAuthMode(null)}
          onSwitch={(mode) => setAuthMode(mode)}
        />
      )}
      {mailboxLoginOpen && (
        <MailboxLoginModal
          key={mailboxPrefill}
          initialAddress={mailboxPrefill}
          onClose={() => setMailboxLoginOpen(false)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AuthProvider>
          <MailboxProvider>
            <Shell />
          </MailboxProvider>
        </AuthProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
