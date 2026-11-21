import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { base } from "./api";
import { istNow } from "./format";
import { useSecond } from "./hooks";
import Logo from "./Logo";
import { useTheme } from "./theme";
import { RefreshButton, T } from "./ui";

// Every screen's header: the logo as wide as the India time and date under it; Kite Login when Kite is off
export default function Header({ d, onHome, scrolled, onRefresh, loading, nextAt }) {
  const c = useTheme();
  const now = useSecond();
  const kite = d?.kite?.connected;
  const [w, setW] = useState(168); // the time and date line's width: the logo matches it
  return (
    <View style={{ backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8, gap: 10,
      elevation: scrolled ? 8 : 0, shadowColor: "#000", shadowOpacity: scrolled ? 0.4 : 0, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, zIndex: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Pressable onPress={onHome} style={{ gap: 1 }} accessibilityLabel="YoraTrader home">
          <Logo width={w} />
          <T size={12} muted mono onLayout={(e) => setW(Math.round(e.nativeEvent.layout.width))}>{istNow(now)}</T>
        </Pressable>
        {d && <RefreshButton compact onPress={onRefresh} loading={loading} at={nextAt} />}
      </View>
      {d && !kite && (
        <Pressable onPress={() => Linking.openURL(`${base()}/api/kite/login`)} style={({ pressed }) => ({ backgroundColor: c.accent, borderRadius: 8, paddingVertical: 10, alignItems: "center", opacity: pressed ? 0.8 : 1 })}>
          <T size={14} weight="600" color={c.accentInk}>Kite Login</T>
        </Pressable>
      )}
    </View>
  );
}
