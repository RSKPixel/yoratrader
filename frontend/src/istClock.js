import { useEffect, useState } from "react";

// India time now, "20:58:07 · Fri, 20 Nov 2026", ticking every second (the site's and the phone app's header)
function fmt() {
  const now = new Date();
  const t = now.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const part = (o) => now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", ...o });
  const d = `${part({ weekday: "short" })}, ${part({ day: "numeric" })} ${part({ month: "short" })} ${part({ year: "numeric" })}`;
  return `${t} · ${d}`;
}

// one shared tick for every clock and countdown on screen, fired just after each whole second, so they all change together
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

export function useIstClock() {
  useSecond();
  return fmt();
}
