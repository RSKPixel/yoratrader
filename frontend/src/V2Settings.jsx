import { useCallback, useEffect, useState } from "react";

// v2 Settings: the daily Kite login (status, log in, check again). Other settings (Kite API key,
// profile) are still in the classic app for now.

function KiteCard() {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const check = useCallback((force) => {
    setChecking(true);
    fetch(`/api/kite/status${force ? "?refresh=true" : ""}`)
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ connected: false, error: "Could not reach the API" }))
      .finally(() => setChecking(false));
  }, []);
  useEffect(() => check(false), [check]);
  const connected = status?.connected;
  const at = status?.checked_at ? new Date(status.checked_at * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <section className="max-w-2xl rounded-lg border p-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Kite connection</h2>
          <p className="mt-1 flex items-center gap-2 text-sm">
            <span className="h-2 w-2 rounded-full" style={{ background: status == null ? "var(--faint)" : connected ? "var(--positive)" : "var(--negative)" }} aria-hidden="true" />
            <span style={{ color: connected ? "var(--positive)" : status == null ? "var(--muted)" : "var(--negative)" }}>
              {status == null ? "Checking…" : connected ? "Connected" : "Not connected"}
            </span>
            {at && <span className="text-xs" style={{ color: "var(--faint)" }}>checked {at}</span>}
          </p>
          {!connected && status?.error && (
            <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
              {status.error}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <a
            href="/api/kite/login"
            target="_blank"
            rel="noreferrer"
            className="rounded-md px-3 py-1.5 text-sm font-medium"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            Log in to Kite
          </a>
          <button
            type="button"
            onClick={() => check(true)}
            disabled={checking}
            className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
            style={{ borderColor: "var(--border)" }}
          >
            {checking ? "Checking…" : "Check again"}
          </button>
        </div>
      </div>
      <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
        The access token expires every day: log in before 09:05 so the paper traders and the pre-open test can record. Kite opens in a
        new tab and comes back to a "Kite connected" page; then check again here.
      </p>
    </section>
  );
}

export default function V2Settings() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <KiteCard />
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        The Kite API key, the manual token entry and your profile are still in the{" "}
        <a href="/classic" className="underline" style={{ color: "var(--accent)" }}>
          classic app
        </a>{" "}
        until they move here.
      </p>
    </div>
  );
}
