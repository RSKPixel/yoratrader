// Where the app gets its data, fixed by how it runs: in Expo Go (a development run) always the dev copy (over
// Tailscale); the installed APK (a release build) always prod.
export const SERVERS = {
  prod: "https://trader.yoratech.com",
  dev: "http://homeserver.tailfef550.ts.net:3001",
};
export const SERVER = __DEV__ ? "dev" : "prod";
