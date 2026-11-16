import { defineConfig } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT ?? "4173";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: process.env.CI ? 1 : 4,
  outputDir: "output/playwright",
  reporter: "line",
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30_000
  }
});
