import { test, expect } from '@playwright/test';

test('capture overview with all latency data', async ({ page }) => {
  await page.goto('http://localhost:4000/');
  await expect(page.getByText('Online')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(2000); // wait for latency data to load
  await page.screenshot({ path: '/tmp/overview-all-stages.png', fullPage: true });
});
