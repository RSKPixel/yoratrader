import { useEffect, useState } from "react";

export default function StatusBar({ connected, message, level, progress }) {
  const levelColor =
    level === "error"
      ? "text-[#f0b4b4]"
      : level === "success"
        ? "text-[#8fbf9f]"
        : level === "info"
          ? "text-[#e7e4dc]"
          : "text-[#9b968c]";

  const [kite, setKite] = useState(null);
  useEffect(() => {
    let alive = true;
    const check = () =>
      fetch("/api/kite/status")
        .then((res) => res.json())
        .then((data) => alive && setKite(data))
        .catch(() => alive && setKite({ connected: false, error: "Could not reach the API" }));
    check();
    const timer = setInterval(check, 60000);
    window.addEventListener("kite-status-changed", check);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("kite-status-changed", check);
    };
  }, []);

  return (
    <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-[#2c313a] bg-[#16181d] px-4 text-xs">
      <span className="inline-flex items-center gap-1.5 font-mono text-[#9b968c]">
        <span
          className={`h-2 w-2 rounded-full ${connected ? "bg-[#8fbf9f]" : "bg-[#6b3030]"}`}
          title={connected ? "Live updates connected" : "Live updates disconnected"}
        />
        {connected ? "Live" : "Offline"}
      </span>
      <span className="inline-flex items-center gap-1.5 font-mono text-[#9b968c]" title={kite?.error || (kite?.user_id ? `Kite: ${kite.user_id}` : "Checking Kite")}>
        <span
          className={`h-2 w-2 rounded-full ${kite === null ? "bg-[#5c5850]" : kite.connected ? "bg-[#8fbf9f]" : "bg-[#6b3030]"}`}
        />
        {kite === null ? "Kite…" : kite.connected ? "Kite" : "Kite disconnected"}
        {kite && !kite.connected && (
          <a href="/api/kite/login" target="_blank" rel="noreferrer" className="text-[#e2c08a] hover:underline">
            Login
          </a>
        )}
      </span>
      {progress?.status === "running" && progress.total > 0 && (
        <div className="h-1 w-24 overflow-hidden rounded bg-[#2c313a]">
          <div
            className="h-full bg-[#e2c08a]"
            style={{ width: `${(progress.done / progress.total) * 100}%` }}
          />
        </div>
      )}
      <p className={`min-w-0 flex-1 truncate font-mono ${levelColor}`}>{message}</p>
    </footer>
  );
}
