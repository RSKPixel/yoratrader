import { LogOut, Menu, Settings } from "lucide-react";
import { AlertsBell, AlertsPanel, useAlerts } from "./V2Alerts";
import { Wordmark } from "./brand.jsx";
import { useEffect, useState } from "react";
import { displayName, useAuth } from "./AuthGate";
import V2Backtesting, { findBacktest } from "./V2Backtesting";
import V2Paper, { findPaper } from "./V2Paper";
import V2TradeLanding from "./V2TradeLanding";
import V2TradeMix from "./V2TradeMix";
import V2Settings from "./V2Settings";
import V2Dashboard from "./V2Dashboard";
import { systemTheme, useSetting } from "./settings";
import V2Trade from "./V2Trade";
import V2ManualLanding from "./V2ManualLanding";
import V2Reports from "./V2Reports";
import { useIstClock } from "./istClock";

// YoraTrader: top navigation and one content area. Pages live at /v2/<page> ("/" opens the dashboard).

const PAGES = [
  { id: "dashboard", label: "Dashboard" },
  { id: "backtesting", label: "Backtesting" },
  { id: "paper", label: "Paper trading" },
  { id: "trade", label: "Live trading" },
  { id: "reports", label: "Reports" },
];
// pages reached from the dashboard, not the top nav: Manual trading (its Manual trading tab's cards open them)
const HIDDEN = [{ id: "manual", label: "Manual trading" }];
const ALL = [...PAGES, ...HIDDEN];

function GearIcon() {
  return (
    <Settings className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
  );
}

function pathParts() {
  return window.location.pathname.replace(/^\/v2\/?/, "").split("/");
}

function pageFromPath() {
  const id = pathParts()[0];
  // Settings is a dialog over the page, not a page of its own
  return id !== "settings" && ALL.some((p) => p.id === id) ? id : "dashboard";
}

function backtestFromPath() {
  const id = pathParts()[1];
  return pathParts()[0] === "backtesting" && findBacktest(id) ? id : null; // null: the landing page
}

function paperFromPath() {
  const id = pathParts()[1];
  return pathParts()[0] === "paper" && findPaper(id) ? id : null; // null: the landing page
}

function Logo() {
  // The wordmark on a white tile, the India time and date under it (as the phone app)
  const clock = useIstClock();
  return (
    <a href="/v2/dashboard" className="inline-flex flex-col gap-px" aria-label="YoraTrader home">
      <Wordmark />
      <span className="text-[0.6875rem] leading-none tabular-nums" style={{ color: "var(--muted)" }}>{clock}</span>
    </a>
  );
}

function NavLink({ page, active, onSelect }) {
  return (
    <a
      href={`/v2/${page.id}`}
      onClick={(event) => {
        event.preventDefault();
        onSelect(page.id);
      }}
      aria-current={active ? "page" : undefined}
      className="rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
      style={active ? { background: "var(--accent-soft)", color: "var(--accent)" } : { color: "var(--muted)" }}
    >
      {page.label}
    </a>
  );
}

export default function AppV2() {
  const { user, logout } = useAuth();
  const [theme, setTheme] = useSetting("theme", systemTheme());
  const [page, setPage] = useState(pageFromPath);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(() => pathParts()[0] === "settings");
  const [alerts, reloadAlerts] = useAlerts(); // the bell: live orders and problems, the morning check, the summary
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [backtest, setBacktest] = useState(backtestFromPath);
  const [paper, setPaper] = useState(paperFromPath);
  // Live trading: the landing page (null) or a model's own page ("turn-of-month")
  const [tradeSub, setTradeSub] = useState(() => (pathParts()[0] === "trade" ? pathParts()[1] || null : null));
  // Manual trading: the landing page (null) or a model's page ("turn-of-month")
  const [manualSub, setManualSub] = useState(() => (pathParts()[0] === "manual" ? pathParts()[1] || null : null));


  useEffect(() => {
    const onPop = () => {
      setPage(pageFromPath());
      setBacktest(backtestFromPath());
      setPaper(paperFromPath());
      setTradeSub(pathParts()[0] === "trade" ? pathParts()[1] || null : null);
      setManualSub(pathParts()[0] === "manual" ? pathParts()[1] || null : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const sub = page === "backtesting" && backtest ? `${findBacktest(backtest)?.label} · ` : page === "paper" && paper ? `${findPaper(paper)?.label} · ` : "";
    document.title = `${sub}${ALL.find((p) => p.id === page)?.label} · YoraTrader`;
  }, [page, backtest, paper]);

  const selectPaper = (id) => {
    if (id === paper && page === "paper") return;
    window.history.pushState(null, "", `/v2/paper/${id}`);
    setPage("paper");
    setPaper(id);
  };

  const selectBacktest = (id) => {
    if (id === backtest && page === "backtesting") return;
    window.history.pushState(null, "", `/v2/backtesting/${id}`);
    setPage("backtesting");
    setBacktest(id);
  };

  const select = (id) => {
    setMenuOpen(false);
    if (id === "settings") {
      setSettingsOpen(true);
      return;
    }
    if (id === "paper") setPaper(null); // the landing pages, not the last model
    if (id === "backtesting") setBacktest(null);
    if (id === "trade") setTradeSub(null);
    if (id === "manual") setManualSub(null);
    if (id === page && !(id === "paper" && paper) && !(id === "backtesting" && backtest) && !(id === "trade" && tradeSub) && !(id === "manual" && manualSub)) return;
    window.history.pushState(null, "", id === "backtesting" ? "/v2/backtesting" : id === "paper" ? "/v2/paper" : `/v2/${id}`);
    setPage(id);
  };

  const current = ALL.find((p) => p.id === page);

  // every page a plain link: each model is reached from its page's landing (no menus)
  const link = (p) => <NavLink key={p.id} page={p} active={p.id === page} onSelect={select} />;
  return (
    <div className="v2 flex h-full flex-col overflow-hidden" data-theme={theme}>
      {settingsOpen && <V2Settings theme={theme} onTheme={setTheme} onClose={() => setSettingsOpen(false)} />}
      {alertsOpen && <AlertsPanel data={alerts} onClose={() => setAlertsOpen(false)} onSeen={reloadAlerts} />}
      <header className="shrink-0 border-b" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <div className="flex h-14 items-center gap-4 px-4 md:px-6">
          <Logo />
          <nav className="ml-auto hidden items-center gap-1 lg:flex" aria-label="Main">
            {PAGES.map((p) => link(p))}
          </nav>
          <div className="ml-auto flex items-center gap-2 lg:ml-3 lg:border-l lg:pl-4" style={{ borderColor: "var(--border)" }}>
            <span className="hidden text-sm lg:inline" style={{ color: "var(--muted)" }}>
              {displayName(user)}
            </span>
            <AlertsBell data={alerts} onClick={() => { setMenuOpen(false); setAlertsOpen(true); }} className="grid h-8 w-8" />
            <button
              type="button"
              onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}
              className="hidden h-8 w-8 place-items-center rounded-md border transition-colors lg:grid hover:bg-[var(--surface-2)]"
              style={{ borderColor: settingsOpen ? "var(--accent)" : "var(--border)", color: settingsOpen ? "var(--accent)" : "var(--muted)" }}
              aria-label="Settings"
              title="Settings"
            >
              <GearIcon />
            </button>
            <button
              type="button"
              onClick={logout}
              className="hidden h-8 w-8 place-items-center rounded-md border transition-colors lg:grid hover:bg-[var(--surface-2)]"
              style={{ borderColor: "var(--border)", color: "var(--muted)" }}
              aria-label="Log out"
              title="Log out"
            >
              <LogOut className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              className="grid h-8 w-8 place-items-center rounded-md border lg:hidden"
              style={{ borderColor: "var(--border)", color: "var(--muted)" }}
              aria-label="Menu"
              aria-expanded={menuOpen}
            >
              <Menu className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav className="flex max-h-[80vh] flex-col gap-1 overflow-y-auto border-t px-4 py-2 lg:hidden" style={{ borderColor: "var(--border)" }} aria-label="Main">
            {PAGES.map((p) => link(p))}
            <div className="mt-1 flex items-center justify-between gap-3 border-t px-3 pt-2" style={{ borderColor: "var(--border)" }}>
              <span className="truncate text-sm" style={{ color: "var(--muted)" }}>
                {displayName(user)}
              </span>
              <button
                type="button"
                onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}
                className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-md border transition-colors hover:bg-[var(--surface-2)]"
                style={{ borderColor: "var(--border)", color: "var(--muted)" }}
                aria-label="Settings"
                title="Settings"
              >
                <GearIcon />
              </button>
              <button
                type="button"
                onClick={logout}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md border transition-colors hover:bg-[var(--surface-2)]"
                style={{ borderColor: "var(--border)", color: "var(--muted)" }}
                aria-label="Log out"
                title="Log out"
              >
                <LogOut className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>
          </nav>
        )}
      </header>

      {page === "backtesting" ? (
        <main className="flex min-h-0 min-w-0 flex-1">
          <V2Backtesting model={backtest} onSelect={selectBacktest} />
        </main>
      ) : page === "paper" ? (
        <main className="flex min-h-0 min-w-0 flex-1">
          <V2Paper model={paper} onSelect={selectPaper} />
        </main>
      ) : page === "dashboard" ? (
        <main className="min-h-0 flex-1 overflow-auto px-4 py-6 md:px-6">
          <V2Dashboard />
        </main>
      ) : page === "trade" ? (
        <main className="min-h-0 flex-1 overflow-auto px-4 py-6 md:px-6">
          {tradeSub === "books-gold" ? <V2TradeMix /> : <V2TradeLanding />}
        </main>
      ) : page === "manual" ? (
        <main className="min-h-0 flex-1 overflow-auto px-4 py-6 md:px-6">
          {manualSub === "turn-of-month" ? <V2Trade /> : <V2ManualLanding />}
        </main>
      ) : page === "reports" ? (
        <main className="min-h-0 flex-1 overflow-auto px-4 py-6 md:px-6">
          <V2Reports />
        </main>
      ) : (
        <main className="min-h-0 flex-1 overflow-auto px-4 py-6 md:px-6">
          <h1 className="text-xl font-semibold tracking-tight">{current.label}</h1>
        </main>
      )}
    </div>
  );
}
