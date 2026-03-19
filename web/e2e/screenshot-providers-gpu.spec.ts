import { test, expect } from '@playwright/test';

test('capture Providers GPU Deploy with idle timeout', async ({ page }) => {
  await page.goto('http://localhost:4000/config/profiles');
  await page.waitForTimeout(1500);
  // Click on "GPU Deploy" mode toggle within Providers page
  const toggle = page.locator('button').filter({ hasText: 'GPU Deploy' }).last();
  await toggle.click();
  await page.waitForTimeout(1000);
  // Scroll down to see GPU Hardware + idle timeout
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTop = main.scrollHeight;
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/providers-gpu-idle.png', fullPage: false });
});
