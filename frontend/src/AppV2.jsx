import { useEffect, useState } from "react";
import { displayName, useAuth } from "./AuthGate";

// YoraTrader v2: top navigation and one content area. Pages start blank and are moved over one by one;
// the classic app stays at "/" until then. Pages live at /v2/<page>.

const PAGES = [
  { id: "dashboard", label: "Dashboard" },
  { id: "backtesting", label: "Backtesting" },
  { id: "paper", label: "Paper trading" },
  { id: "live", label: "Live" },
  { id: "reports", label: "Reports" },
  { id: "settings", label: "Settings" },
];

const THEME_KEY = "yt-v2-theme";

function initialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // storage blocked: fall back to the system setting
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function pageFromPath() {
  const id = window.location.pathname.replace(/^\/v2\/?/, "").split("/")[0];
  return PAGES.some((p) => p.id === id) ? id : "dashboard";
}

function Logo() {
  return (
    <a href="/v2/dashboard" className="flex items-center gap-2.5" aria-label="YoraTrader home">
      <span
        className="grid h-8 w-8 place-items-center rounded-lg text-sm font-bold"
        style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
        aria-hidden="true"
      >
        Y
      </span>
      <span className="text-base font-semibold tracking-[0.16em]">
        YORA<span style={{ color: "var(--accent)" }}>TRADER</span>
      </span>
    </a>
  );
}

function ThemeToggle({ theme, onToggle }) {
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={onToggle}
      className="grid h-8 w-8 place-items-center rounded-md border transition-colors hover:bg-[var(--surface-2)]"
      style={{ borderColor: "var(--border)", color: "var(--muted)" }}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
    >
      {dark ? (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
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
  const [theme, setTheme] = useState(initialTheme);
  const [page, setPage] = useState(pageFromPath);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // not saved: the theme still applies for this visit
    }
  }, [theme]);

  useEffect(() => {
    const onPop = () => setPage(pageFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    document.title = `${PAGES.find((p) => p.id === page)?.label} · YoraTrader`;
  }, [page]);

  const select = (id) => {
    setMenuOpen(false);
    if (id === page) return;
    window.history.pushState(null, "", `/v2/${id}`);
    setPage(id);
  };

  const current = PAGES.find((p) => p.id === page);
  return (
    <div className="v2 flex h-full flex-col overflow-hidden" data-theme={theme}>
      <header className="shrink-0 border-b" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <div className="flex h-14 items-center gap-4 px-4 md:px-6">
          <Logo />
          <nav className="ml-auto hidden items-center gap-1 lg:flex" aria-label="Main">
            {PAGES.map((p) => (
              <NavLink key={p.id} page={p} active={p.id === page} onSelect={select} />
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 lg:ml-3 lg:border-l lg:pl-4" style={{ borderColor: "var(--border)" }}>
            <span className="hidden text-sm sm:inline" style={{ color: "var(--muted)" }}>
              {displayName(user)}
            </span>
            <ThemeToggle theme={theme} onToggle={() => setTheme(theme === "dark" ? "light" : "dark")} />
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
              <NavLink key={p.id} page={p} active={p.id === page} onSelect={select} />
            ))}
            <span className="px-3 py-1.5 text-sm sm:hidden" style={{ color: "var(--faint)" }}>
              {displayName(user)}
            </span>
          </nav>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-4 py-6 md:px-6">
        <h1 className="text-xl font-semibold tracking-tight">{current.label}</h1>
      </main>
    </div>
  );
}
