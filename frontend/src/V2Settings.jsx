import { Segmented } from "./V2Controls";
import { KitePanel, useKiteStatus } from "./V2Kite";

// v2 Settings: appearance (dark / light) and Kite (the same panel as the top nav's Kite button).

export default function V2Settings({ theme, onTheme }) {
  const [status, refresh] = useKiteStatus();
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <section className="rounded-lg border p-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <h2 className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>
          Appearance
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Segmented
            label="Theme"
            options={[
              ["dark", "Dark"],
              ["light", "Light"],
            ]}
            value={theme}
            onChange={onTheme}
          />
          <span className="text-xs" style={{ color: "var(--muted)" }}>
            Remembered in this browser.
          </span>
        </div>
      </section>
      <div>
        <h2 className="mb-2 text-sm font-semibold">Kite</h2>
        <KitePanel status={status} refresh={refresh} onStatus={() => refresh(true)} />
      </div>
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Your profile (user name, password) is still in the{" "}
        <a href="/classic" className="underline" style={{ color: "var(--accent)" }}>
          classic app
        </a>
        .
      </p>
    </div>
  );
}
