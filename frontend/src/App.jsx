import { useEffect, useMemo, useRef, useState } from "react";
import CandleModal from "./CandleModal";
import KbdtPage from "./KbdtPage";
import SettingsPage from "./SettingsPage";
import StatusBar from "./StatusBar";
import UtDataModal from "./UtDataModal";
import { logEvent } from "./eventLog";

const EXCHANGES = ["ALL", "NSE", "MCX"];

const READY_STATE = {
  0: "CONNECTING",
  1: "OPEN",
  2: "CLOSING",
  3: "CLOSED",
};

const NAV_ITEMS = {
  market: [{ id: "indian-market", label: "Indian Market" }],
  tradingModels: [{ id: "penfold", label: "Key Breakout Dow Theory" }],
  system: [{ id: "settings", label: "Settings" }],
};

function wsUrl() {
  if (import.meta.env.DEV) return "ws://127.0.0.1:8091/ws/events";
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/events`;
}

function navItemClass(active) {
  return active
    ? "rounded-md bg-[#2a2e36] px-3 py-2 text-left text-sm leading-snug text-[#e7e4dc]"
    : "rounded-md px-3 py-2 text-left text-sm leading-snug text-[#c8c3b8] hover:bg-white/5";
}

export default function App() {
  const [activePage, setActivePage] = useState("indian-market");
  const [exchange, setExchange] = useState("ALL");
  const [query, setQuery] = useState("");
  const [contracts, setContracts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [buildingUt, setBuildingUt] = useState(false);
  const [scanningKbdt, setScanningKbdt] = useState(false);
  const [progress, setProgress] = useState(null);
  const [chartContract, setChartContract] = useState(null);
  const [utContract, setUtContract] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [wsState, setWsState] = useState({
    url: "",
    connected: false,
    readyStateLabel: "CLOSED",
    lastClose: null,
    lastError: null,
    retries: 0,
    transport: "websocket",
  });
  const [statusMessage, setStatusMessage] = useState("Ready");
  const [statusLevel, setStatusLevel] = useState("idle");
  const activeJobRef = useRef(null);
  const contractsRefreshRef = useRef(null);

  useEffect(() => {
    let alive = true;
    let socket;
    let eventSource;
    let retryTimer;
    let heartbeatTimer;
    let retries = 0;
    let useSse = !import.meta.env.DEV; // production often blocks WSS at the edge proxy

    const patchWs = (patch) => {
      setWsState((prev) => ({ ...prev, ...patch }));
    };

    const stopHeartbeat = () => {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    };

    const handlePayload = (payload) => {
      if (payload.type === "status") {
        setStatusMessage(payload.message || "Update");
        setStatusLevel(payload.level || "info");
        if (payload.level === "error") {
          logEvent("error", payload.message || "Status error", payload);
        }
      }

      if (
        payload.type === "eod_progress" ||
        payload.type === "ut_progress" ||
        payload.type === "kbdt_progress"
      ) {
        if (activeJobRef.current && payload.job_id !== activeJobRef.current) return;
        setProgress(payload);
        const isUt = payload.type === "ut_progress" || payload.kind === "ut";
        const isKbdt = payload.type === "kbdt_progress" || payload.kind === "kbdt";
        if (payload.status === "running") {
          if (isKbdt) setScanningKbdt(true);
          else if (isUt) setBuildingUt(true);
          else setDownloading(true);
        }
        if (payload.status === "error") {
          const message =
            payload.message ||
            (isKbdt ? "KBDT scan failed" : isUt ? "UT update failed" : "Download failed");
          setStatusMessage(message);
          setStatusLevel("error");
          logEvent("error", message, payload);
        }
        if (payload.status === "completed" || payload.status === "error") {
          if (isKbdt) {
            setScanningKbdt(false);
          } else if (isUt) {
            setBuildingUt(false);
            if (payload.status === "completed") contractsRefreshRef.current?.();
          } else {
            setDownloading(false);
          }
          activeJobRef.current = null;
        }
      }
    };

    const connectSse = () => {
      const url = "/api/events/stream";
      patchWs({
        url,
        transport: "sse",
        connected: false,
        readyStateLabel: "CONNECTING",
        retries,
      });
      logEvent("info", "SSE connecting", { url, retries });

      try {
        eventSource = new EventSource(url);
      } catch (error) {
        const message = String(error?.message || error);
        logEvent("error", "SSE constructor failed", { url, message });
        patchWs({ lastError: message, readyStateLabel: "CLOSED", connected: false });
        retries += 1;
        retryTimer = window.setTimeout(connectSse, Math.min(10000, 1500 + retries * 500));
        return;
      }

      eventSource.onopen = () => {
        if (!alive) return;
        retries = 0;
        setWsConnected(true);
        setStatusMessage("Connected for live updates (SSE)");
        setStatusLevel("info");
        patchWs({
          connected: true,
          readyStateLabel: "OPEN",
          lastError: null,
          retries: 0,
          transport: "sse",
        });
        logEvent("success", "SSE connected", { url });
      };

      eventSource.onmessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch (error) {
          logEvent("warn", "SSE non-JSON message", {
            preview: String(event.data).slice(0, 200),
            error: String(error?.message || error),
          });
          return;
        }
        handlePayload(payload);
      };

      eventSource.onerror = () => {
        if (!alive) return;
        setWsConnected(false);
        setStatusMessage("Reconnecting live updates...");
        setStatusLevel("idle");
        logEvent("warn", "SSE error / disconnected", { url, readyState: eventSource.readyState });
        patchWs({
          connected: false,
          readyStateLabel: "CLOSED",
          lastError: "SSE disconnected",
          retries: retries + 1,
        });
        try {
          eventSource.close();
        } catch {
          /* ignore */
        }
        retries += 1;
        retryTimer = window.setTimeout(connectSse, Math.min(10000, 1500 + retries * 500));
      };
    };

    const connectWs = () => {
      const url = wsUrl();
      patchWs({
        url,
        transport: "websocket",
        connected: false,
        readyStateLabel: "CONNECTING",
        retries,
      });
      logEvent("info", "WebSocket connecting", { url, retries });

      try {
        socket = new WebSocket(url);
      } catch (error) {
        const message = String(error?.message || error);
        logEvent("error", "WebSocket constructor failed", { url, message });
        patchWs({ lastError: message, readyStateLabel: "CLOSED", connected: false });
        retries += 1;
        useSse = true;
        logEvent("warn", "Falling back to SSE after WebSocket constructor failure");
        retryTimer = window.setTimeout(connectSse, 500);
        return;
      }

      socket.onopen = () => {
        if (!alive) return;
        retries = 0;
        try {
          socket.send("hello");
        } catch (error) {
          logEvent("error", "WebSocket hello send failed", String(error?.message || error));
        }
        setWsConnected(true);
        setStatusMessage("Connected for live updates");
        setStatusLevel("info");
        patchWs({
          connected: true,
          readyStateLabel: READY_STATE[socket.readyState] || "OPEN",
          lastError: null,
          retries: 0,
          transport: "websocket",
        });
        logEvent("success", "WebSocket connected", { url });
        stopHeartbeat();
        heartbeatTimer = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            try {
              socket.send("ping");
            } catch (error) {
              logEvent("warn", "WebSocket ping failed", String(error?.message || error));
            }
          }
        }, 25000);
      };

      socket.onclose = (event) => {
        if (!alive) return;
        stopHeartbeat();
        setWsConnected(false);
        setStatusMessage("Reconnecting live updates...");
        setStatusLevel("idle");
        const lastClose = {
          code: event.code,
          reason: event.reason || "",
          wasClean: event.wasClean,
        };
        patchWs({
          connected: false,
          readyStateLabel: "CLOSED",
          lastClose,
          retries: retries + 1,
        });
        logEvent("warn", "WebSocket closed", { url, ...lastClose });
        retries += 1;
        // 1006 = abnormal close, typical when edge proxy drops WSS upgrades
        if (!import.meta.env.DEV && (event.code === 1006 || retries >= 2)) {
          useSse = true;
          logEvent("warn", "Falling back to SSE (WebSocket unavailable behind proxy)", lastClose);
          retryTimer = window.setTimeout(connectSse, 400);
          return;
        }
        retryTimer = window.setTimeout(connectWs, Math.min(10000, 1500 + retries * 500));
      };

      socket.onerror = () => {
        const readyStateLabel = READY_STATE[socket.readyState] || String(socket.readyState);
        logEvent("error", "WebSocket error event", { url, readyState: readyStateLabel });
        patchWs({ lastError: `error while ${readyStateLabel}`, readyStateLabel });
      };

      socket.onmessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch (error) {
          logEvent("warn", "WebSocket non-JSON message", {
            preview: String(event.data).slice(0, 200),
            error: String(error?.message || error),
          });
          return;
        }
        handlePayload(payload);
      };
    };

    if (useSse) {
      logEvent("info", "Using SSE transport for production live updates");
      connectSse();
    } else {
      connectWs();
    }

    return () => {
      alive = false;
      window.clearTimeout(retryTimer);
      stopHeartbeat();
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      try {
        eventSource?.close();
      } catch {
        /* ignore */
      }
    };
  }, []);

  useEffect(() => {
    if (activePage !== "indian-market") return undefined;

    const controller = new AbortController();

    const loadContracts = ({ quiet = false } = {}) => {
      if (!quiet) {
        setLoading(true);
        setError("");
      }
      return fetch(`/api/contracts?exchange=${exchange}`, { signal: controller.signal })
        .then((response) => response.json())
        .then((payload) => {
          if (payload.status !== "success") {
            setContracts([]);
            setError(payload.message || "Could not load contracts");
            return;
          }
          setContracts(payload.data || []);
        })
        .catch((fetchError) => {
          if (fetchError.name === "AbortError") return;
          setContracts([]);
          setError("Could not reach the API");
        })
        .finally(() => {
          if (!controller.signal.aborted && !quiet) setLoading(false);
        });
    };

    contractsRefreshRef.current = () => loadContracts({ quiet: true });
    loadContracts();

    return () => {
      controller.abort();
      contractsRefreshRef.current = null;
    };
  }, [exchange, activePage]);

  const visible = useMemo(() => {
    const needle = query.trim().toUpperCase();
    if (!needle) return contracts;
    return contracts.filter(
      (contract) =>
        contract.name.toUpperCase().includes(needle) ||
        contract.tradingsymbol.toUpperCase().includes(needle)
    );
  }, [contracts, query]);

  const downloadEod = () => {
    const total = visible.length;
    setDownloading(true);
    setError("");
    setProgress({ status: "running", done: 0, total, symbol: "", candles: 0, errors: [] });
    setStatusMessage(`Starting EOD download for ${total} symbols`);
    setStatusLevel("info");

    fetch("/api/eod", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: visible.map((contract) => contract.name) }),
    })
      .then((response) => response.json())
      .then((payload) => {
        if (payload.status !== "success" || !payload.job_id) {
          setProgress({
            status: "error",
            message: payload.message || "Could not download EOD",
            done: 0,
            total,
            symbol: "",
            candles: 0,
            errors: [],
          });
          setDownloading(false);
          setStatusMessage(payload.message || "Could not download EOD");
          setStatusLevel("error");
          return;
        }
        activeJobRef.current = payload.job_id;
      })
      .catch(() => {
        setError("Could not reach the API");
        setDownloading(false);
        setStatusMessage("Could not reach the API");
        setStatusLevel("error");
      });
  };

  const updateUtData = () => {
    const total = visible.length;
    setBuildingUt(true);
    setError("");
    setProgress({ status: "running", done: 0, total, symbol: "", candles: 0, errors: [], kind: "ut" });
    setStatusMessage(`Starting UT data update for ${total} symbols`);
    setStatusLevel("info");

    fetch("/api/ut-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: visible.map((contract) => contract.name) }),
    })
      .then((response) => response.json())
      .then((payload) => {
        if (payload.status !== "success" || !payload.job_id) {
          setProgress({
            status: "error",
            message: payload.message || "Could not update UT data",
            done: 0,
            total,
            symbol: "",
            candles: 0,
            errors: [],
            kind: "ut",
          });
          setBuildingUt(false);
          setStatusMessage(payload.message || "Could not update UT data");
          setStatusLevel("error");
          return;
        }
        activeJobRef.current = payload.job_id;
      })
      .catch(() => {
        setError("Could not reach the API");
        setBuildingUt(false);
        setStatusMessage("Could not reach the API");
        setStatusLevel("error");
      });
  };

  const scanKbdt = ({ history_bars = 40 } = {}) => {
    setScanningKbdt(true);
    setError("");
    setProgress({
      status: "running",
      done: 0,
      total: 0,
      symbol: "",
      signals: 0,
      errors: [],
      kind: "kbdt",
    });
    setStatusMessage("Starting KBDT signal scan");
    setStatusLevel("info");

    fetch("/api/kbdt/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history_bars }),
    })
      .then((response) => response.json())
      .then((payload) => {
        if (payload.status !== "success" || !payload.job_id) {
          setScanningKbdt(false);
          setStatusMessage(payload.message || "Could not start KBDT scan");
          setStatusLevel("error");
          return;
        }
        activeJobRef.current = payload.job_id;
      })
      .catch(() => {
        setScanningKbdt(false);
        setStatusMessage("Could not reach the API");
        setStatusLevel("error");
      });
  };

  const busy = loading || downloading || buildingUt || scanningKbdt;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center border-b border-[#2c313a] bg-[#16181d] px-5">
        <span className="text-xl font-bold tracking-[0.18em]">
          <span className="text-[#f3efe6]">YORA</span>
          <span className="text-[#e2c08a]">TRADER</span>
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-60 shrink-0 flex-col gap-4 border-r border-[#2c313a] bg-[#16181d] p-3">
          <div>
            <p className="px-3 pb-1 text-[0.65rem] font-medium uppercase tracking-[0.14em] text-[#6f6a62]">
              Market
            </p>
            <div className="flex flex-col gap-0.5 pl-1">
              {NAV_ITEMS.market.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={navItemClass(activePage === item.id)}
                  aria-current={activePage === item.id ? "page" : undefined}
                  onClick={() => setActivePage(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="px-3 pb-1 text-[0.65rem] font-medium uppercase tracking-[0.14em] text-[#6f6a62]">
              Trading Models
            </p>
            <div className="flex flex-col gap-0.5 pl-1">
              {NAV_ITEMS.tradingModels.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={navItemClass(activePage === item.id)}
                  aria-current={activePage === item.id ? "page" : undefined}
                  onClick={() => setActivePage(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="px-3 pb-1 text-[0.65rem] font-medium uppercase tracking-[0.14em] text-[#6f6a62]">
              System
            </p>
            <div className="flex flex-col gap-0.5 pl-1">
              {NAV_ITEMS.system.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={navItemClass(activePage === item.id)}
                  aria-current={activePage === item.id ? "page" : undefined}
                  onClick={() => setActivePage(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </nav>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-6 py-6">
      {activePage === "settings" ? (
        <SettingsPage wsState={wsState} />
      ) : activePage === "penfold" ? (
        <KbdtPage scanning={scanningKbdt} onScan={scanKbdt} />
      ) : (
        <>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Current contracts</h1>
          <p className="mt-1 text-sm text-[#9b968c]">Front-month futures listed on NSE and MCX.</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={downloadEod}
              disabled={busy || visible.length === 0}
              className="rounded-md border border-[#8d877c] px-3 py-1.5 text-sm text-[#f3efe6] hover:bg-white/5 disabled:opacity-40"
            >
              {downloading ? "Downloading" : "Download EOD"}
            </button>
            <button
              type="button"
              onClick={updateUtData}
              disabled={busy || visible.length === 0}
              className="rounded-md border border-[#e2c08a]/60 px-3 py-1.5 text-sm text-[#e2c08a] hover:bg-white/5 disabled:opacity-40"
            >
              {buildingUt ? "Updating UT" : "UT Data"}
            </button>
          </div>
          <p className="font-mono text-sm text-[#9b968c]">
            {loading ? "Loading" : `${visible.length} shown`}
          </p>
        </div>
      </header>

      <form autoComplete="off" className="mb-4 flex flex-wrap items-center gap-3" onSubmit={(event) => event.preventDefault()}>
        <div className="flex rounded-md border border-[#2c313a] bg-[#181b20] p-1">
          {EXCHANGES.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setExchange(item)}
              className={`rounded px-3 py-1.5 text-sm ${
                exchange === item ? "bg-[#e7e4dc] text-[#14110c]" : "text-[#c8c3b8] hover:bg-white/5"
              }`}
            >
              {item}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter scripts"
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          className="min-w-56 flex-1 rounded-md border border-[#2c313a] bg-[#181b20] px-3 py-2 text-sm outline-none placeholder:text-[#6f6a62] focus:border-[#8d877c]"
        />
      </form>

      {error && (
        <p className="mb-4 rounded-md border border-[#6b3030] bg-[#2a1616] px-3 py-2 text-sm text-[#f0b4b4]">
          {error}
        </p>
      )}

      <section className="min-h-0 flex-1 overflow-auto rounded-md border border-[#2c313a] bg-[#181b20]">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-10 bg-[#1e2128] text-left text-xs uppercase tracking-wide text-[#9b968c]">
            <tr>
              <th className="border-b border-[#2c313a] bg-[#1e2128] px-4 py-3 font-medium">Exchange</th>
              <th className="border-b border-[#2c313a] bg-[#1e2128] px-4 py-3 font-medium">Script</th>
              <th className="border-b border-[#2c313a] bg-[#1e2128] px-4 py-3 font-medium">Contract</th>
              <th className="border-b border-[#2c313a] bg-[#1e2128] px-4 py-3 font-medium">Expiry</th>
              <th className="border-b border-[#2c313a] bg-[#1e2128] px-4 py-3 font-medium">Previous expiry</th>
              <th className="border-b border-[#2c313a] bg-[#1e2128] px-4 py-3 text-right font-medium">Lot</th>
              <th className="border-b border-[#2c313a] bg-[#1e2128] px-4 py-3 text-right font-medium">List</th>
              <th className="border-b border-[#2c313a] bg-[#1e2128] px-4 py-3 text-right font-medium">Chart</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((contract) => (
              <tr key={contract.tradingsymbol}>
                <td className="border-b border-[#2c313a] px-4 py-2.5">
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-xs ${
                      contract.exchange === "NSE"
                        ? "bg-[#1d3148] text-[#9ec4ef]"
                        : "bg-[#3a2d1c] text-[#e2c08a]"
                    }`}
                  >
                    {contract.exchange}
                  </span>
                </td>
                <td className="border-b border-[#2c313a] px-4 py-2.5 font-medium">{contract.name}</td>
                <td className="border-b border-[#2c313a] px-4 py-2.5 font-mono text-[#c8c3b8]">{contract.tradingsymbol}</td>
                <td className="border-b border-[#2c313a] px-4 py-2.5 font-mono">{contract.expiry}</td>
                <td className="border-b border-[#2c313a] px-4 py-2.5 font-mono text-[#9b968c]">
                  {contract.previous_expiry || "—"}
                </td>
                <td className="border-b border-[#2c313a] px-4 py-2.5 text-right font-mono">{contract.lot_size.toLocaleString("en-IN")}</td>
                <td className="border-b border-[#2c313a] px-4 py-2.5 text-right">
                  <button
                    type="button"
                    onClick={() => setUtContract(contract)}
                    className="rounded border border-[#2c313a] px-2 py-1 text-xs text-[#e2c08a] hover:bg-white/5"
                    aria-label={`Open UT data table for ${contract.name}`}
                    title={contract.ut_bars ? `${contract.ut_bars} UT bars` : "No UT data yet"}
                  >
                    {contract.ut_bars ? `List (${contract.ut_bars})` : "List"}
                  </button>
                </td>
                <td className="border-b border-[#2c313a] px-4 py-2.5 text-right">
                  <button
                    type="button"
                    onClick={() => setChartContract(contract)}
                    className="rounded border border-[#2c313a] px-2 py-1 text-xs text-[#e2c08a] hover:bg-white/5"
                    aria-label={`Open chart for ${contract.name}`}
                  >
                    Chart
                  </button>
                </td>
              </tr>
            ))}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-[#9b968c]">
                  No contracts match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
        </>
      )}
        </main>
      </div>
      {chartContract && <CandleModal contract={chartContract} onClose={() => setChartContract(null)} />}
      {utContract && <UtDataModal contract={utContract} onClose={() => setUtContract(null)} />}
      <StatusBar
        connected={wsConnected}
        message={statusMessage}
        level={statusLevel}
        progress={progress}
      />
    </div>
  );
}
