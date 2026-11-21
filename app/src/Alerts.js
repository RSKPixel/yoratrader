import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Bell from "lucide-react-native/icons/bell";
import CircleAlert from "lucide-react-native/icons/circle-alert";
import CircleCheck from "lucide-react-native/icons/circle-check";
import Info from "lucide-react-native/icons/info";
import ShoppingCart from "lucide-react-native/icons/shopping-cart";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";
import { api } from "./api";
import { tint, useTheme } from "./theme";
import { T } from "./ui";

// In-app alerts (as the site's): live orders and problems, the 08:45 morning check, the 15:35 daily summary.
const LEVEL = { error: ["negative", CircleAlert], warn: ["warning", TriangleAlert], ok: ["positive", CircleCheck], order: ["accent", ShoppingCart], info: ["muted", Info] };
export const markSeen = () => api("/api/v2/alerts/seen", { method: "POST" }).catch(() => {});

export function AlertsBell({ data, onPress }) {
  const c = useTheme();
  const unread = data?.unread || 0;
  const bad = (data?.unread_problems || 0) > 0;
  const color = bad ? c.negative : c.muted;
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityLabel={unread ? `Alerts: ${unread} new` : "Alerts"}
      style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 999, alignItems: "center", justifyContent: "center", backgroundColor: bad ? tint(c.negative, 0.14) : c.surface2, opacity: pressed ? 0.7 : 1 })}>
      <Bell size={17} color={color} strokeWidth={1.9} />
      {unread > 0 && (
        <View style={{ position: "absolute", top: -3, right: -3, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 3, alignItems: "center", justifyContent: "center",
          backgroundColor: bad ? c.negative : c.accent }}>
          <T size={10} weight="600" mono color={bad ? "#fff" : c.accentInk}>{unread > 99 ? "99+" : unread}</T>
        </View>
      )}
    </Pressable>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const parts = (iso) => ({ day: `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`, t: iso.slice(11, 16) }); // the server sends India time

export function AlertsScreen({ data, onClose, onReload }) {
  const c = useTheme();
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    await api("/api/v2/alerts/check?kind=morning", { method: "POST" }).catch(() => {});
    await markSeen();
    setBusy(false);
    onReload?.();
  };
  const insets = useSafeAreaInsets();
  let lastDay = null;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, backgroundColor: c.surface,
          borderBottomWidth: 1, borderBottomColor: c.border }}>
          <T size={16} weight="600">Alerts</T>
          <Pressable onPress={onClose} hitSlop={8}><T size={14} weight="600" color={c.accent}>Done</T></Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 16 + insets.bottom }}>
          <Pressable onPress={check} disabled={busy} style={({ pressed }) => ({ alignSelf: "flex-start", borderWidth: 1, borderColor: c.border, borderRadius: 8,
            paddingHorizontal: 12, paddingVertical: 7, marginBottom: 12, opacity: busy ? 0.5 : pressed ? 0.7 : 1 })}>
            <T size={12} weight="500" color={c.accent}>{busy ? "Checking…" : "Run morning check now"}</T>
          </Pressable>
          {!data ? <T size={13} muted>Loading…</T> : !data.alerts.length ? (
            <T size={13} muted>No alerts yet. Live orders and problems show here as they happen, the morning check at 08:45 and the day's summary at 15:35 (trading days).</T>
          ) : data.alerts.map((a) => {
            const { day, t } = parts(a.at);
            const head = day !== lastDay;
            lastDay = day;
            const [key, Icon] = LEVEL[a.level] || LEVEL.info;
            return (
              <View key={a.id}>
                {head && <T size={11} weight="600" faint style={{ letterSpacing: 1.2, textTransform: "uppercase", paddingTop: 12, paddingBottom: 4 }}>{day}</T>}
                <View style={{ flexDirection: "row", gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
                  <View style={{ paddingTop: 2 }}><Icon size={16} color={c[key]} strokeWidth={2} /></View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                      <T size={14} weight="500" color={a.level === "error" ? c.negative : c.text} style={{ flexShrink: 1 }}>
                        {a.title}{a.unread ? <T size={14} color={c.accent}>  •</T> : null}
                      </T>
                      <T size={12} faint mono>{t}</T>
                    </View>
                    {a.lines.map(([lvl, text], i) => (
                      <T key={i} size={12} color={lvl === "error" ? c.negative : lvl === "warn" ? c.warning : c.muted}>
                        {a.kind === "order" ? "" : lvl === "ok" ? "✓ " : lvl === "error" ? "✗ " : "• "}{text}
                      </T>
                    ))}
                  </View>
                </View>
              </View>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}
