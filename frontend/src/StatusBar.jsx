export default function StatusBar({ connected, message, level, progress }) {
  const levelColor =
    level === "error"
      ? "text-[#f0b4b4]"
      : level === "success"
        ? "text-[#8fbf9f]"
        : level === "info"
          ? "text-[#e7e4dc]"
          : "text-[#9b968c]";

  return (
    <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-[#2c313a] bg-[#16181d] px-4 text-xs">
      <span className="inline-flex items-center gap-1.5 font-mono text-[#9b968c]">
        <span
          className={`h-2 w-2 rounded-full ${connected ? "bg-[#8fbf9f]" : "bg-[#6b3030]"}`}
          title={connected ? "Live updates connected" : "Live updates disconnected"}
        />
        {connected ? "Live" : "Offline"}
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
