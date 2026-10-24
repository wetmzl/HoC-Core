import { defineConfig } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT ?? "4175";
export default defineConfig({
  testDir: "tests/pwa", timeout: 60_000, expect: { timeout: 20_000 },
  workers: 1, reporter: "line", outputDir: "output/playwright-pwa",
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30_000 }
});
