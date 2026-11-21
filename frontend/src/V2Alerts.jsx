import { Bell, CircleAlert, CircleCheck, Info, ShoppingCart, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useResume } from "./resume";

// In-app alerts (no outside service): the live items' orders and problems, the 08:45 morning check and the 15:35
// daily summary (backend/alerts.py). A bell with the unread count; its list marks everything read when opened.

const LEVEL = {
  error: { color: "var(--negative)", Icon: CircleAlert },
  warn: { color: "var(--warning)", Icon: TriangleAlert },
  ok: { color: "var(--positive)", Icon: CircleCheck },
  order: { color: "var(--accent)", Icon: ShoppingCart },
  info: { color: "var(--muted)", Icon: Info },
};

// every minute, and at once when the screen comes back: [data, reload]
export function useAlerts() {
  const [data, setData] = useState(null);
  const [n, setN] = useState(0);
  const resumed = useResume();
  useEffect(() => {
    let alive = true;
    const load = () => fetch("/api/v2/alerts").then((r) => r.json()).then((p) => alive && p.status === "success" && setData(p)).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [resumed, n]);
  return [data, () => setN((x) => x + 1)];
}

export const markSeen = () => fetch("/api/v2/alerts/seen", { method: "POST" }).catch(() => {});

function when(iso) {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
  const t = d.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  return { day, t };
}

// the bell: red count when a problem is unread, teal for other unread alerts
export function AlertsBell({ data, onClick, className = "", size = "h-4 w-4" }) {
  const unread = data?.unread || 0;
  const bad = (data?.unread_problems || 0) > 0;
  return (
    <button type="button" onClick={onClick} className={`relative place-items-center rounded-md border transition-colors hover:bg-[var(--surface-2)] ${className}`}
      style={{ borderColor: bad ? "var(--negative)" : "var(--border)", color: bad ? "var(--negative)" : "var(--muted)" }}
      aria-label={unread ? `Alerts: ${unread} new` : "Alerts"} title={unread ? `${unread} new alert${unread > 1 ? "s" : ""}` : "Alerts"}>
      <Bell className={size} strokeWidth={1.8} aria-hidden="true" />
      {unread > 0 && (
        <span className="absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[0.625rem] font-semibold leading-none tabular-nums"
          style={{ background: bad ? "var(--negative)" : "var(--accent)", color: bad ? "#fff" : "var(--accent-ink)" }}>
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}

// the list, newest first, a heading for each day
export function AlertList({ data }) {
  if (!data) return <p className="text-sm" style={{ color: "var(--muted)" }}>Loading…</p>;
  if (!data.alerts.length)
    return (
      <p className="text-sm" style={{ color: "var(--muted)" }}>
        No alerts yet. Live orders and problems show here as they happen, the morning check at 08:45 and the day's summary at 15:35 (trading days).
      </p>
    );
  let lastDay = null;
  return (
    <ol className="flex flex-col">
      {data.alerts.map((a) => {
        const { day, t } = when(a.at);
        const head = day !== lastDay;
        lastDay = day;
        const L = LEVEL[a.level] || LEVEL.info;
        return (
          <li key={a.id}>
            {head && <div className="pb-1 pt-3 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] first:pt-0" style={{ color: "var(--faint)" }}>{day}</div>}
            <div className="flex gap-3 border-t py-2.5" style={{ borderColor: "var(--border)" }}>
              <L.Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: L.color }} strokeWidth={2} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium" style={{ color: a.level === "error" ? "var(--negative)" : "var(--text)" }}>
                    {a.title}
                    {a.unread && <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: "var(--accent)" }} aria-label="new" />}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums" style={{ color: "var(--faint)" }}>{t}</span>
                </div>
                {a.lines.map(([lvl, text], i) => (
                  <div key={i} className="mt-0.5 text-xs" style={{ color: lvl === "error" ? "var(--negative)" : lvl === "warn" ? "var(--warning)" : "var(--muted)" }}>
                    {a.kind === "order" ? "" : lvl === "ok" ? "✓ " : lvl === "error" ? "✗ " : "• "}{text}
                  </div>
                ))}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// "Run morning check now": Kite and each enabled item's money, as an extra alert (the 08:45 one stays)
export function CheckNow({ onDone }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    await fetch("/api/v2/alerts/check?kind=morning", { method: "POST" }).catch(() => {});
    await markSeen();
    setBusy(false);
    onDone();
  };
  return (
    <button type="button" onClick={run} disabled={busy} className="rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
      style={{ borderColor: "var(--border)", color: "var(--accent)" }}>
      {busy ? "Checking…" : "Run morning check now"}
    </button>
  );
}

// the desktop window
export function AlertsPanel({ data, onClose, onSeen }) {
  useEffect(() => {
    markSeen().then(onSeen); // opening the list reads everything
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end bg-black/40 p-2 pt-14" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Alerts" className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border shadow-xl"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <h2 className="text-sm font-semibold">Alerts</h2>
          <span className="ml-auto mr-2"><CheckNow onDone={onSeen} /></span>
          <button type="button" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-md hover:bg-[var(--surface-2)]" style={{ color: "var(--muted)" }}
            aria-label="Close alerts">
            <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div className="overflow-auto px-4 py-3">
          <AlertList data={data} />
        </div>
      </div>
    </div>
  );
}
