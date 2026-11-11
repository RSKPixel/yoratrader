import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // listen on all interfaces so Tailscale can reach it
    allowedHosts: ["homeserver", "homeserver.tailfef550.ts.net"],
    port: 3001,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4001",
      "/ws": {
        target: "ws://127.0.0.1:4001",
        ws: true,
      },
    },
  },
});
