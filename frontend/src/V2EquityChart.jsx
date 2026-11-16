import { useEffect, useRef, useState } from "react";
import { baseOptions, Chart, themeColors, watchTheme } from "./chartjs";

// Cumulative net and gross on the v2 theme (Chart.js); values are fractions of capital in %, shown via
// `format`. The zero line is drawn heavier, so a curve below break-even reads at a glance.

export default function V2EquityChart({ points, format }) {
  const canvas = useRef(null);
  const [theme, setTheme] = useState(0);
  useEffect(() => watchTheme(canvas.current, () => setTheme((n) => n + 1)), []);

  useEffect(() => {
    if (!canvas.current || !points?.length) return undefined;
    const c = themeColors(canvas.current);
    const chart = new Chart(canvas.current, {
      type: "line",
      data: {
        labels: points.map((p) => p.date),
        datasets: [
          { label: "Net", data: points.map((p) => p.net), borderColor: c.accent, borderWidth: 2, pointRadius: 0, tension: 0 },
          { label: "Gross", data: points.map((p) => p.gross), borderColor: c.faint, borderWidth: 1, pointRadius: 0, tension: 0 },
        ],
      },
      options: baseOptions(c, format),
    });
    return () => chart.destroy();
  }, [points, format, theme]);

  return (
    <div className="relative h-72 w-full">
      <canvas ref={canvas} />
    </div>
  );
}
