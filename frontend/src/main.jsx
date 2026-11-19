import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AppV2 from "./AppV2.jsx";
import AuthGate from "./AuthGate.jsx";
import V2KiteCallback from "./V2KiteCallback.jsx";
import MobileApp from "./mobile/MobileApp.jsx";
import "./index.css";

// /kite is where Kite's login sends you back (the app's redirect URL) with the day's request token.
const path = window.location.pathname;
const kite = path === "/kite" || path.startsWith("/kite/");
// /mobile: the phone app (src/mobile/). A phone opening the site's home is sent there; /v2/... stays the full site.
if (path === "/" && window.matchMedia?.("(max-width: 767px)").matches) window.history.replaceState(null, "", "/mobile");
const mobile = window.location.pathname === "/mobile" || window.location.pathname.startsWith("/mobile/");

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AuthGate>{kite ? <V2KiteCallback /> : mobile ? <MobileApp /> : <AppV2 />}</AuthGate>
  </StrictMode>
);
