import { useState } from "react";
import { KeyboardAvoidingView, Platform, TextInput, View } from "react-native";
import { login, verifyCode } from "../api";
import Logo from "../Logo";
import { useTheme } from "../theme";
import { Button, Card, font, T } from "../ui";

// Sign in as on the site: user ID and password, then the 6-digit code from Google Authenticator.
export default function Login({ onDone }) {
  const c = useTheme();
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = { borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2, color: c.text, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, fontFamily: font(400) };

  const run = (f) => async () => {
    setBusy(true);
    setError("");
    try {
      await f();
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };
  const first = run(async () => {
    const s = await login(user.trim(), password);
    if (s.enroll) throw new Error("Set up Google Authenticator on the site first, then sign in here.");
    setStep(s);
  });
  const second = run(async () => onDone(await verifyCode(step.challenge, code.trim())));

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, justifyContent: "center", padding: 24, backgroundColor: c.bg }}>
      <View style={{ alignItems: "center", marginBottom: 24 }}>
        <Logo width={200} />
      </View>
      <Card style={{ gap: 12 }}>
        {!step ? (
          <>
            <T size={13} muted>User ID</T>
            <TextInput style={input} value={user} onChangeText={setUser} autoCapitalize="none" autoCorrect={false} />
            <T size={13} muted>Password</T>
            <TextInput style={input} value={password} onChangeText={setPassword} secureTextEntry onSubmitEditing={first} />
            <Button title={busy ? "Checking…" : "Continue"} onPress={first} disabled={busy || !user || !password} style={{ marginTop: 4 }} />
          </>
        ) : (
          <>
            <T size={13} muted>The 6-digit code from Google Authenticator</T>
            <TextInput style={[input, { fontSize: 22, letterSpacing: 6, textAlign: "center" }]} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
              keyboardType="number-pad" autoFocus onSubmitEditing={second} />
            <Button title={busy ? "Checking…" : "Sign in"} onPress={second} disabled={busy || code.length !== 6} />
            <Button title="Back" kind="plain" onPress={() => { setStep(null); setCode(""); }} />
          </>
        )}
        {!!error && <T size={13} color={c.negative}>{error}</T>}
      </Card>
    </KeyboardAvoidingView>
  );
}
