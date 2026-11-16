import { defineConfig } from '@playwright/test';

// Local desktop checks only. No browser/desktop E2E is dispatched to CI.
export default defineConfig({
  testDir: 'tests/desktop', timeout: 120_000, workers: 1,
  outputDir: 'output/playwright-electron', reporter: 'line',
  expect: { timeout: 30_000 }
});
