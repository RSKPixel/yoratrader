import { displayName, useAuth } from "../AuthGate";
import { Segmented } from "../V2Controls";

// The phone app's last tab: who is logged in, log out, the theme and the full site.

export default function MobileMore({ theme, onTheme }) {
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
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4" />
          </svg>
          Log out
        </button>
      </div>
      <div className="rounded-xl border p-4" style={box}>
        <Segmented label="Theme" options={[["light", "Light"], ["dark", "Dark"]]} value={theme} onChange={onTheme} />
      </div>
      <a href="/v2/dashboard" className="rounded-xl border py-3 text-center text-sm font-semibold active:bg-[var(--surface-2)]" style={{ ...box, color: "var(--accent)" }}>
        Full site
      </a>
    </div>
  );
}
