import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // index.html must stay free of inline scripts: the image serves it under a strict CSP.
    modulePreload: { polyfill: false },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
