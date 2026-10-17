const MAX_ENTRIES = 200;
const listeners = new Set();
let entries = [];

function emit() {
  for (const listener of listeners) listener(entries);
}

export function logEvent(level, message, detail = null) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    level,
    message: String(message || ""),
    detail:
      detail == null
        ? null
        : typeof detail === "string"
          ? detail
          : (() => {
              try {
                return JSON.stringify(detail, null, 2);
              } catch {
                return String(detail);
              }
            })(),
  };
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  if (level === "error") {
    console.error("[yoratrader]", message, detail ?? "");
  } else if (level === "warn") {
    console.warn("[yoratrader]", message, detail ?? "");
  } else {
    console.info("[yoratrader]", message, detail ?? "");
  }
  emit();
  return entry;
}

export function getEventLog() {
  return entries;
}

export function clearEventLog() {
  entries = [];
  emit();
}

export function subscribeEventLog(listener) {
  listeners.add(listener);
  listener(entries);
  return () => listeners.delete(listener);
}
