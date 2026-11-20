import { useEffect, useState } from "react";

// India time now, "20:58:07 · Fri, 20 Nov 2026", ticking every second (the site's and the phone app's header)
function fmt() {
  const now = new Date();
  const t = now.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const part = (o) => now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", ...o });
  const d = `${part({ weekday: "short" })}, ${part({ day: "numeric" })} ${part({ month: "short" })} ${part({ year: "numeric" })}`;
  return `${t} · ${d}`;
}

export function useIstClock() {
  const [text, setText] = useState(fmt);
  useEffect(() => {
    const id = setInterval(() => setText(fmt()), 1000);
    return () => clearInterval(id);
  }, []);
  return text;
}
