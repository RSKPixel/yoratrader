import { useEffect } from "react";
import { TomCard, useDashboard } from "../V2Dashboard";
import { systemTheme, useSetting } from "../settings";
import MobileBook from "./MobileBook";
import MobileHome from "./MobileHome";
import MobileMore from "./MobileMore";
import MobileSchedule from "./MobileSchedule";
import { link, useRoute } from "./route";

// YoraTrader on the phone, at /mobile: an app of its own (kept apart from the wide site so it can become a
// phone app one day). A screen at a time, chosen from a bar fixed at the bottom:
//   /mobile (home: paper books today), /mobile/paper/<book>, /mobile/live, /mobile/schedule, /mobile/more.
// The data reloads each minute in market hours and as soon as the screen comes back on (resume.js).

const TABS = [
  { id: "home", label: "Paper", href: "/mobile", icon: "M4 19V9m6 10V5m6 14v-7m4 7H2" },
  { id: "live", label: "Live trading", href: "/mobile/live", icon: "M3 12h4l3-8 4 16 3-8h4" },
  { id: "schedule", label: "Schedule", href: "/mobile/schedule", icon: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" },
  { id: "more", label: "More", href: "/mobile/more", icon: "M5 12h.01M12 12h.01M19 12h.01" },
];

export default function MobileApp() {
  const [theme, setTheme] = useSetting("theme", systemTheme());
  const route = useRoute();
  const { d, error, nextAt } = useDashboard();
  const tab = route[0] === "paper" ? "home" : TABS.some((t) => t.id === route[0]) ? route[0] : "home";
  useEffect(() => {
    document.title = `${TABS.find((t) => t.id === tab).label} · YoraTrader`;
  }, [tab, theme]);

  const needsData = route[0] !== "paper" && tab !== "more";
  let screen;
  if (route[0] === "paper") screen = <MobileBook id={route[1]} />;
  else if (tab === "more") screen = <MobileMore theme={theme} onTheme={setTheme} />;
  else if (error && !d) screen = <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>;
  else if (!d) screen = <p className="text-sm" style={{ color: "var(--faint)" }}>Loading…</p>;
  else if (tab === "live") screen = <TomCard tm={d.paper.tom} />;
  else if (tab === "schedule") screen = <MobileSchedule d={d} />;
  else screen = <MobileHome d={d} nextAt={nextAt} />;

  return (
    <div className="v2 flex h-full flex-col overflow-hidden" data-theme={theme}>
      <main id="mobile-main" className="min-h-0 flex-1 overflow-auto px-4 pt-4 pb-24" style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}>
        {needsData && error && d && <p className="mb-2 text-xs" style={{ color: "var(--warning)" }}>{error} · showing the last data</p>}
        {screen}
      </main>
      <nav
        className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t"
        style={{ borderColor: "var(--border)", background: "var(--surface)", paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label="Sections"
      >
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <a key={t.id} href={t.href} onClick={link(t.href)} aria-current={active ? "page" : undefined}
              className="flex flex-col items-center gap-1 py-2.5 text-[0.6875rem] font-medium"
              style={{ color: active ? "var(--accent)" : "var(--muted)" }}>
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={t.id === "more" ? 3 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={t.icon} />
              </svg>
              {t.label}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
