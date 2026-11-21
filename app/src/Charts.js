import { useState } from "react";
import { View } from "react-native";
import Svg, { Line as SLine, Path } from "react-native-svg";
import { formatRs, num, pct, signedRs } from "./format";
import { usePoll } from "./hooks";
import { tone, useTheme } from "./theme";
import { Card, T } from "./ui";

// The Paper tab's charts, as on the site's phone home: each open position's price since it was bought,
// and every paper book's net P&L by day.

function PositionCard({ p }) {
  const c = useTheme();
  const [w, setW] = useState(300);
  const H = 80, pad = 4;
  const closes = p.closes || [];
  const prices = closes.map((x) => x[1]).concat([p.entry, p.stop].filter((v) => v != null));
  const lo = Math.min(...prices), hi = Math.max(...prices), span = hi - lo || 1;
  const y = (v) => pad + (H - 2 * pad) * (1 - (v - lo) / span);
  const x = (i) => (closes.length > 1 ? (w * i) / (closes.length - 1) : w / 2);
  const line = closes.map((k, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(k[1]).toFixed(1)}`).join("");
  const color = p.net_rs ? tone(c, p.net_rs) : c.muted;
  const short = p.side === "short";
  const days = closes.length ? new Set(closes.map((k) => new Date(k[0] * 1000).toISOString().slice(0, 10))).size : 0;
  return (
    <Card style={{ padding: 12, gap: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <T size={14} weight="600">{p.symbol}</T>
            {short && <T size={10} weight="600" color={c.negative} style={{ textTransform: "uppercase" }}>short</T>}
            {p.key?.startsWith("NFO:") && <T size={10} weight="600" faint style={{ textTransform: "uppercase", letterSpacing: 0.6 }}>fut</T>}
          </View>
          <T size={11} muted numberOfLines={1}>{p.books.map((b) => b.label).join(" · ")}</T>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <T size={14} weight="600" mono color={color}>{p.net_rs == null ? "—" : signedRs(p.net_rs)}</T>
          <T size={11} mono color={color}>{pct(p.net_pct)}</T>
        </View>
      </View>
      <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ height: H }}>
        {closes.length > 1 ? (
          <Svg width={w} height={H}>
            <SLine x1={0} x2={w} y1={y(p.entry)} y2={y(p.entry)} stroke={c.accent} strokeWidth={1} strokeDasharray="4 3" />
            {p.stop != null && <SLine x1={0} x2={w} y1={y(p.stop)} y2={y(p.stop)} stroke={c.negative} strokeWidth={1} strokeDasharray="2 3" />}
            <Path d={`${line}L${w},${H}L0,${H}Z`} fill={color} opacity={0.08} />
            <Path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" />
          </Svg>
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><T size={12} faint>No price path</T></View>
        )}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <T size={11} mono color={c.accent}>
          {short ? "Sold" : "Bought"} {num(p.entry)}{p.stop != null ? <T size={11} mono color={c.negative}>{` · stop ${num(p.stop)}`}</T> : null}
        </T>
        <T size={11} muted mono>now {num(p.last)} · {p.day_of_hold ? `day ${p.day_of_hold}` : days > 1 ? `${days} days` : "today"}</T>
      </View>
      {p.books.flatMap((b) => b.plan || p.plan || []).length > 0 && (
        <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 6, gap: 2 }}>
          {p.books.flatMap((b) => (b.plan || p.plan || []).map(([when, what]) => (
            <T key={`${b.label}-${when}`} size={11} muted>
              <T size={11} weight="500" color={when === "Sell order placed" ? c.warning : when === "Disaster stop" ? c.negative : c.text}>{when}</T>
              {` · ${what}`}
            </T>
          )))}
        </View>
      )}
    </Card>
  );
}

export function OpenPositions({ query }) {
  const c = useTheme();
  const [data, error] = usePoll(`/api/v2/paper/open-positions?${query}`, 60000, [query]);
  if (error && !data) return <T size={13} color={c.negative}>{error}</T>;
  if (!data) return <T size={13} faint>Loading…</T>;
  const rows = data.positions || [];
  const problems = [data.chart_error, ...Object.entries(data.errors || {}).map(([k, v]) => `${k}: ${v}`)].filter(Boolean);
  return (
    <View style={{ gap: 10 }}>
      {rows.length === 0 ? <T size={13} muted>No paper book holds anything right now.</T> : rows.map((p) => <PositionCard key={`${p.key}-${p.since}-${p.entry}`} p={p} />)}
      {problems.length > 0 && <T size={12} color={c.warning}>{problems.join(" · ")}</T>}
    </View>
  );
}

const BOOK_COLORS = ["#4C8DF6", "#E5A50A", "#A66BD3", "#21A69A", "#E0607E"];
const rs = (v) => `${v < 0 ? "−" : v > 0 ? "+" : ""}${formatRs(Math.abs(v))}`;

// every paper book's cumulative net by day, the total in the accent colour; a legend under it
export function PaperCurve({ query }) {
  const c = useTheme();
  const [w, setW] = useState(300);
  const [data, error] = usePoll(`/api/v2/paper/curve?${query}`, 5 * 60000, [query]);
  if (error && !data) return <T size={13} color={c.negative}>{error}</T>;
  if (!data) return <T size={13} faint>Loading…</T>;
  if (!data.days?.length) return <T size={13} muted>No paper results yet.</T>;
  const names = Object.keys(data.series);
  const all = [...data.total, ...names.flatMap((n) => data.series[n])].filter((v) => v != null);
  const lo = Math.min(0, ...all), hi = Math.max(0, ...all), span = hi - lo || 1;
  const H = 200, left = 0, top = 8, bottom = 8;
  const n = data.days.length;
  const x = (i) => left + (n > 1 ? ((w - left) * i) / (n - 1) : (w - left) / 2);
  const y = (v) => top + (H - top - bottom) * (1 - (v - lo) / span);
  const path = (vals) => vals.map((v, i) => (v == null ? "" : `${i && vals[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join("");
  const last = (vals) => vals[vals.length - 1];
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <T size={11} faint mono>{rs(hi)}</T>
      </View>
      <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ height: H }}>
        <Svg width={w} height={H}>
          <SLine x1={0} x2={w} y1={y(0)} y2={y(0)} stroke={c.border} strokeWidth={1} />
          {names.map((nm, i) => <Path key={nm} d={path(data.series[nm])} fill="none" stroke={BOOK_COLORS[i % BOOK_COLORS.length]} strokeWidth={1.5} strokeLinejoin="round" />)}
          <Path d={path(data.total)} fill="none" stroke={c.accent} strokeWidth={2.5} strokeLinejoin="round" />
        </Svg>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <T size={11} faint mono>{rs(lo)}</T>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <T size={11} faint mono>{data.days[0]}</T>
        <T size={11} faint mono>{data.days[n - 1]}</T>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 16, height: 2, backgroundColor: c.accent }} />
          <T size={12} weight="500">Total {rs(last(data.total))}</T>
        </View>
        {names.map((nm, i) => {
          const v = last(data.series[nm]);
          return (
            <View key={nm} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ width: 16, height: 2, backgroundColor: BOOK_COLORS[i % BOOK_COLORS.length] }} />
              <T size={12} muted>{nm} <T size={12} color={tone(c, v)}>{rs(v)}</T></T>
            </View>
          );
        })}
      </View>
    </View>
  );
}
