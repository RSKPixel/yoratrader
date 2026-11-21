// Where the app gets its data. Prod is the everyday server; dev is the test copy (over Tailscale), used while
// building the app (prod gets the app's login once it is deployed).
export const SERVERS = {
  prod: "https://trader.yoratech.com",
  dev: "http://homeserver.tailfef550.ts.net:3001",
};
export const DEFAULT_SERVER = "dev";
