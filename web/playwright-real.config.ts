import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:4000',
    headless: true,
    screenshot: 'on',
  },
  // No webServer — tests run against the real gateway already running on :4000
});
