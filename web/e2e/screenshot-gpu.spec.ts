import { test, expect } from '@playwright/test';

test('capture GPU Deploy config', async ({ page }) => {
  await page.goto('http://localhost:4000/providers');
  await page.waitForTimeout(1000);
  // Click GPU Deploy tab
  const gpuTab = page.locator('button').filter({ hasText: /^GPU Deploy/ }).first();
  if (await gpuTab.isVisible()) {
    await gpuTab.click();
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: '/tmp/gpu-idle-timeout.png', fullPage: true });
});
