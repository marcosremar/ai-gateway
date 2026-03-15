import { test, expect } from '@playwright/test';
test('capture GPU Deploy page with auto-stop', async ({ page }) => {
  await page.goto('http://localhost:4000/gpu');
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const m = document.querySelector('main'); if (m) m.scrollTop = 500; });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/gpu-deploy-autostop.png', fullPage: false });
});
