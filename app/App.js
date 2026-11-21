import { StatusBar } from "expo-status-bar";
import { useKeepAwake } from "expo-keep-awake";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, useColorScheme, View } from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import BookOpen from "lucide-react-native/icons/book-open";
import Hand from "lucide-react-native/icons/hand";
import Menu from "lucide-react-native/icons/menu";
import Zap from "lucide-react-native/icons/zap";
import { api, logout, restore, setServer, whenLoggedOut } from "./src/api";
import { AlertsScreen, markSeen } from "./src/Alerts";
import Header from "./src/Header";
import { usePoll, useSetting } from "./src/hooks";
import Live from "./src/screens/Live";
import Login from "./src/screens/Login";
import Manual from "./src/screens/Manual";
import More from "./src/screens/More";
import Paper from "./src/screens/Paper";
import { THEMES, ThemeContext } from "./src/theme";
import { T } from "./src/ui";
import { IBMPlexSans_400Regular, IBMPlexSans_500Medium, IBMPlexSans_600SemiBold, IBMPlexSans_700Bold, useFonts } from "@expo-google-fonts/ibm-plex-sans";

// YoraTrader on Android: the phone version of the site as a native app. Tabs at the bottom (Paper, Live trading,
// Manual, More), the header (logo, India time) on top; the data reloads each minute in market hours.
const TABS = [
  { id: "home", label: "Paper", Icon: BookOpen },
  { id: "live", label: "Live trading", Icon: Zap },
  { id: "manual", label: "Manual", Icon: Hand },
  { id: "more", label: "More", Icon: Menu },
];

function KeepAwake() {
  useKeepAwake();
  return null;
}

function Main({ user, onLogout, onServer }) {
  const system = useColorScheme() === "light" ? "light" : "dark";
  const [theme, setTheme, values] = useSetting("theme", system);
  const [keepAwake, setKeepAwake] = useSetting("mobile_keep_awake", true);
  const c = THEMES[theme] || THEMES.dark;
  const [tab, setTab] = useState("home");
  const [scrolled, setScrolled] = useState(false);
  const insets = useSafeAreaInsets();
  // the paper pages' max open (the site's settings), so the numbers match the site's
  const max = (id, dflt) => values[`params.paper-${id}`]?.maxOpen || dflt;
  const query = `gap_max_open=${max("buy-on-gap", 5)}&xsmr_max_open=${max("xs-mean-reversion", 10)}`;
  const [d, error, reload, loading, nextAt] = usePoll(`/api/v2/dashboard?${query}`, (p) => (p.market_open || p.preopen ? 60000 : 300000));
  const [st] = usePoll("/api/v2/models/status", 300000);
  const [alerts, , reloadAlerts] = usePoll("/api/v2/alerts", 60000); // the bell: live orders and problems, the morning check, the summary
  const [alertsOpen, setAlertsOpen] = useState(false);
  const openAlerts = () => {
    setAlertsOpen(true);
    markSeen().then(reloadAlerts);
  };
  const statuses = st?.statuses || {};

  let screen;
  if (!d) screen = error ? <T color={c.negative}>{error}</T> : <ActivityIndicator color={c.accent} style={{ marginTop: 40 }} />;
  else if (tab === "live") screen = <Live />;
  else if (tab === "manual") screen = <Manual tm={d.paper?.tom} />;
  else if (tab === "more") screen = null;
  else screen = <Paper d={d} statuses={statuses} query={query} />;
  if (tab === "more")
    screen = <More user={user} onLogout={onLogout} theme={theme} onTheme={setTheme} keepAwake={keepAwake} onKeepAwake={setKeepAwake}
      d={d} nextAt={nextAt} onRefresh={reload} loading={loading} onServer={onServer} />;

  return (
    <ThemeContext.Provider value={c}>
      {keepAwake && <KeepAwake />}
      <StatusBar style={c.statusBar} backgroundColor={c.surface} />
      <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: c.surface }}>
        <Header d={d} scrolled={scrolled} onHome={() => setTab("home")} onRefresh={() => { reload(); reloadAlerts(); }} loading={loading} nextAt={nextAt} alerts={alerts} onAlerts={openAlerts} />
        {alertsOpen && <AlertsScreen data={alerts} onClose={() => setAlertsOpen(false)} onReload={reloadAlerts} />}
        <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, paddingBottom: 24, gap: 8 }}
          onScroll={(e) => setScrolled(e.nativeEvent.contentOffset.y > 2)} scrollEventThrottle={32}>
          {!!error && d && <T size={12} color={c.warning}>{error} · showing the last data</T>}
          {screen}
        </ScrollView>
        <View style={{ flexDirection: "row", backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.border, paddingBottom: insets.bottom }}>
          {TABS.map((t) => {
            const on = tab === t.id;
            const color = on ? c.accent : c.muted;
            return (
              <Pressable key={t.id} onPress={() => setTab(t.id)} style={{ flex: 1, alignItems: "center", gap: 4, paddingVertical: 10 }} accessibilityRole="tab" accessibilityState={{ selected: on }}>
                <t.Icon size={20} color={color} strokeWidth={1.8} />
                <T size={11} weight="500" color={color}>{t.label}</T>
              </Pressable>
            );
          })}
        </View>
      </SafeAreaView>
    </ThemeContext.Provider>
  );
}

function Root() {
  const [state, setState] = useState("loading"); // loading | login | in
  const [user, setUser] = useState(null);
  useEffect(() => {
    whenLoggedOut(() => setState("login"));
    restore().then(async (has) => {
      if (!has) return setState("login");
      try {
        const me = await api("/api/auth/me");
        setUser(me.user || me);
        setState("in");
      } catch {
        setState("login");
      }
    });
  }, []);
  const c = THEMES.dark;
  if (state === "loading")
    return <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: "center" }}><ActivityIndicator color={c.accent} /></View>;
  if (state === "login")
    return (
      <ThemeContext.Provider value={c}>
        <StatusBar style="light" />
        <Login onDone={(u) => { setUser(u); setState("in"); }} />
      </ThemeContext.Provider>
    );
  return (
    <Main user={user} onLogout={async () => { await logout(); setState("login"); }}
      onServer={async (name) => { await setServer(name); setState("login"); }} />
  );
}

export default function App() {
  // the site's font; the app waits for it (a moment, the first time) so nothing shows in the phone's own font first
  const [fontsReady] = useFonts({ IBMPlexSans_400Regular, IBMPlexSans_500Medium, IBMPlexSans_600SemiBold, IBMPlexSans_700Bold });
  if (!fontsReady) return <View style={{ flex: 1, backgroundColor: THEMES.dark.bg }} />;
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}
