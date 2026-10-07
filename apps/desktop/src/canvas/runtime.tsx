import * as React from "react";
import { icons } from "./icons.ts";
import { createRoot } from "react-dom/client";
import { transform } from "sucrase";
import { parseFiles, loadModules } from "./modules.ts";

const payload = JSON.parse(document.getElementById("canvas-source")!.textContent!);
const report = (error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  parent.postMessage({ type: "gustaf-canvas-error", message: message.slice(0, 4000) }, "*");
  const root = document.getElementById("root")!;
  root.replaceChildren();
  const pre = document.createElement("pre");
  pre.style.cssText = "padding:20px;color:#b42318;white-space:pre-wrap;font:14px/1.5 monospace";
  pre.textContent = message;
  root.append(pre);
};
window.addEventListener("error", (event) => report(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => report(event.reason));

try {
  const parsed = parseFiles(payload.code);
  if (parsed.error) throw new Error(parsed.error);
  const multi = parsed.files.length > 1;
  const compile = (code: string, name: string) => {
    try {
      return transform(code, { transforms: ["typescript", "jsx", "imports"], production: true, jsxRuntime: "classic" })
        .code;
    } catch (error) {
      throw multi ? new Error(`${name}: ${error instanceof Error ? `${error.name}: ${error.message}` : error}`) : error;
    }
  };
  const exported = loadModules(parsed.files, compile, { react: React, ...icons }) as { default?: React.ComponentType };
  if (!exported.default)
    throw new Error(`Export a React component with export default${multi ? ` from ${parsed.files[0].name}` : ""}.`);
  createRoot(document.getElementById("root")!, { onUncaughtError: report }).render(
    React.createElement(exported.default),
  );
} catch (error) {
  report(error);
}
