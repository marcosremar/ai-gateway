import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3099',
    headless: true,
    screenshot: 'only-on-failure',
  },
  webServer: [
    // Mock gateway API on port 4099
    {
      command: 'bun run e2e/mock-gateway.ts',
      port: 4099,
      reuseExistingServer: false,
    },
    // Next.js dev server on port 3099
    {
      command: 'NEXT_PUBLIC_GATEWAY_URL=http://localhost:4099 bun run next dev -p 3099',
      port: 3099,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
