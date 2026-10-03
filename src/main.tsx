import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/theme.css";
import { initTheme } from "./lib/theme";
import { currentPlatform } from "./lib/platform";
import { setShortcutPlatform } from "./lib/shortcuts";

initTheme();
// Lets CSS adapt to the OS (title bar layout, see `.window-header` in theme.css) and shortcuts show Ctrl instead of Cmd.
document.documentElement.dataset.os = currentPlatform();
setShortcutPlatform(currentPlatform());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
