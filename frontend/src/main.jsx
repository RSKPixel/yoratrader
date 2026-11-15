import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import AppV2 from "./AppV2.jsx";
import AuthGate from "./AuthGate.jsx";
import "./index.css";

// v2 is being built at /v2 alongside the classic app at "/"; pages move over one by one.
const v2 = window.location.pathname === "/v2" || window.location.pathname.startsWith("/v2/");

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AuthGate>{v2 ? <AppV2 /> : <App />}</AuthGate>
  </StrictMode>
);
