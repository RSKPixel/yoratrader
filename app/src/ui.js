import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import { useSecond } from "./hooks";
import { tint, tone, useTheme } from "./theme";
import { formatRs } from "./format";

// The site's font, IBM Plex Sans (numbers with its even-width digits). Android picks a weight by its file, not by
// fontWeight, so each weight is its own family (loaded in App.js).
export const FONTS = { 400: "IBMPlexSans_400Regular", 500: "IBMPlexSans_500Medium", 600: "IBMPlexSans_600SemiBold", 700: "IBMPlexSans_700Bold" };
export const font = (weight) => FONTS[Number(weight) || 400] || FONTS[weight >= 600 ? 700 : 400];

// Shared pieces: text in the theme's colours, cards, rows, pills, the "sold today" arrow
export function T({ style, muted, faint, color, size = 14, weight, mono, children, ...rest }) {
  const c = useTheme();
  return (
    <Text
      style={[{ color: color || (muted ? c.muted : faint ? c.faint : c.text), fontSize: size, fontFamily: font(weight), fontVariant: mono ? ["tabular-nums"] : undefined }, style]}
      {...rest}
    >
      {children}
    </Text>
  );
}

export function Card({ style, children, border, onPress }) {
  const c = useTheme();
  const s = [{ backgroundColor: c.surface, borderColor: border || c.border, borderWidth: 1, borderRadius: 12, padding: 16 }, style];
  if (onPress)
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [...s, pressed && { backgroundColor: c.surface2 }]}>
        {children}
      </Pressable>
    );
  return <View style={s}>{children}</View>;
}

export function Divider({ style }) {
  const c = useTheme();
  return <View style={[{ height: StyleSheet.hairlineWidth * 2, backgroundColor: c.border }, style]} />;
}

export function Section({ title, children }) {
  return (
    <View style={{ gap: 8 }}>
      <T size={14} weight="600">{title}</T>
      {children}
    </View>
  );
}

export function Pill({ color, children }) {
  return (
    <View style={{ backgroundColor: tint(color, 0.14), borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
      <T size={10} weight="700" color={color} style={{ letterSpacing: 0.8, textTransform: "uppercase" }}>{children}</T>
    </View>
  );
}

export function Dot({ color, size = 8 }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

// realized net's move since yesterday: the trades sold today
export function Delta({ v, size = 12 }) {
  const c = useTheme();
  if (v == null) return null;
  const up = v > 0, down = v < 0;
  return (
    <T size={size} mono color={up ? c.positive : down ? c.negative : c.faint}>
      {up ? "▲ " : down ? "▼ " : "• "}
      {up || down ? `${formatRs(Math.abs(v))} today` : "no change today"}
    </T>
  );
}

// a label and its value on one line
export function Line({ label, value, color, style }) {
  return (
    <View style={[{ flexDirection: "row", justifyContent: "space-between", gap: 12 }, style]}>
      <T size={12} muted>{label}</T>
      <T size={12} mono color={color} numberOfLines={1} style={{ flexShrink: 1, textAlign: "right" }}>{value}</T>
    </View>
  );
}

export function Button({ title, onPress, disabled, kind = "primary", style, icon: Icon }) {
  const c = useTheme();
  const primary = kind === "primary";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        { borderRadius: 8, paddingVertical: 12, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 6, borderWidth: 1,
          backgroundColor: primary ? c.accent : "transparent", borderColor: primary ? c.accent : c.border, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {Icon && <Icon size={16} strokeWidth={1.8} color={primary ? c.accentInk : kind === "danger" ? c.negative : c.text} />}
      <T size={14} weight="600" color={primary ? c.accentInk : kind === "danger" ? c.negative : c.text}>{title}</T>
    </Pressable>
  );
}

// two or more choices side by side (the site's Segmented)
export function Segmented({ options, value, onChange }) {
  const c = useTheme();
  return (
    <View style={{ flexDirection: "row", borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2, borderRadius: 8, padding: 2 }}>
      {options.map(([v, label]) => {
        const on = v === value;
        return (
          <Pressable key={v} onPress={() => onChange(v)} style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6, backgroundColor: on ? c.surface : "transparent" }}>
            <T size={13} weight={on ? "600" : "400"} color={on ? c.text : c.muted}>{label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

// "Refresh now · 42s": loads the data at once; the seconds to the next automatic refresh, on the clock's tick
// compact (the header): just the arrow (the automatic refresh still counts down behind it)
export function RefreshButton({ onPress, loading, at, style, compact = false }) {
  const c = useTheme();
  const now = useSecond();
  const left = at ? Math.max(0, Math.ceil((at - Math.floor(now / 1000) * 1000) / 1000)) : null;
  return (
    <Pressable onPress={onPress} disabled={loading}
      hitSlop={8} accessibilityLabel="Refresh now"
      style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: tint(c.accent, 0.14), borderRadius: 999,
        ...(compact ? { width: 36, height: 36 } : { paddingHorizontal: 12, paddingVertical: 6 }), opacity: pressed ? 0.7 : 1 }, style]}>
      {loading ? <ActivityIndicator size="small" color={c.accent} /> : compact && (
        <RefreshCw size={16} color={c.accent} strokeWidth={2.2} />
      )}
      {!compact && <T size={12} weight="500" mono color={c.accent}>{loading ? "Refreshing…" : `Refresh now${left != null ? ` · ${left}s` : ""}`}</T>}
    </Pressable>
  );
}

export { tone };
