import { BookOpen, Hand, Menu, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { LiveItems, TomCard, useDashboard } from "../V2Dashboard";
import { systemTheme, useSetting } from "../settings";
import MobileBook from "./MobileBook";
import MobileHome, { Status } from "./MobileHome";
import MobileMore from "./MobileMore";
import { link, useRoute } from "./route";
import { useWakeLock } from "./wakeLock";

// YoraTrader on the phone, at /mobile: an app of its own (kept apart from the wide site so it can become a
// phone app one day). A screen at a time, chosen from a bar fixed at the bottom:
//   /mobile (home: paper books today), /mobile/paper/<book>, /mobile/live, /mobile/manual, /mobile/more (with the schedule).
// The data reloads each minute in market hours and as soon as the screen comes back on (resume.js).

const TABS = [
  { id: "home", label: "Paper", href: "/mobile", Icon: BookOpen },
  { id: "live", label: "Live trading", href: "/mobile/live", Icon: Zap },
  { id: "manual", label: "Manual", href: "/mobile/manual", Icon: Hand },
  { id: "more", label: "More", href: "/mobile/more", Icon: Menu },
];

export default function MobileApp() {
  const [theme, setTheme] = useSetting("theme", systemTheme());
  const [keepAwake, setKeepAwake] = useSetting("mobile_keep_awake", true); // the screen stays on while the app is open
  const awake = useWakeLock(keepAwake);
  const route = useRoute();
  const { d, error, nextAt, reload, loading } = useDashboard();
  const [scrolled, setScrolled] = useState(false); // the header's shadow while the screen is scrolled under it
  const [below, setBelow] = useState(false); // the bottom bar's shadow while there's more of the screen under it
  const edges = (el) => {
    setScrolled(el.scrollTop > 2);
    setBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 2);
  };
  useEffect(() => {
    const el = document.getElementById("mobile-main");
    if (el) edges(el);
  });
  const tab = route[0] === "paper" ? "home" : TABS.some((t) => t.id === route[0]) ? route[0] : "home";
  useEffect(() => {
    document.title = `${TABS.find((t) => t.id === tab).label} · YoraTrader`;
  }, [tab, theme]);

  const needsData = route[0] !== "paper";
  let screen;
  if (route[0] === "paper") screen = <MobileBook id={route[1]} />;
  else if (error && !d) screen = <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>;
  else if (!d) screen = <p className="text-sm" style={{ color: "var(--faint)" }}>Loading…</p>;
  else if (tab === "live") screen = <div className="flex flex-col gap-3"><LiveItems /></div>;
  else if (tab === "manual") screen = <div className="flex flex-col gap-3"><TomCard tm={d.paper.tom} /></div>;
  else if (tab === "more") screen = <MobileMore theme={theme} onTheme={setTheme} keepAwake={keepAwake} onKeepAwake={setKeepAwake} awake={awake} d={d} nextAt={nextAt} onRefresh={reload} loading={loading} />;
  else screen = <MobileHome d={d} nextAt={nextAt} />;

  return (
    <div className="v2 flex h-full flex-col overflow-hidden" data-theme={theme}>
      <header className="z-10 shrink-0 px-4 pt-2.5 pb-2 transition-shadow"
        style={{ paddingTop: "max(0.625rem, env(safe-area-inset-top))", background: "var(--surface)", boxShadow: scrolled ? "var(--bar-shadow)" : "none",
          borderBottom: "1px solid var(--border)" }}>
        <Status d={d} />
      </header>
      <main id="mobile-main" className="min-h-0 flex-1 overflow-auto px-4 pt-4 pb-24" onScroll={(e) => edges(e.currentTarget)}>
        {needsData && error && d && <p className="mb-2 text-xs" style={{ color: "var(--warning)" }}>{error} · showing the last data</p>}
        {screen}
      </main>
      <nav
        className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t"
        style={{ borderColor: "var(--border)", background: "var(--surface)", paddingBottom: "env(safe-area-inset-bottom)", boxShadow: below ? "var(--bar-shadow-up)" : "none" }}
        aria-label="Sections"
      >
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <a key={t.id} href={t.href} onClick={link(t.href)} aria-current={active ? "page" : undefined}
              className="flex flex-col items-center gap-1 py-2.5 text-[0.6875rem] font-medium"
              style={{ color: active ? "var(--accent)" : "var(--muted)" }}>
              <t.Icon className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" />
              {t.label}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
