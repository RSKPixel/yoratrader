import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import AppV2 from "./AppV2.jsx";
import AuthGate from "./AuthGate.jsx";
import V2KiteCallback from "./V2KiteCallback.jsx";
import "./index.css";

// v2 is the default; the classic app stays at /classic for the pages not moved yet. /kite is where
// Kite's login sends you back (the app's redirect URL) with the day's request token.
const path = window.location.pathname;
const classic = path === "/classic" || path.startsWith("/classic/");
const kite = path === "/kite" || path.startsWith("/kite/");

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AuthGate>{kite ? <V2KiteCallback /> : classic ? <App /> : <AppV2 />}</AuthGate>
  </StrictMode>
);
