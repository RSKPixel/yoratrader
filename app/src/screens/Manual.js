import { View } from "react-native";
import { formatRs, shortDay } from "../format";
import { useTheme } from "../theme";
import { Card, Line, T } from "../ui";

// Manual trading: the turn of the month (ITM call) traded by hand: its dates and the call to buy
export default function Manual({ tm = {} }) {
  const c = useTheme();
  const lines = [
    ["Now", tm.state === "waiting" ? `waiting · ${tm.days_to_buy} trading days to the buy` : tm.state ?? "—", tm.state && tm.state !== "waiting" ? c.warning : undefined],
    ["Buy · sell (close)", `${shortDay(tm.buy)} · ${shortDay(tm.sell)}`],
    [tm.call_label || "Call to buy", tm.strike ? `NIFTY ${tm.strike} CE · ${shortDay(tm.expiry)}` : tm.call_label?.startsWith("Call held") ? "buy day's close not stored yet" : "—"],
    ...(tm.best ? [["Limit price", `₹${tm.best.limit}`, tm.state?.startsWith("buy") ? c.warning : undefined], ["Per lot", formatRs(tm.best.per_lot)]] : []),
  ];
  return (
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <T size={14} weight="600">Turn of the month (ITM)</T>
        <T size={10} weight="600" muted style={{ letterSpacing: 0.8, textTransform: "uppercase" }}>Positional</T>
      </View>
      {tm.error ? (
        <T size={12} color={c.negative}>{tm.error}</T>
      ) : (
        <View style={{ gap: 6 }}>
          {lines.map(([k, v, color]) => <Line key={k} label={k} value={v} color={color} />)}
        </View>
      )}
    </Card>
  );
}
