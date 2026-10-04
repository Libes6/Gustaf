// Entry of the quick-ask window (quick-ask.html): shared theme, i18n and providers, but not the app shell.
import React from "react";
import ReactDOM from "react-dom/client";
import "../styles/theme.css";
import { initTheme } from "../lib/theme";
import { currentPlatform } from "../lib/platform";
import { setShortcutPlatform } from "../lib/shortcuts";
import { QuickAskRoot } from "./QuickAsk";

initTheme();
document.documentElement.dataset.os = currentPlatform();
setShortcutPlatform(currentPlatform());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QuickAskRoot />
  </React.StrictMode>,
);
