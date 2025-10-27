import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    testTimeout: 1000,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov", "json-summary", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**"],
      exclude: ["src/types/**"],
    },
  },
});
