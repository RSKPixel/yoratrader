import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { api } from "./api";

// one shared tick for every clock and countdown, just after each whole second, so they change together
const subs = new Set();
let timer = null;
function schedule() {
  timer = setTimeout(() => {
    const now = Date.now();
    subs.forEach((f) => f(now));
    schedule();
  }, 1000 - (Date.now() % 1000) + 5);
}
export function useSecond() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    subs.add(setNow);
    if (!timer) schedule();
    return () => {
      subs.delete(setNow);
      if (!subs.size) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, []);
  return now;
}

// bumps each time the app comes back to the screen (to reload at once, as the site does on resume)
export function useResume() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => s === "active" && setN((x) => x + 1));
    return () => sub.remove();
  }, []);
  return n;
}

// a GET reloaded every `every` ms and on resume; [data, error, reload, loading, nextAt]
export function usePoll(path, every, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [nextAt, setNextAt] = useState(null);
  const loadRef = useRef(null);
  const resumed = useResume();
  useEffect(() => {
    if (!path) return;
    let t, alive = true;
    const load = () => {
      setLoading(true);
      api(path)
        .then((p) => {
          if (!alive) return;
          if (p.status && p.status !== "success") setError(p.message || "Could not load");
          else {
            setError("");
            setData(p);
          }
          plan(typeof every === "function" ? every(p) : every);
        })
        .catch((e) => {
          if (!alive) return;
          setError(e.message || "Could not reach the server");
          plan(60000);
        })
        .finally(() => alive && setLoading(false));
    };
    const plan = (ms) => {
      clearTimeout(t);
      t = setTimeout(load, ms);
      setNextAt(Date.now() + ms);
    };
    loadRef.current = load;
    load();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [path, resumed, ...deps]);
  const reload = useCallback(() => loadRef.current?.(), []);
  return [data, error, reload, loading, nextAt];
}

// the user's settings on the server (as the site's useSetting): [value, set]
let settingsCache = null;
const settingsSubs = new Set();
export function useSetting(key, initial) {
  const [values, setValues] = useState(settingsCache || {});
  useEffect(() => {
    settingsSubs.add(setValues);
    if (!settingsCache)
      api("/api/settings")
        .then((b) => {
          settingsCache = b.settings || {};
          settingsSubs.forEach((f) => f(settingsCache));
        })
        .catch(() => {});
    return () => settingsSubs.delete(setValues);
  }, []);
  const set = (v) => {
    settingsCache = { ...(settingsCache || {}), [key]: v };
    settingsSubs.forEach((f) => f(settingsCache));
    api("/api/settings", { method: "PUT", body: { values: { [key]: v } } }).catch(() => {});
  };
  return [key in values ? values[key] : initial, set, values];
}
