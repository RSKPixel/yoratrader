import * as SecureStore from "expo-secure-store";
import { DEFAULT_SERVER, SERVERS } from "./config";

// The server's API, with the session token (kept in the phone's secure storage) as "Authorization: Bearer".
let token = null;
let server = DEFAULT_SERVER;
let onLoggedOut = () => {};

export const base = () => SERVERS[server];
export const serverName = () => server;

export async function restore() {
  token = await SecureStore.getItemAsync("token");
  server = (await SecureStore.getItemAsync("server")) || DEFAULT_SERVER;
  return !!token;
}
export async function setServer(name) {
  server = name;
  await SecureStore.setItemAsync("server", name);
  await setToken(null);
}
async function setToken(t) {
  token = t;
  if (t) await SecureStore.setItemAsync("token", t);
  else await SecureStore.deleteItemAsync("token");
}
export const whenLoggedOut = (f) => (onLoggedOut = f);

export async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(base() + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && token && !path.startsWith("/api/auth/")) {
    await setToken(null);
    onLoggedOut();
  }
  if (!r.ok) throw new Error(data.detail || data.message || `Request failed (${r.status})`);
  return data;
}

// the two login steps (password, then the authenticator code), as on the site
export const login = (username, password) => api("/api/auth/login", { method: "POST", body: { username, password } });
export async function verifyCode(challenge, code) {
  const r = await api("/api/auth/totp", { method: "POST", body: { challenge, code, app: true } });
  await setToken(r.token);
  return r.user;
}
export async function logout() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  await setToken(null);
}
