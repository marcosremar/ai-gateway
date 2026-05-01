/**
 * Lightning AI - Navigate to running studio, click SSH, read modal.
 */

import { chromium, type Browser, type Cookie } from 'playwright';

const SESSION_COOKIES: Cookie[] = [
  { name: 'visitor-id', value: 'f2555a11-41ce-461f-81e9-36fb535da402', domain: 'lightning.ai', path: '/', httpOnly: true, secure: true, session: false, expires: 1806419967.919146 },
  { name: 'lightning_id_token', value: 'eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJhdWQiOlsiZ3JpZCJdLCJleHAiOjE3NzgwNDY5MjgsImlhdCI6MTc3NzQ0MjEyOCwiaXNzIjoiaHR0cHM6Ly9saWdodG5pbmcuYWkiLCJqdGkiOiJmNzc0OTlkZS1mNzUyLTRiNTktOGZkZC1jNWM0OWQzNzc5NzUiLCJuYmYiOjE3Nzc0NDIxMjgsInN1YiI6ImY4MWQ0OWNhLWE2NzItNDhlMS04MWJhLWIyOGZjMGY2MWE3NSIsInN1YmplY3RUeXBlIjoidXNlciJ9.DvD3IyJ0WSvBKnITCnQ93jul5Aoxy99TOuFcIJKyQdCMSPOzOSvEQmJNY91OgEHX_ZZFx44j4XIpd0ZsTFarwQ', domain: 'lightning.ai', path: '/', httpOnly: false, secure: false, session: false, expires: 1778046928.869261 },
  { name: 'session-id', value: 'ae31a57f-2dc6-47b2-97d5-a3a2764a55e0', domain: 'lightning.ai', path: '/', httpOnly: true, secure: true, session: true },
  { name: '_rdt_uuid', value: '1774883968759.66b3e189-4970-4973-b374-7fb8dd7d2e23', domain: '.lightning.ai', path: '/', httpOnly: false, secure: true, session: false, expires: 1785220248 },
  { name: '_ga_YRGJD8P09T', value: 'GS2.1.s1777444247$o3$g0$t1777444247$j60$l0$h1422593173', domain: '.lightning.ai', path: '/', httpOnly: false, secure: false, session: false, expires: 1812004247.878304 },
  { name: '_ga', value: 'GA1.1.1941624370.1774883969', domain: '.lightning.ai', path: '/', httpOnly: false, secure: false, session: false, expires: 1812004247.833959 },
  { name: '_gcl_au', value: '1.1.1748337552.1774883969', domain: '.lightning.ai', path: '/', httpOnly: false, secure: false, session: false, expires: 1782659969 },
  { name: '_twpid', value: 'tw.1774883968756.559892106668154187', domain: '.lightning.ai', path: '/', httpOnly: false, secure: true, session: false, expires: 1808579968.758474 },
  { name: 'sess', value: 'MTc3NzQ0MjEyNnxEWDhFQVFMX2dBQUJFQUVRQUFELUFWRF9nQUFJQm5OMGNtbHVad3dSQUE5bmRXVnpkRlZ6WlhKQmNHbExaWGtHYzNSeWFXNW5EQUlBQUFaemRISnBibWNNQ0FBR2MyOTFjbU5sQm5OMGNtbHVad3dDQUFBR2MzUnlhVzVuREJrQUYzQmxibVJwYm1kRGNtVmhkR1ZFWlhCc2IzbHRaVzUwQm5OMGNtbHVad3dDQUFBR2MzUnlhVzVuREFjQUJYTjBZWFJsQm5OMGNtbHVad3dhQUJoak9WcGlkVTk2V0dOclJuZFNhUzAyTjI1TlIyMVJQVDBHYzNSeWFXNW5EQXdBQ25KbFpHbHlaV04wVkc4R2MzUnlhVzVuREI0QUhHaDBkSEJ6T2k4dmJHbG5hSFJ1YVc1bkxtRnBMMjFsTDJGd2NITUdjM1J5YVc1bkRBd0FDbWx1ZG1sMFpVTnZaR1VHYzNSeWFXNW5EQUlBQUFaemRISnBibWNNRXdBUlpYaHdaWEpwYldWdWRHRjBhVzl1U1VRR2MzUnlhVzVuREFJQUFBWnpkSEpwYm1jTUVBQU9jbVZtWlhKeVpYSlFZWEpoYlhNR2MzUnlhVzVuREFZQUJHNTFiR3c9fLpDXXsxM9IW79SYjwa2IULntreczvtbQAcWXmgGoB8y', domain: 'lightning.ai', path: '/', httpOnly: false, secure: false, session: false, expires: 1780034126.536164 },
  { name: 'signals-sdk-session-id', value: '03881432-416f-46e6-a583-fbb436e32075', domain: '.lightning.ai', path: '/', httpOnly: false, secure: false, session: false, expires: 1777446047 },
  { name: 'signals-sdk-user-id', value: '5abbcb57-58ec-402e-a278-7b5e616def38', domain: '.lightning.ai', path: '/', httpOnly: false, secure: false, session: false, expires: 1808980247 },
];

async function run() {
  console.log('Launching headless browser...');
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  console.log('Setting session cookies...');
  await context.addCookies(SESSION_COOKIES);

  const page = await context.newPage();

  await page.route('**/*', async route => {
    const req = route.request();
    const url = req.url();
    if (!url.includes('lightning.ai')) {
      await route.continue();
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers())) {
      headers[k] = v;
    }
    if (url.includes('/v1/') || url.includes('/api/')) {
      headers['Authorization'] = `Bearer ${SESSION_COOKIES[1].value}`;
    }
    await route.continue({ headers });
  });

  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('vscode-') || text.includes('studio.lightning')) {
      console.log(`[Studio]: ${decodeURIComponent(text).slice(0, 300)}`);
    }
  });

  try {
    // Navigate directly to the running studio
    console.log('\n=== Navigating to running studio ===');
    await page.goto('https://lightning.ai/marcosremar/vision-model/studios/amazing-green-jo1/code', { timeout: 30_000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: '/tmp/lightning-studio-running.png', fullPage: false });

    const studioText = await page.evaluate(() => document.body.innerText);
    console.log('Studio page status:', studioText.includes('auto slept') ? 'ASLEEP' : 'RUNNING');
    console.log('Page text (first 1000):', studioText.slice(0, 1000));

    // Click SSH button
    console.log('\n=== Clicking SSH button ===');
    const sshResult = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const sshBtn = buttons.find(b => (b.textContent || '').toLowerCase().includes('ssh'));
      if (!sshBtn) return 'SSH button not found';
      sshBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
      (sshBtn as HTMLButtonElement).click();
      return `Clicked: "${sshBtn.textContent?.trim()}"`;
    });
    console.log(`SSH click: ${sshResult}`);
    await page.waitForTimeout(5000);
    await page.screenshot({ path: '/tmp/lightning-ssh-modal.png', fullPage: false });

    // Read modal content
    const afterText = await page.evaluate(() => document.body.innerText);
    console.log('\n=== Page text after SSH click ===');
    console.log(afterText.slice(0, 5000));

    // Extract SSH lines
    const lines = afterText.split('\n');
    console.log('\n=== Lines with SSH/connection info ===');
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      const lower = l.toLowerCase();
      if (lower.includes('ssh') || lower.includes('@') || lower.includes('host') || lower.includes('port') || lower.includes('user') || lower.includes('command') || lower.includes('connect') || lower.includes('run') || lower.includes('key')) {
        console.log(`  "${l}"`);
      }
    }

    // Check for dialog/modal elements
    const dialogs = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, .Dialog');
      return Array.from(dialogs).map(d => ({
        tag: d.tagName,
        role: d.getAttribute('role'),
        text: d.textContent?.slice(0, 500),
      }));
    });
    console.log('\n=== Dialogs found ===');
    dialogs.forEach(d => console.log(JSON.stringify(d, null, 2)));

    // Check for pre/code elements (often used for SSH command display)
    const preElements = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('pre, code')).map(e => e.textContent?.slice(0, 200));
    });
    console.log('\n=== Pre/code elements ===');
    preElements.filter(t => t && t.length > 5).forEach(t => console.log(`  "${t}"`));

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await browser.close();
  }
}

run().catch(console.error);
