import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // RFL.FIX.3a: strip real keys/toggles from the shell before any test file loads.
    setupFiles: ["./src/test-setup.ts"],
  },
});
