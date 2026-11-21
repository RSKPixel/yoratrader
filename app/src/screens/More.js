import ExternalLink from "lucide-react-native/icons/external-link";
import LogOut from "lucide-react-native/icons/log-out";
import { Linking, View } from "react-native";
import { base, serverName } from "../api";
import { useTheme } from "../theme";
import { Button, Card, Divider, Dot, RefreshButton, Segmented, T } from "../ui";

// The last tab: who is signed in, sign out, the market / Kite / refresh, theme, keep the screen on, the schedules, the server
const STATE = { done: ["Done", "positive"], pending: ["Later", "faint"], running: ["Due now", "warning"], late: ["Missed", "negative"], off: ["No session", "faint"] };

function StatusCard({ d, nextAt, onRefresh, loading }) {
  const c = useTheme();
  const market = d.market_open ? ["Market open", c.positive] : d.preopen ? ["Pre-open", c.warning] : ["Closed", c.faint];
  const kite = d.kite?.connected;
  const row = (label, right, first) => (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 10, borderTopWidth: first ? 0 : 1, borderTopColor: c.border }}>
      <T size={14} muted>{label}</T>
      {right}
    </View>
  );
  return (
    <Card style={{ paddingVertical: 6 }}>
      {row("Market", <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><Dot color={market[1]} /><T size={14} weight="500" color={market[1]}>{market[0]}</T></View>, true)}
      {row("Kite", <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><Dot color={kite ? c.positive : c.negative} /><T size={14} weight="500" color={kite ? c.positive : c.negative}>{kite ? "Connected" : "Not connected"}</T></View>)}
      {row("Next refresh", (
        <RefreshButton onPress={onRefresh} loading={loading} at={nextAt} />
      ))}
    </Card>
  );
}

function Schedules({ d }) {
  const c = useTheme();
  const next = d.schedule.find((s) => s.state === "running") || d.schedule.find((s) => s.state === "pending");
  const f = d.freshness || {};
  const data = [["Backtest · daily", f.backtest_daily], ["Backtest · index daily", f.backtest_index_daily], ["Backtest · 15 min", f.backtest_15m],
    ["Live futures · daily", f.live_daily], ["Live futures · 15 min", f.live_15m]];
  return (
    <View style={{ gap: 12 }}>
      {next && (
        <Card>
          <T size={12} muted>{next.state === "running" ? "Due now" : "Next up"}</T>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 12, marginTop: 4 }}>
            <T size={24} weight="600" mono>{next.at}</T>
            <T size={14} weight="500" style={{ flexShrink: 1 }}>{next.label}</T>
          </View>
        </Card>
      )}
      <Card style={{ paddingVertical: 4 }}>
        {d.schedule.map((s, i) => {
          const [label, key] = STATE[s.state] || STATE.pending;
          return (
            <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, borderTopWidth: i ? 1 : 0, borderTopColor: c.border }}>
              <T size={12} muted mono style={{ width: 42 }}>{s.at}</T>
              <Dot color={c[key]} />
              <T size={14} style={{ flex: 1 }}>{s.label}{s.detail ? <T size={12} muted>{`  ${s.detail}`}</T> : null}</T>
              <T size={12} weight="500" color={c[key]}>{label}</T>
            </View>
          );
        })}
      </Card>
      <Card style={{ padding: 0 }}>
        <T size={12} weight="600" style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>Data</T>
        {data.map(([label, day]) => {
          const stale = !day || day < d.expected_data;
          return (
            <View key={label} style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.border }}>
              <T size={14}>{label}</T>
              <T size={12} weight="500" mono color={stale ? c.warning : c.positive}>{day || "—"}</T>
            </View>
          );
        })}
      </Card>
    </View>
  );
}

export default function More({ user, onLogout, theme, onTheme, keepAwake, onKeepAwake, d, nextAt, onRefresh, loading }) {
  const c = useTheme();
  return (
    <View style={{ gap: 16 }}>
      <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <T size={12} muted>Logged in as</T>
          <T size={16} weight="600" numberOfLines={1}>{user?.display_name || user?.username}</T>
        </View>
        <Button title="Log out" icon={LogOut} kind="danger" onPress={onLogout} style={{ paddingHorizontal: 14, paddingVertical: 8 }} />
      </Card>
      {d && <StatusCard d={d} nextAt={nextAt} onRefresh={onRefresh} loading={loading} />}
      <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <T size={14} weight="500">Theme</T>
        <Segmented options={[["light", "Light"], ["dark", "Dark"]]} value={theme} onChange={onTheme} />
      </Card>
      <Card style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <T size={14} weight="500">Keep screen on</T>
          <Segmented options={[["on", "On"], ["off", "Off"]]} value={keepAwake ? "on" : "off"} onChange={(v) => onKeepAwake(v === "on")} />
        </View>
        <T size={12} muted>{keepAwake ? "The screen stays on while the app is open." : "The phone sleeps as usual."}</T>
      </Card>
      {d && (
        <View style={{ gap: 8 }}>
          <T size={12} weight="600" faint style={{ letterSpacing: 1.4, textTransform: "uppercase", paddingHorizontal: 4 }}>Schedules</T>
          <Schedules d={d} />
        </View>
      )}
      <Card style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <T size={14} weight="500">Server</T>
          <T size={14} weight="600" style={{ color: serverName() === "prod" ? undefined : "#F59E0B" }}>{serverName() === "prod" ? "Prod" : "Dev"}</T>
        </View>
        <T size={12} muted numberOfLines={1}>{base()} · {serverName() === "prod" ? "the installed app" : "Expo Go"}</T>
      </Card>
      <Divider />
      <Button title="Full site" icon={ExternalLink} kind="plain" onPress={() => Linking.openURL(`${base()}/v2/dashboard`)} />
    </View>
  );
}
