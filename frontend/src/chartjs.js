import { BarController, BarElement, CategoryScale, Chart, Filler, LinearScale, LineController, LineElement, PointElement, Tooltip } from "chart.js";

// Chart.js for the simple line charts (equity curves, a day's P&L); candles stay on lightweight-charts.
Chart.register(LineController, LineElement, PointElement, BarController, BarElement, LinearScale, CategoryScale, Filler, Tooltip);

export { Chart };

export function themeColors(el) {
  const css = getComputedStyle(el.closest(".v2") || document.body);
  const v = (n) => css.getPropertyValue(n).trim();
  return { text: v("--muted"), grid: v("--border"), accent: v("--accent"), faint: v("--faint"), up: v("--positive"), down: v("--negative"), surface: v("--surface") };
}

// Re-render when the v2 theme flips (data-theme on the v2 root)
export function watchTheme(el, onChange) {
  const root = el?.closest(".v2");
  if (!root) return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

export function baseOptions(c, format) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: c.surface,
        titleColor: c.text,
        bodyColor: c.text,
        borderColor: c.grid,
        borderWidth: 1,
        callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${format(ctx.parsed.y)}` },
      },
    },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: c.text, maxTicksLimit: 8, maxRotation: 0, autoSkip: true } },
      y: {
        position: "right",
        border: { display: false },
        grid: { color: (ctx) => (ctx.tick.value === 0 ? c.text : c.grid), lineWidth: (ctx) => (ctx.tick.value === 0 ? 1.2 : 1) },
        ticks: { color: c.text, callback: (v) => format(v) },
      },
    },
  };
}
