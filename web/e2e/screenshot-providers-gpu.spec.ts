import { test } from '@playwright/test';

test('capture Providers GPU Deploy with idle timeout', async ({ page }) => {
  await page.goto('http://localhost:4000/config/profiles');
  await page.waitForTimeout(1500);
  // Scroll down to see Services section
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTop = main.scrollHeight;
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/providers-gpu-idle.png', fullPage: false });
});
