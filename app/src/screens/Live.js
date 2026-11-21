import { View } from "react-native";
import { formatRs, num, signedRs } from "../format";
import { usePoll } from "../hooks";
import { tone, useTheme } from "../theme";
import { Card, Divider, Line, Pill, T } from "../ui";

// The live trading items (real money or dry run): one card each, the same rows in the same order as the site's
const lotsText = (s, need) => {
  const lots = s.lots ?? 1;
  return `${lots} lot${lots > 1 ? "s" : ""}${need ? ` (${formatRs(need)} ${s.instrument === "future" ? "margin" : "premium"})` : ""}`;
};
function funds(settings = {}, f, needRs) {
  const fut = settings.price === "futures" || settings.instrument === "future";
  const v = f && !f.error ? (fut ? f.available : f.cash) : null;
  const need = needRs ?? (settings.price === "spot" ? settings.capital : null);
  return { label: fut ? "Margin available" : "Cash available", value: v, short: v != null && need != null && v < need, error: !f || f.error ? f?.error || "—" : null };
}

function ItemCard({ it }) {
  const c = useTheme();
  const s = it.settings || {};
  const f = funds(s, it.funds, it.need_rs);
  const size = s.capital != null && s.price !== "futures" ? formatRs(s.capital) : s.lots != null ? lotsText(s, it.need_rs) : "1 lot each";
  return (
    <Card border={it.enabled && it.real ? c.negative : it.enabled ? c.positive : c.border} style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={14} weight="600" numberOfLines={1}>{it.name}</T>
          <T size={12} muted numberOfLines={1}>{it.model}</T>
        </View>
        <View style={{ flexDirection: "row", gap: 4 }}>
          <Pill color={it.enabled ? c.positive : c.faint}>{it.enabled ? "On" : "Off"}</Pill>
          {it.engine && <Pill color={it.real ? c.negative : c.accent}>{it.real ? "Live" : "Dry run"}</Pill>}
        </View>
      </View>
      <View style={{ gap: 4 }}>
        <Line label="Account" value={it.account} />
        <Line label="Realized" value={signedRs(it.realized_rs)} color={tone(c, it.realized_rs)} />
        <Line label="Unrealized" value={signedRs(it.unrealized_rs)} color={tone(c, it.unrealized_rs)} />
        <Line label="Holding" value={`${it.open.length}${s.max_open != null ? ` / ${s.max_open}` : ""}`} />
        <Line label="Invested" value={formatRs(it.invested_rs)} />
        <Line label="Size" value={size} />
        <Line label="Trades closed" value={String(it.trades)} />
        <Line label={f.label} value={f.error ? (f.error !== "—" ? `— (${f.error})` : "—") : formatRs(f.value ?? 0)} color={f.error ? c.faint : f.short ? c.negative : undefined} />
        <Line label="Today's orders" value={`${it.real ? `${it.today.sent} sent` : `${it.today.dry} logged`}${it.today.problems ? ` · ${it.today.problems} problems` : ""}`}
          color={it.today.problems ? c.negative : undefined} />
      </View>
      {it.open.length > 0 && (
        <View>
          {it.open.map((p) => (
            <View key={`${p.symbol}-${p.buy_day}`}>
              <Divider />
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 }}>
                <T size={12} weight="600" style={{ flex: 1.2 }} numberOfLines={1}>{p.symbol}</T>
                <T size={12} muted mono style={{ flex: 1.4 }} numberOfLines={1}>{p.qty} @ {num(p.buy_price)}</T>
                <T size={12} mono style={{ flex: 1, textAlign: "right" }}>{num(p.last)}</T>
                <T size={12} mono weight="500" color={tone(c, p.pnl_rs)} style={{ flex: 1, textAlign: "right" }}>{signedRs(p.pnl_rs)}</T>
                <T size={12} color={p.state === "held" ? c.faint : c.warning} style={{ textAlign: "right" }}>{p.state}</T>
              </View>
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}

export function LiveItems() {
  const c = useTheme();
  const [data, error] = usePoll("/api/v2/live/summary", 60000);
  if (error && !data) return <T size={13} color={c.negative}>{error}</T>;
  if (!data) return <T size={13} muted>Loading…</T>;
  if (!data.items.length) return <T size={13} muted>No live trading items.</T>;
  return <View style={{ gap: 12 }}>{data.items.map((it) => <ItemCard key={it.id} it={it} />)}</View>;
}

export default function Live() {
  return <LiveItems />;
}
