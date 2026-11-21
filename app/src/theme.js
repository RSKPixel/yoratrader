import { createContext, useContext } from "react";

// The site's colours (frontend/src/index.css), dark and light
export const THEMES = {
  dark: {
    bg: "#0a0e13", surface: "#111821", surface2: "#17202b", border: "#223041", text: "#e6edf3", muted: "#8a98a9", faint: "#5b6878",
    accent: "#2dd4bf", accentInk: "#04201c", accentSoft: "rgba(45,212,191,0.12)", positive: "#34d399", negative: "#f87171", warning: "#fbbf24",
    logoAccent: "#60A5FA", statusBar: "light",
  },
  light: {
    bg: "#f5f7fa", surface: "#ffffff", surface2: "#eef2f6", border: "#dde3ea", text: "#0f1720", muted: "#566273", faint: "#8794a4",
    accent: "#0f766e", accentInk: "#ffffff", accentSoft: "rgba(15,118,110,0.1)", positive: "#047857", negative: "#b91c1c", warning: "#b45309",
    logoAccent: "#3B7BFF", statusBar: "dark",
  },
};

export const ThemeContext = createContext(THEMES.dark);
export const useTheme = () => useContext(ThemeContext);

// a value's colour: green up, red down, muted for none / zero
export const tone = (c, v) => (v == null || v === 0 ? c.muted : v > 0 ? c.positive : c.negative);

// a colour at a given opacity (for the pills' tinted backgrounds)
export function tint(hex, alpha) {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
