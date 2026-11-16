import { useEffect, useState } from "react";
import { displayName, useAuth } from "./AuthGate";
import V2Backtesting, { DEFAULT_BACKTEST, findBacktest } from "./V2Backtesting";
import V2Paper, { DEFAULT_PAPER, findPaper } from "./V2Paper";
import V2Settings from "./V2Settings";
import V2Data from "./V2Data";
import { KiteButton } from "./V2Kite";
import V2Dashboard from "./V2Dashboard";
import { systemTheme, useSetting } from "./settings";
import V2Live from "./V2Live";
import V2Trade from "./V2Trade";

// YoraTrader: top navigation and one content area. Pages live at /v2/<page> ("/" opens the dashboard).

const PAGES = [
  { id: "dashboard", label: "Dashboard" },
  { id: "backtesting", label: "Backtesting" },
  { id: "paper", label: "Paper trading" },
  { id: "trade", label: "Live trading" },
  { id: "live", label: "Live" },
  { id: "reports", label: "Reports" },
  { id: "data", label: "Data" },
  { id: "settings", label: "Settings" },
];

function pathParts() {
  return window.location.pathname.replace(/^\/v2\/?/, "").split("/");
}

function pageFromPath() {
  const id = pathParts()[0];
  // Settings is a dialog over the page, not a page of its own
  return id !== "settings" && PAGES.some((p) => p.id === id) ? id : "dashboard";
}

function backtestFromPath() {
  const id = pathParts()[1];
  return findBacktest(id) ? id : DEFAULT_BACKTEST;
}

function paperFromPath() {
  const id = pathParts()[1];
  return pathParts()[0] === "paper" && findPaper(id) ? id : DEFAULT_PAPER;
}

function Logo() {
  // The wordmark: YORA + TRADER in gold.
  return (
    <a href="/v2/dashboard" className="text-xl font-bold tracking-[0.18em]" aria-label="YoraTrader home">
      <span style={{ color: "var(--brand)" }}>YORA</span>
      <span style={{ color: "var(--brand-gold)" }}>TRADER</span>
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
  const [backtest, setBacktest] = useState(backtestFromPath);
  const [paper, setPaper] = useState(paperFromPath);


  useEffect(() => {
    const onPop = () => {
      setPage(pageFromPath());
      setBacktest(backtestFromPath());
      setPaper(paperFromPath());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const sub = page === "backtesting" ? `${findBacktest(backtest)?.label} · ` : page === "paper" ? `${findPaper(paper)?.label} · ` : "";
    document.title = `${sub}${PAGES.find((p) => p.id === page)?.label} · YoraTrader`;
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
    if (id === page) return;
    window.history.pushState(null, "", id === "backtesting" ? `/v2/backtesting/${backtest}` : id === "paper" ? `/v2/paper/${paper}` : `/v2/${id}`);
    setPage(id);
  };

  const current = PAGES.find((p) => p.id === page);
  return (
    <div className="v2 flex h-full flex-col overflow-hidden" data-theme={theme}>
      {settingsOpen && <V2Settings theme={theme} onTheme={setTheme} onClose={() => setSettingsOpen(false)} />}
      <header className="shrink-0 border-b" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <div className="flex h-14 items-center gap-4 px-4 md:px-6">
          <Logo />
          <nav className="ml-auto hidden items-center gap-1 lg:flex" aria-label="Main">
            {PAGES.map((p) => (
              <NavLink key={p.id} page={p} active={p.id === "settings" ? settingsOpen : p.id === page} onSelect={select} />
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 lg:ml-3 lg:border-l lg:pl-4" style={{ borderColor: "var(--border)" }}>
            <span className="hidden text-sm sm:inline" style={{ color: "var(--muted)" }}>
              {displayName(user)}
            </span>
            <KiteButton />
            <button
              type="button"
              onClick={logout}
              className="rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-[var(--surface-2)]"
              style={{ borderColor: "var(--border)", color: "var(--text)" }}
            >
              Log out
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              className="grid h-8 w-8 place-items-center rounded-md border lg:hidden"
              style={{ borderColor: "var(--border)", color: "var(--muted)" }}
              aria-label="Menu"
              aria-expanded={menuOpen}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav className="flex flex-col gap-1 border-t px-4 py-2 lg:hidden" style={{ borderColor: "var(--border)" }} aria-label="Main">
            {PAGES.map((p) => (
              <NavLink key={p.id} page={p} active={p.id === "settings" ? settingsOpen : p.id === page} onSelect={select} />
            ))}
            <span className="px-3 py-1.5 text-sm sm:hidden" style={{ color: "var(--faint)" }}>
              {displayName(user)}
            </span>
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
          <V2Trade />
        </main>
      ) : page === "live" ? (
        <main className="min-h-0 flex-1 overflow-auto px-4 py-6 md:px-6">
          <V2Live />
        </main>
      ) : page === "data" ? (
        <main className="min-h-0 flex-1 overflow-auto px-4 py-6 md:px-6">
          <V2Data />
        </main>
      ) : (
        <main className="min-h-0 flex-1 overflow-auto px-4 py-6 md:px-6">
          <h1 className="text-xl font-semibold tracking-tight">{current.label}</h1>
        </main>
      )}
    </div>
  );
}
