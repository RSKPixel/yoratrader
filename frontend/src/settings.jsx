import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

// Per-user settings, kept on the server (GET / PUT /api/settings), never in the browser: every device,
// and dev and prod (one database), see the same theme, page parameters and nav state.
// useSetting(key, default) works like useState; changes are saved a moment later, batched.

const SettingsContext = createContext({ values: {}, set: () => {} });
const SAVE_DELAY_MS = 400;

// Settings the app used to keep in this browser: moved to the server once, then removed here.
function legacyBrowserSettings() {
  const out = {};
  try {
    const theme = localStorage.getItem("yt-v2-theme");
    if (theme === "light" || theme === "dark") out.theme = theme;
    const params = JSON.parse(localStorage.getItem("yt-v2-backtest-params-by-model") || "null");
    if (params && typeof params === "object") {
      for (const [model, p] of Object.entries(params)) out[`params.${model}`] = p;
    }
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k?.startsWith("yt-v2-") && k.endsWith("-nav")) out[`nav.${k}`] = localStorage.getItem(k) === "open";
    }
  } catch {
    // storage blocked: nothing to move
  }
  return out;
}

function clearLegacyBrowserSettings() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k?.startsWith("yt-v2-")) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    // nothing to clear
  }
}

function save(values) {
  return fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) }).catch(() => {});
}

export async function loadSettings() {
  const r = await fetch("/api/settings", { cache: "no-store" });
  const body = r.ok ? await r.json() : { settings: {} };
  const values = body.settings || {};
  // one-time move of what this browser had saved (the server's values win)
  const legacy = legacyBrowserSettings();
  const missing = Object.fromEntries(Object.entries(legacy).filter(([k]) => !(k in values)));
  if (Object.keys(missing).length) await save(missing);
  clearLegacyBrowserSettings();
  return { ...missing, ...values };
}

export function SettingsProvider({ initial, children }) {
  const [values, setValues] = useState(initial || {});
  const pending = useRef({});
  const timer = useRef(null);
  const flush = useCallback(() => {
    const batch = pending.current;
    pending.current = {};
    if (Object.keys(batch).length) save(batch);
  }, []);
  useEffect(() => {
    // don't lose a change made just before closing the tab
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      clearTimeout(timer.current);
      flush();
    };
  }, [flush]);
  const set = useCallback(
    (key, update) => {
      setValues((v) => {
        const next = typeof update === "function" ? update(v[key]) : update;
        pending.current[key] = next;
        return { ...v, [key]: next };
      });
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );
  return <SettingsContext.Provider value={{ values, set }}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  return useContext(SettingsContext);
}

export function useSetting(key, fallback) {
  const { values, set } = useContext(SettingsContext);
  const value = values[key] === undefined ? fallback : values[key];
  const update = useCallback((next) => set(key, (current) => (typeof next === "function" ? next(current === undefined ? fallback : current) : next)), [key, set, fallback]);
  return [value, update];
}

export function systemTheme() {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
