import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    watch: false,
    environment: "node",
    testTimeout: 1000,
    exclude: ["node_modules"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov", "json-summary", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**"],
      exclude: ["src/types/**"],
    },
  },
});
