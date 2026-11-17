import { useEffect, useRef, useState } from "react";
import { baseOptions, Chart, themeColors, watchTheme } from "./chartjs";
import { formatRs } from "./V2Controls";

// Every paper book's cumulative net in rupees by day (v2dashboard.paper_curve), and the total in the
// accent colour. One line per book; a legend under the chart.

const BOOK_COLORS = ["#4C8DF6", "#E5A50A", "#A66BD3", "#21A69A", "#E0607E"];
const rs = (v) => `${v < 0 ? "−" : v > 0 ? "+" : ""}${formatRs(Math.abs(v))}`;

export default function V2PaperCurve({ query }) {
  const canvas = useRef(null);
  const [theme, setTheme] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => watchTheme(canvas.current, () => setTheme((n) => n + 1)), []);
  useEffect(() => {
    let timer;
    const load = () =>
      fetch(`/api/v2/paper/curve?${query}`)
        .then((r) => r.json())
        .then((p) => (p.status === "success" ? (setData(p), setError("")) : setError(p.message || "Could not load the P&L")))
        .catch(() => setError("Could not reach the API"))
        .finally(() => (timer = setTimeout(load, 5 * 60000)));
    load();
    return () => clearTimeout(timer);
  }, [query]);

  const names = data ? Object.keys(data.series) : [];
  useEffect(() => {
    if (!canvas.current || !data?.days?.length) return undefined;
    const c = themeColors(canvas.current);
    const chart = new Chart(canvas.current, {
      type: "line",
      data: {
        labels: data.days,
        datasets: [
          { label: "Total", data: data.total, borderColor: c.accent, borderWidth: 2.5, pointRadius: data.days.length < 15 ? 3 : 0, tension: 0 },
          ...names.map((n, i) => ({ label: n, data: data.series[n], borderColor: BOOK_COLORS[i % BOOK_COLORS.length], borderWidth: 1.5, pointRadius: data.days.length < 15 ? 2 : 0, tension: 0 })),
        ],
      },
      options: baseOptions(c, (v) => rs(v)),
    });
    return () => chart.destroy();
  }, [data, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      {data && !data.days.length && <p className="text-sm" style={{ color: "var(--muted)" }}>No paper results yet.</p>}
      <div className="relative h-64 w-full" style={{ display: data?.days?.length ? undefined : "none" }}>
        <canvas ref={canvas} />
      </div>
      {data?.days?.length ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5 font-medium">
            <span className="inline-block h-0.5 w-4" style={{ background: "var(--accent)" }} />
            Total {rs(data.total[data.total.length - 1])}
          </span>
          {names.map((n, i) => {
            const last = data.series[n][data.series[n].length - 1];
            return (
              <span key={n} className="flex items-center gap-1.5" style={{ color: "var(--muted)" }}>
                <span className="inline-block h-0.5 w-4" style={{ background: BOOK_COLORS[i % BOOK_COLORS.length] }} />
                {n} <span style={{ color: last > 0 ? "var(--positive)" : last < 0 ? "var(--negative)" : "var(--muted)" }}>{rs(last)}</span>
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
