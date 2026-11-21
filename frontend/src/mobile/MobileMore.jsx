import { LogOut } from "lucide-react";
import { displayName, useAuth } from "../AuthGate";
import { Segmented } from "../V2Controls";
import MobileSchedule from "./MobileSchedule";
import { StatusCard } from "./MobileHome";

// The phone app's last tab: who is logged in, log out, keep the screen on, the market / Kite / next refresh, the theme, the schedules (as the site's Settings) and the full site.

export default function MobileMore({ theme, onTheme, keepAwake, onKeepAwake, awake, d, nextAt, onRefresh, loading }) {
  const { user, logout } = useAuth();
  const box = { borderColor: "var(--border)", background: "var(--surface)" };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 rounded-xl border p-4" style={box}>
        <div className="min-w-0">
          <div className="text-xs" style={{ color: "var(--muted)" }}>Logged in as</div>
          <div className="truncate text-base font-semibold">{displayName(user)}</div>
        </div>
        <button
          type="button"
          onClick={logout}
          className="flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium"
          style={{ borderColor: "var(--border)", color: "var(--negative)" }}
        >
          <LogOut className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
          Log out
        </button>
      </div>
      {d && <StatusCard d={d} nextAt={nextAt} onRefresh={onRefresh} loading={loading} />}
      <div className="rounded-xl border p-4" style={box}>
        <Segmented label="Theme" options={[["light", "Light"], ["dark", "Dark"]]} value={theme} onChange={onTheme} />
      </div>
      <div className="rounded-xl border p-4" style={box}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">Keep screen on</span>
          <Segmented label="Keep screen on" options={[["on", "On"], ["off", "Off"]]} value={keepAwake ? "on" : "off"} onChange={(v) => onKeepAwake(v === "on")} />
        </div>
        <p className="mt-2 text-xs" style={{ color: awake === "tap" ? "var(--warning)" : "var(--muted)" }}>
          {awake === "on" ? "The screen stays on while the app is open." : awake === "tap" ? "Tap anywhere once to start keeping the screen on." : keepAwake ? "Starting…" : "The phone sleeps as usual."}
        </p>
      </div>
      {d && (
        <section className="flex flex-col gap-2">
          <h2 className="px-1 text-xs font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--faint)" }}>Schedules</h2>
          <MobileSchedule d={d} />
        </section>
      )}
      <a href="/v2/dashboard" className="rounded-xl border py-3 text-center text-sm font-semibold active:bg-[var(--surface-2)]" style={{ ...box, color: "var(--accent)" }}>
        Full site
      </a>
    </div>
  );
}
