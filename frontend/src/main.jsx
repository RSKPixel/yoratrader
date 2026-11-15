import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import AppV2 from "./AppV2.jsx";
import AuthGate from "./AuthGate.jsx";
import "./index.css";

// v2 is the default; the classic app stays at /classic for the pages not moved yet.
const classic = window.location.pathname === "/classic" || window.location.pathname.startsWith("/classic/");

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AuthGate>{classic ? <App /> : <AppV2 />}</AuthGate>
  </StrictMode>
);
