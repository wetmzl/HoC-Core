import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "plugins/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    environment: "node",
    coverage: { reporter: ["text"] }
  }
});
