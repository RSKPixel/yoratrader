import { useEffect, useState } from "react";
import { useReadOnly } from "./V2Controls";

// Each model's status, shared by everyone (GET / PUT /api/v2/models/status): research (the default),
// testing (paper traded), live (approved for real trading: a marker, nothing places orders), archived.
// One copy for the whole app, so the page buttons, the side nav and the dashboard agree.

export const STATUS = {
  research: { label: "Research", color: "var(--faint)" },
  testing: { label: "Paper testing", color: "var(--warning)" },
  live: { label: "Live", color: "var(--positive)" },
  archived: { label: "Archived", color: "var(--muted)" },
};

let cache = null;
let loading = null;
const listeners = new Set();
const emit = () => listeners.forEach((f) => f(cache));

function load() {
  if (!loading) {
    loading = fetch("/api/v2/models/status")
      .then((r) => r.json())
      .then((p) => {
        cache = p.status === "success" ? p.statuses : {};
        emit();
      })
      .catch(() => {
        cache = {};
        emit();
      });
  }
  return loading;
}

export function useModelStatuses() {
  const [map, setMap] = useState(cache || {});
  useEffect(() => {
    listeners.add(setMap);
    if (cache) setMap(cache);
    else load();
    return () => listeners.delete(setMap);
  }, []);
  return map;
}

export const statusOf = (map, id) => map[id] || "research";

export async function setModelStatus(id, status) {
  const r = await fetch("/api/v2/models/status", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: id, status }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `Could not save (${r.status})`);
  cache = { ...(cache || {}) };
  if (status === "research") delete cache[id];
  else cache[id] = status;
  emit();
}

// The page header's buttons: Paper test, Go live, Archive; clicking the current one goes back to Research.
export function StatusButtons({ id }) {
  const map = useModelStatuses();
  const current = statusOf(map, id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ro = useReadOnly();
  const buttons = [
    ["testing", "Paper test", "Mark as being paper traded"],
    ["live", "Go live", "Mark as approved for real trading (a marker only: nothing places orders)"],
    ["archived", "Archive", "Drop it: moves to Archived in the side nav and leaves the dashboard"],
  ];
  const click = async (status) => {
    setBusy(true);
    setError("");
    try {
      await setModelStatus(id, current === status ? "research" : status);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: STATUS[current].color }} title="This model's status, shared by everyone">
        <span className="h-2 w-2 rounded-full" style={{ background: STATUS[current].color }} aria-hidden="true" />
        {STATUS[current].label}
      </span>
      {!ro && <span className="inline-flex overflow-hidden rounded-md border" style={{ borderColor: "var(--border)" }}>
        {buttons.map(([status, label, hint]) => {
          const on = current === status;
          return (
            <button
              key={status}
              type="button"
              disabled={busy}
              onClick={() => click(status)}
              title={on ? `${hint} · click again to go back to Research` : hint}
              aria-pressed={on}
              className="border-l px-2.5 py-1 text-xs font-medium transition-colors first:border-l-0 hover:bg-[var(--surface-2)] disabled:opacity-50"
              style={{ borderColor: "var(--border)", ...(on ? { background: `color-mix(in srgb, ${STATUS[status].color} 16%, transparent)`, color: STATUS[status].color } : { color: "var(--muted)" }) }}
            >
              {label}
            </button>
          );
        })}
      </span>}
      {error && <span className="text-xs" style={{ color: "var(--negative)" }}>{error}</span>}
    </span>
  );
}
