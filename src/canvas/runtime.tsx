import * as React from "react";
import { createRoot } from "react-dom/client";
import { transform } from "sucrase";

const payload = JSON.parse(document.getElementById("canvas-source")!.textContent!);
const report = (error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  parent.postMessage({ type: "mcode-canvas-error", message: message.slice(0, 4000) }, "*");
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
  const output = transform(payload.code, { transforms: ["typescript", "jsx", "imports"], production: true, jsxRuntime: "classic" }).code;
  const module = { exports: {} as { default?: React.ComponentType } };
  const require = (name: string) => {
    if (name === "react") return React;
    throw new Error(`Unsupported import: ${name}. Only react is available.`);
  };
  new Function("require", "module", "exports", "React", output)(require, module, module.exports, React);
  if (!module.exports.default) throw new Error("Export a React component with export default.");
  createRoot(document.getElementById("root")!, { onUncaughtError: report }).render(React.createElement(module.exports.default));
} catch (error) { report(error); }
