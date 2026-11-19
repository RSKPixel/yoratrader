import { useEffect, useState } from "react";

// A count that goes up each time the page comes back into view: the phone's screen turned back on, the
// browser or tab switched back to, or the page restored from the back/forward cache. Phones freeze a hidden
// page's timers, so data that refreshes on a timer would otherwise stay stale until the next tick. Hooks that
// fetch put this count in their effect's dependencies to load again at once.

let count = 0;
let hiddenAt = null;
const listeners = new Set();

function bump() {
  count += 1;
  listeners.forEach((fn) => fn(count));
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    else if (hiddenAt != null && Date.now() - hiddenAt > 2000) {
      hiddenAt = null;
      bump();
    }
  });
  window.addEventListener("pageshow", (e) => e.persisted && bump());
}

export function useResume() {
  const [n, setN] = useState(count);
  useEffect(() => {
    listeners.add(setN);
    return () => listeners.delete(setN);
  }, []);
  return n;
}
