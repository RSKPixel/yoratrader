import { useEffect, useRef, useState } from "react";
import { createChart, LineSeries } from "lightweight-charts";

// Cumulative net and gross on the v2 theme; values are fractions of capital in %, shown via `format`.

function themeColors(el) {
  const css = getComputedStyle(el.closest(".v2") || document.body);
  const v = (name) => css.getPropertyValue(name).trim();
  return { text: v("--muted"), grid: v("--border"), net: v("--accent"), gross: v("--faint"), bg: v("--surface") };
}

export default function V2EquityChart({ points, format }) {
  const box = useRef(null);
  const [theme, setTheme] = useState(0);

  useEffect(() => {
    // Redraw when the theme flips (data-theme on the v2 root).
    const root = box.current?.closest(".v2");
    if (!root) return undefined;
    const observer = new MutationObserver(() => setTheme((n) => n + 1));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!box.current || !points?.length) return undefined;
    const c = themeColors(box.current);
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: c.text, fontFamily: "IBM Plex Sans, sans-serif" },
      grid: { vertLines: { visible: false }, horzLines: { color: c.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
      crosshair: { horzLine: { labelBackgroundColor: c.net }, vertLine: { labelBackgroundColor: c.net } },
      localization: { priceFormatter: format },
    });
    const gross = chart.addSeries(LineSeries, { color: c.gross, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const net = chart.addSeries(LineSeries, { color: c.net, lineWidth: 2, priceLineVisible: false });
    gross.setData(points.map((p) => ({ time: p.date, value: p.gross })));
    net.setData(points.map((p) => ({ time: p.date, value: p.net })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, format, theme]);

  return <div ref={box} className="h-72 w-full" />;
}
