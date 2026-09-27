import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { uiPreview } from "./uiPreview";

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "ui-preview" ? [uiPreview()] : [])],
  server: {
    port: 5173,
    proxy: mode === "ui-preview" ? undefined : {
      "/api": "http://localhost:8080",
      "/health": "http://localhost:8080",
    },
  },
  test: {
    environment: "jsdom",
    exclude: ["e2e/**", "e2e-public-shell/**", "node_modules/**", "dist/**"],
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
}));
