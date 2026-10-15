import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// `webdoctor ui --token dev` serves the API on :7777; open http://localhost:5173/?token=dev
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:7777" } },
  build: { outDir: "dist", sourcemap: false },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    css: false,
  },
});
