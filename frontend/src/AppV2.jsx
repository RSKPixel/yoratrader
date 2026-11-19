import { useEffect, useState } from "react";
import { displayName, useAuth } from "./AuthGate";
import V2Backtesting, { BACKTEST_GROUPS, findBacktest } from "./V2Backtesting";
import V2Paper, { findPaper, PAPER_GROUPS } from "./V2Paper";
import { ModelMenu } from "./V2SideNav";
import V2TradeLanding from "./V2TradeLanding";
import V2TradeMix from "./V2TradeMix";
import V2Settings from "./V2Settings";
import V2Data from "./V2Data";
import V2Dashboard from "./V2Dashboard";
import { systemTheme, useSetting } from "./settings";
import V2Live from "./V2Live";
import V2Trade from "./V2Trade";
import V2Reports from "./V2Reports";

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
  return pathParts()[0] === "backtesting" && findBacktest(id) ? id : null; // null: the landing page
}

function paperFromPath() {
  const id = pathParts()[1];
  return pathParts()[0] === "paper" && findPaper(id) ? id : null; // null: the landing page
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

// Backtesting and Paper trading: the link opens the landing page; hovering it pops up a dropdown of the page's
// models (no side nav). inline: the phone menu (no hover), where the arrow opens the list in place.
// One dropdown open at a time: the top bar's links share which one (hover moving across closes the other at once)
let hoverTimer = null;
const hoverListeners = new Set();
let hoverOpen = null;
function setHoverOpen(id) {
  hoverOpen = id;
  hoverListeners.forEach((fn) => fn(id));
}

function NavMenu({ page, active, menu, onOpen, inline = false }) {
  const [inlineOpen, setInlineOpen] = useState(false);
  const [shared, setShared] = useState(hoverOpen);
  useEffect(() => {
    hoverListeners.add(setShared);
    return () => hoverListeners.delete(setShared);
  }, []);
  const open = inline ? inlineOpen : shared === page.id;
  const setOpen = (v) => {
    if (inline) setInlineOpen(typeof v === "function" ? v(inlineOpen) : v);
    else setHoverOpen(v ? page.id : null);
  };
  const enter = () => {
    if (inline) return;
    clearTimeout(hoverTimer);
    setHoverOpen(page.id); // the other link's dropdown closes now
  };
  const leave = () => {
    if (inline) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => hoverOpen === page.id && setHoverOpen(null), 150); // a short grace, so a slip past the edge doesn't close it
  };
  const style = active ? { background: "var(--accent-soft)", color: "var(--accent)" } : { color: "var(--muted)" };
  return (
    <div className={inline ? "flex flex-col" : "relative"} onMouseEnter={enter} onMouseLeave={leave}>
      <div className="flex items-center rounded-md" style={style}>
        <a
          href={`/v2/${page.id}`}
          onClick={(e) => {
            e.preventDefault();
            setOpen(false);
            onOpen();
          }}
          aria-current={active ? "page" : undefined}
          className={`flex flex-1 items-center gap-1 py-1.5 text-sm font-medium ${inline ? "pl-3" : "px-3"}`}
        >
          {page.label}
          {!inline && (
            <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          )}
        </a>
        {inline && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`${page.label}: the models`} className="grid h-8 w-10 place-items-center">
            <svg viewBox="0 0 24 24" className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        )}
      </div>
      {open && (
        <div className={inline ? "mt-1 rounded-md border" : "absolute left-0 top-full z-40 pt-2"} style={inline ? { borderColor: "var(--border)", background: "var(--surface)" } : undefined}>
          <div className={inline ? "" : "max-h-[75vh] w-80 overflow-y-auto rounded-lg border shadow-2xl"} style={inline ? undefined : { borderColor: "var(--border)", background: "var(--surface)" }}>
            {menu(() => setOpen(false))}
          </div>
        </div>
      )}
    </div>
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
  // Live trading: the landing page (null) or a model's own page ("turn-of-month")
  const [tradeSub, setTradeSub] = useState(() => (pathParts()[0] === "trade" ? pathParts()[1] || null : null));


  useEffect(() => {
    const onPop = () => {
      setPage(pageFromPath());
      setBacktest(backtestFromPath());
      setPaper(paperFromPath());
      setTradeSub(pathParts()[0] === "trade" ? pathParts()[1] || null : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const sub = page === "backtesting" && backtest ? `${findBacktest(backtest)?.label} · ` : page === "paper" && paper ? `${findPaper(paper)?.label} · ` : "";
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
    if (id === "paper") setPaper(null); // the landing pages, not the last model
    if (id === "backtesting") setBacktest(null);
    if (id === "trade") setTradeSub(null);
    if (id === page && !(id === "paper" && paper) && !(id === "backtesting" && backtest) && !(id === "trade" && tradeSub)) return;
    window.history.pushState(null, "", id === "backtesting" ? "/v2/backtesting" : id === "paper" ? "/v2/paper" : `/v2/${id}`);
    setPage(id);
  };

  const current = PAGES.find((p) => p.id === page);
  const menus = {
    backtesting: (done) => (
      <ModelMenu groups={BACKTEST_GROUPS} base="/v2/backtesting" title="Backtests" current={page === "backtesting" ? backtest : "-"} onSelect={(id) => { setMenuOpen(false); selectBacktest(id); }}
        onDone={done} />
    ),
    paper: (done) => (
      <ModelMenu groups={PAPER_GROUPS} base="/v2/paper" title="Paper trading" current={page === "paper" ? paper : "-"} onSelect={(id) => { setMenuOpen(false); selectPaper(id); }}
        onDone={done} />
    ),
  };
  const link = (p, inline) =>
    menus[p.id] ? (
      <NavMenu key={p.id} page={p} active={p.id === page} menu={menus[p.id]} inline={inline} onOpen={() => select(p.id)} />
    ) : (
      <NavLink key={p.id} page={p} active={p.id === "settings" ? settingsOpen : p.id === page} onSelect={select} />
    );
  return (
    <div className="v2 flex h-full flex-col overflow-hidden" data-theme={theme}>
      {settingsOpen && <V2Settings theme={theme} onTheme={setTheme} onClose={() => setSettingsOpen(false)} />}
      <header className="shrink-0 border-b" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <div className="flex h-14 items-center gap-4 px-4 md:px-6">
          <Logo />
          <nav className="ml-auto hidden items-center gap-1 lg:flex" aria-label="Main">
            {PAGES.map((p) => link(p, false))}
          </nav>
          <div className="ml-auto flex items-center gap-2 lg:ml-3 lg:border-l lg:pl-4" style={{ borderColor: "var(--border)" }}>
            <span className="hidden text-sm lg:inline" style={{ color: "var(--muted)" }}>
              {displayName(user)}
            </span>
            <button
              type="button"
              onClick={logout}
              className="hidden h-8 w-8 place-items-center rounded-md border transition-colors lg:grid hover:bg-[var(--surface-2)]"
              style={{ borderColor: "var(--border)", color: "var(--muted)" }}
              aria-label="Log out"
              title="Log out"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4" />
              </svg>
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
          <nav className="flex max-h-[80vh] flex-col gap-1 overflow-y-auto border-t px-4 py-2 lg:hidden" style={{ borderColor: "var(--border)" }} aria-label="Main">
            {PAGES.map((p) => link(p, true))}
            <div className="mt-1 flex items-center justify-between gap-3 border-t px-3 pt-2" style={{ borderColor: "var(--border)" }}>
              <span className="truncate text-sm" style={{ color: "var(--muted)" }}>
                {displayName(user)}
              </span>
              <button
                type="button"
                onClick={logout}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md border transition-colors hover:bg-[var(--surface-2)]"
                style={{ borderColor: "var(--border)", color: "var(--muted)" }}
                aria-label="Log out"
                title="Log out"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4" />
                </svg>
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
          {tradeSub === "turn-of-month" ? <V2Trade /> : tradeSub === "books-gold" ? <V2TradeMix /> : <V2TradeLanding />}
        </main>
      ) : page === "live" ? (
        <main className="min-h-0 flex-1 overflow-auto px-4 py-6 md:px-6">
          <V2Live />
        </main>
      ) : page === "reports" ? (
        <main className="min-h-0 flex-1 overflow-auto px-4 py-6 md:px-6">
          <V2Reports />
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
