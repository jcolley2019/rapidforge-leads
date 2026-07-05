import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // Dev-only: same-origin /api calls reach the local worker without
    // CORS. Production uses VITE_WORKER_URL instead (see lib/api.ts).
    proxy: {
      "/api": {
        target: "http://localhost:8788",
        changeOrigin: true,
      },
    },
  },
});
