import { useEffect, useState } from "react";
import KiteTokenPanel from "./KiteTokenPanel";
import { clearEventLog, getEventLog, subscribeEventLog } from "./eventLog";

function levelClass(level) {
  if (level === "error") return "text-[#f0b4b4]";
  if (level === "warn") return "text-[#e2c08a]";
  if (level === "success") return "text-[#8fbf9f]";
  return "text-[#c8c3b8]";
}

export default function SettingsPage({ wsState }) {
  const [logs, setLogs] = useState(() => getEventLog());
  const [health, setHealth] = useState(null);
  const [testing, setTesting] = useState(false);
  const [tab, setTab] = useState("diagnostics");

  useEffect(() => subscribeEventLog(setLogs), []);

  const runDiagnostics = async () => {
    setTesting(true);
    setHealth(null);
    const results = {
      pageUrl: window.location.href,
      apiOrigin: window.location.origin,
      wsUrl: wsState?.url || "—",
      wsReadyState: wsState?.readyStateLabel || "—",
      checkedAt: new Date().toISOString(),
      apiHealth: null,
      wsProbe: null,
    };

    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      results.apiHealth = {
        ok: response.ok,
        status: response.status,
        body,
      };
    } catch (error) {
      results.apiHealth = { ok: false, error: String(error?.message || error) };
    }

    const probeUrl =
      wsState?.url ||
      `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/events`;
    results.wsProbe = await new Promise((resolve) => {
      let settled = false;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        resolve(payload);
      };
      let socket;
      try {
        socket = new WebSocket(probeUrl);
      } catch (error) {
        finish({ ok: false, error: String(error?.message || error) });
        return;
      }
      const timer = window.setTimeout(() => {
        finish({ ok: false, error: "timeout after 5s", readyState: socket.readyState });
      }, 5000);
      socket.onopen = () => {
        socket.send("diag");
        window.clearTimeout(timer);
        finish({ ok: true, readyState: socket.readyState });
      };
      socket.onerror = () => {
        window.clearTimeout(timer);
        finish({ ok: false, error: "websocket error event", readyState: socket.readyState });
      };
      socket.onclose = (event) => {
        window.clearTimeout(timer);
        finish({
          ok: false,
          error: "closed before open",
          code: event.code,
          reason: event.reason || "",
          wasClean: event.wasClean,
          readyState: socket.readyState,
        });
      };
    });

    setHealth(results);
    setTesting(false);
  };

  const copyLogs = async () => {
    const text = JSON.stringify({ wsState, health, logs }, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-[#9b968c]">
            Connection diagnostics, runtime error log and Kite login.
          </p>
        </div>
        {tab === "diagnostics" && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={runDiagnostics}
            disabled={testing}
            className="rounded-md border border-[#e2c08a]/60 px-3 py-1.5 text-sm text-[#e2c08a] hover:bg-white/5 disabled:opacity-40"
          >
            {testing ? "Testing…" : "Run diagnostics"}
          </button>
          <button
            type="button"
            onClick={copyLogs}
            className="rounded-md border border-[#2c313a] px-3 py-1.5 text-sm text-[#c8c3b8] hover:bg-white/5"
          >
            Copy log
          </button>
          <button
            type="button"
            onClick={() => clearEventLog()}
            className="rounded-md border border-[#2c313a] px-3 py-1.5 text-sm text-[#9b968c] hover:bg-white/5"
          >
            Clear log
          </button>
        </div>
        )}
      </header>

      <nav className="mb-4 flex gap-1 border-b border-[#2c313a]">
        {[
          ["diagnostics", "Diagnostics"],
          ["kite", "Kite"],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === id ? "border-[#e2c08a] text-[#e7e4dc]" : "border-transparent text-[#9b968c] hover:text-[#c8c3b8]"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "kite" ? (
        <KiteTokenPanel />
      ) : (
        <>

      <div className="mb-4 grid gap-3 md:grid-cols-2">
        <section className="rounded-md border border-[#2c313a] bg-[#181b20] p-4">
          <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-[#6f6a62]">Live WebSocket</h2>
          <dl className="mt-3 space-y-2 font-mono text-xs text-[#c8c3b8]">
            <div className="flex justify-between gap-3">
              <dt className="text-[#9b968c]">Status</dt>
              <dd className={wsState?.connected ? "text-[#8fbf9f]" : "text-[#f0b4b4]"}>
                {wsState?.connected ? "Connected" : "Offline"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[#9b968c]">Transport</dt>
              <dd className="uppercase">{wsState?.transport || "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[#9b968c]">URL</dt>
              <dd className="truncate text-right">{wsState?.url || "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[#9b968c]">Ready state</dt>
              <dd>{wsState?.readyStateLabel || "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[#9b968c]">Last close</dt>
              <dd className="text-right">
                {wsState?.lastClose
                  ? `${wsState.lastClose.code}${wsState.lastClose.reason ? ` · ${wsState.lastClose.reason}` : ""}`
                  : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[#9b968c]">Last error</dt>
              <dd className="truncate text-right text-[#f0b4b4]">{wsState?.lastError || "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[#9b968c]">Retries</dt>
              <dd>{wsState?.retries ?? 0}</dd>
            </div>
          </dl>
        </section>

        <section className="rounded-md border border-[#2c313a] bg-[#181b20] p-4">
          <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-[#6f6a62]">Diagnostics</h2>
          {!health && (
            <p className="mt-3 text-sm text-[#9b968c]">Run diagnostics to probe `/api/health` and `/ws/events`.</p>
          )}
          {health && (
            <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[0.7rem] text-[#c8c3b8]">
              {JSON.stringify(health, null, 2)}
            </pre>
          )}
        </section>
      </div>

      <section className="min-h-0 flex-1 overflow-auto rounded-md border border-[#2c313a] bg-[#181b20]">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[#2c313a] bg-[#1e2128] px-4 py-3">
          <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-[#9b968c]">Event log</h2>
          <p className="font-mono text-xs text-[#6f6a62]">{logs.length} entries</p>
        </div>
        {logs.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-[#9b968c]">No events yet.</p>
        ) : (
          <ul className="divide-y divide-[#2c313a]">
            {logs.map((entry) => (
              <li key={entry.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-2 font-mono text-xs">
                  <span className="text-[#6f6a62]">{entry.at}</span>
                  <span className={`uppercase ${levelClass(entry.level)}`}>{entry.level}</span>
                  <span className="text-[#e7e4dc]">{entry.message}</span>
                </div>
                {entry.detail && (
                  <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[0.65rem] text-[#9b968c]">
                    {entry.detail}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
        </>
      )}
    </div>
  );
}
