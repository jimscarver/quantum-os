import { defineConfig } from "vite";

export default defineConfig({
  base: "/quantum-os/",   // GitHub Pages repo subpath
  build: {
    outDir: "dist",
    target: "es2022",
  },
  optimizeDeps: {
    exclude: ["@quantum-os/zfa-core"],  // WASM module — don't pre-bundle
  },
  server: {
    port: 5173,
  },
});
