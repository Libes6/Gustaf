import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Component tests (jsdom + Testing Library). Node unit tests stay on `node --test tests/*.test.mjs`.
export default defineConfig({
  plugins: [react()],
  define: { __SIDECAR__: JSON.stringify("sidecar/cursor-agent.mjs") },
  test: {
    environment: "jsdom",
    include: ["tests/ui/**/*.test.tsx"],
    setupFiles: ["tests/ui/setup.ts"],
    css: false,
    restoreMocks: true,
    clearMocks: true,
  },
});
