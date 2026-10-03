import { useColorScheme } from "react-native";
import { useStore } from "../state/store.ts";

/** Tokens follow the desktop's `styles/theme.css` (same accent #a884ee); the light values are chosen for the phone. */
export interface Tokens {
  bg: string;
  bgElev: string;
  bgInput: string;
  border: string;
  text: string;
  text2: string;
  text3: string;
  accent: string;
  onAccent: string;
  bubble: string;
  bubbleFg: string;
  green: string;
  red: string;
  warn: string;
}

export const dark: Tokens = {
  bg: "#181818",
  bgElev: "#262626",
  bgInput: "#2a2a2a",
  border: "#2f2f2f",
  text: "#e6e6e6",
  text2: "#b3b3b3",
  text3: "#959595",
  accent: "#a884ee",
  onAccent: "#1b1b1b",
  bubble: "#5c4485",
  bubbleFg: "#ffffff",
  green: "#4ec27a",
  red: "#ef6b6b",
  warn: "#e9a23b",
};

export const light: Tokens = {
  bg: "#ffffff",
  bgElev: "#f4f4f6",
  bgInput: "#eeeef1",
  border: "#e0e0e4",
  text: "#1b1b1b",
  text2: "#555560",
  text3: "#7a7a85",
  accent: "#7a52d1",
  onAccent: "#ffffff",
  bubble: "#7a52d1",
  bubbleFg: "#ffffff",
  green: "#2f9e5b",
  red: "#d64545",
  warn: "#b97a12",
};

export const radius = 12;

export function useTheme(): Tokens & { scheme: "light" | "dark" } {
  const mode = useStore((s) => s.prefs.theme);
  const system = useColorScheme();
  const scheme = mode === "system" ? (system === "light" ? "light" : "dark") : mode;
  return { ...(scheme === "light" ? light : dark), scheme };
}
