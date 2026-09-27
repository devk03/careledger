import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL("./public-shell/", import.meta.url)),
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL("./dist-public-shell/", import.meta.url)),
    emptyOutDir: false,
    manifest: true,
    sourcemap: false,
  },
});
