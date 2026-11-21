import { View } from "react-native";
import { formatRs, pct, signedRs } from "../format";
import { tone, useTheme } from "../theme";
import { OpenPositions, PaperCurve } from "../Charts";
import { Card, Delta, Divider, Section, T } from "../ui";

// The phone app's home: every paper book's result (as the site's /mobile home)
const BOOKS = ["oops", "buy-on-gap", "xs-mean-reversion", "short-term-reversion", "cumulative-rsi", "turn-of-month"];

export function paperTotals(p, statuses) {
  const on = (id) => (statuses[id] || "research") !== "archived";
  const g = p.gap || {}, x = p.xsmr || {}, c = p.connors || {}, cc = p.connors_cum || {}, op = p.oops || {}, tp = p.tom_paper || {};
  const book = { "buy-on-gap": g, "xs-mean-reversion": x, oops: op, "short-term-reversion": c, "cumulative-rsi": cc, "turn-of-month": tp };
  const live = (b) => (b.today_status === "open" ? b.today_positions || 0 : 0);
  const positions = (on("buy-on-gap") ? live(g) : 0) + (on("xs-mean-reversion") ? live(x) : 0) + (on("oops") ? live(op) : 0) +
    (on("short-term-reversion") ? c.open || 0 : 0) + (on("cumulative-rsi") ? cc.open || 0 : 0) + (on("turn-of-month") ? tp.open || 0 : 0);
  const sum = (field, alt = {}) => BOOKS.filter(on).reduce((a, id) => a + (book[id][alt[id] || field] ?? 0), 0);
  const fut = { "short-term-reversion": "fut_net_rs", "cumulative-rsi": "fut_net_rs" };
  const openFut = { "short-term-reversion": "open_fut_net_rs", "cumulative-rsi": "open_fut_net_rs" };
  const liveNow = (b) => b.today_status === "open" && (b.today_positions || 0) > 0;
  const isOpen = { "buy-on-gap": liveNow(g), "xs-mean-reversion": liveNow(x), oops: liveNow(op),
    "short-term-reversion": (c.open || 0) > 0, "cumulative-rsi": (cc.open || 0) > 0, "turn-of-month": (tp.open || 0) > 0 };
  const caps = BOOKS.filter((id) => on(id) && book[id].capital_rs);
  const spot = (id) => (id === "short-term-reversion" || id === "cumulative-rsi") && book[id].price === "spot";
  return {
    books: BOOKS.filter(on).length, openBooks: BOOKS.filter((id) => on(id) && isOpen[id]).length, positions,
    total: sum("total_net_rs", fut), openRs: sum("open_net_rs", openFut), soldToday: sum("sold_today_rs"),
    cash: caps.filter(spot).reduce((a, id) => a + book[id].capital_rs, 0), margin: caps.filter((id) => !spot(id)).reduce((a, id) => a + book[id].capital_rs, 0),
  };
}

function Hero({ t }) {
  const c = useTheme();
  const stat = (label, v) => (
    <View style={{ flex: 1 }}>
      <T size={12} muted>{label}</T>
      <T size={15} weight="600" mono color={tone(c, v)}>{signedRs(v)}</T>
    </View>
  );
  return (
    <Card>
      <T size={12} muted>Total realized · all paper books</T>
      <View style={{ flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", gap: 12, marginTop: 4 }}>
        <T size={30} weight="600" mono color={tone(c, t.total)}>{signedRs(t.total)}</T>
        <Delta v={t.soldToday} size={14} />
      </View>
      <Divider style={{ marginVertical: 12 }} />
      <View style={{ flexDirection: "row", gap: 12 }}>
        {stat("Today's realized", t.soldToday)}
        {stat("Total unrealized", t.openRs)}
      </View>
      <Divider style={{ marginVertical: 12 }} />
      <T size={12} muted>Capital required</T>
      <T size={15} weight="600" mono>{formatRs(t.cash + t.margin)}</T>
      <T size={11} muted mono>cash {formatRs(t.cash)} · margin {formatRs(t.margin)}</T>
      <View style={{ marginTop: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }}>
        <T size={12} muted>{t.positions} positions open · {t.openBooks} of {t.books} books</T>
      </View>
    </Card>
  );
}

function Row({ title, sub, value, valuePct, open, total, delta, error, first }) {
  const c = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderTopColor: c.border }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T size={14} weight="500" numberOfLines={1}>{title}</T>
        <T size={12} color={error ? c.negative : c.muted} numberOfLines={1}>{error || sub}</T>
      </View>
      {!error && (
        <View style={{ alignItems: "flex-end" }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
            <Delta v={delta} size={10} />
            <T size={14} weight="600" mono color={tone(c, total)}>{signedRs(total)}</T>
          </View>
          <T size={11} faint mono>
            today <T size={11} mono color={tone(c, value)}>{signedRs(value)}{valuePct != null ? ` · ${pct(valuePct)}` : ""}</T>
          </T>
          {open != null && (
            <T size={11} faint mono>
              unrealized <T size={11} mono color={tone(c, open)}>{signedRs(open)}</T>
            </T>
          )}
        </View>
      )}
    </View>
  );
}

export default function Paper({ d, statuses, query }) {
  const p = d.paper;
  const t = paperTotals(p, statuses);
  const shown = (id) => (statuses[id] || "research") !== "archived";
  const g = p.gap || {}, x = p.xsmr || {}, c = p.connors || {}, cc = p.connors_cum || {}, op = p.oops || {}, tp = p.tom_paper || {};
  const intraday = (b, word, none) => (b.today_status ? `${b.today_positions} ${word} · ${b.today_status === "open" ? "live" : "closed"}` : none);
  const held = (b) => `${b.open ?? 0} / ${b.max_open ?? 3} open${b.open_symbols?.length ? ` · ${b.open_symbols.join(", ")}` : ""}`;
  const rows = [
    ["oops", { title: "Oops gap reversal", sub: intraday(op, "bought", `${op.watched ?? 0} watched, no buys yet`), value: op.today_net_rs, valuePct: op.today_value_pct, open: op.open_net_rs, total: op.total_net_rs, delta: op.sold_today_rs, error: op.error }],
    ["buy-on-gap", { title: "Buy/Sell on gap", sub: intraday(g, "positions", "no picks yet"), value: g.today_net_rs, valuePct: g.today_margin_pct, open: g.open_net_rs, total: g.total_net_rs, delta: g.sold_today_rs, error: g.error }],
    ["xs-mean-reversion", { title: "Cross-sectional mean reversion", sub: intraday(x, "positions", "not recorded yet"), value: x.today_net_rs, valuePct: x.today_margin_pct, open: x.open_net_rs, total: x.total_net_rs, delta: x.sold_today_rs, error: x.error }],
    ["short-term-reversion", { title: "Short-term mean reversion (RSI)", sub: held(c), value: c.today_net_rs, valuePct: c.today_value_pct, open: c.open_fut_net_rs, total: c.fut_net_rs, delta: c.sold_today_rs, error: c.error }],
    ["cumulative-rsi", { title: "Short-term mean reversion (C-RSI)", sub: held(cc), value: cc.today_net_rs, valuePct: cc.today_value_pct, open: cc.open_fut_net_rs, total: cc.fut_net_rs, delta: cc.sold_today_rs, error: cc.error }],
    ["turn-of-month", { title: "Turn of the month", sub: tp.open ? `holding ${tp.fut}` : `buy ${tp.buy ?? "—"} · sell ${tp.sell ?? "—"}`, value: tp.today_net_rs, open: tp.open_net_rs, total: tp.total_net_rs, delta: tp.sold_today_rs, error: tp.error }],
  ].filter(([id]) => shown(id));
  return (
    <View style={{ gap: 16 }}>
      <Hero t={t} />
      <Card style={{ padding: 0, overflow: "hidden" }}>
        {rows.map(([id, r], i) => <Row key={id} first={i === 0} {...r} />)}
      </Card>
      <T size={11} faint>One lot a position. SR and CR each trade on its own prices (spot or futures).</T>
      <Section title="Open positions">
        <OpenPositions query={query} />
      </Section>
      <Section title="Net P&L by day">
        <Card style={{ padding: 12 }}>
          <PaperCurve query={query} />
        </Card>
      </Section>
    </View>
  );
}
