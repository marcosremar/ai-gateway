/**
 * Lightning AI - Login, find Studios, extract SSH access details.
 */

import { chromium, type Browser, type Cookie } from 'playwright';

const COOKIES: Cookie[] = [
  { name: 'visitor-id', value: 'f2555a11-41ce-461f-81e9-36fb535da402', domain: 'lightning.ai', path: '/', httpOnly: true, secure: true, session: false, expires: 1806419967.919146 },
  { name: 'lightning_id_token', value: 'eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJhdWQiOlsiZ3JpZCJdLCJleHAiOjE3NzgwNDY5MjgsImlhdCI6MTc3NzQ0MjEyOCwiaXNzIjoiaHR0cHM6Ly9saWdodG5pbmcuYWkiLCJqdGkiOiJmNzc0OTlkZS1mNzUyLTRiNTktOGZkZC1jNWM0OWQzNzc5NzUiLCJuYmYiOjE3Nzc0NDIxMjgsInN1YiI6ImY4MWQ0OWNhLWE2NzItNDhlMS04MWJhLWIyOGZjMGY2MWE3NSIsInN1YmplY3RUeXBlIjoidXNlciJ9.DvD3IyJ0WSvBKnITCnQ93jul5Aoxy99TOuFcIJKyQdCMSPOzOSvEQmJNY91OgEHX_ZZFx44j4XIpd0ZsTFarwQ', domain: 'lightning.ai', path: '/', httpOnly: false, secure: false, session: false, expires: 1778046928.869261 },
  { name: 'session-id', value: 'ae31a57f-2dc6-47b2-97d5-a3a2764a55e0', domain: 'lightning.ai', path: '/', httpOnly: true, secure: true, session: true },
  { name: '_rdt_uuid', value: '1774883968759.66b3e189-4970-4973-b374-7fb8dd7d2e23', domain: '.lightning.ai', path: '/', httpOnly: false, secure: true, session: false, expires: 1785218128 },
  { name: '_ga_YRGJD8P09T', value: 'GS2.1.s1777442124$o2$g1$t1777442130$j54$l0$h1802665031', domain: '.lightning.ai', path: '/', httpOnly: false, secure: false, session: false, expires: 1812002130.474736 },
  { name: '_ga', value: 'GA1.1.1941624370.1774883969', domain: '.lightning.ai', path: '/', httpOnly: false, secure: false, session: false, expires: 1812002128.769168 },
  { name: '_gcl_au', value: '1.1.1748337552.1774883969', domain: '.lightning.ai', path: '/', httpOnly: false, secure: false, session: false, expires: 1782659969 },
  { name: '_twpid', value: 'tw.1774883968756.559892106668154187', domain: '.lightning.ai', path: '/', httpOnly: false, secure: true, session: false, expires: 1808579968.758474 },
  { name: 'sess', value: 'MTc3NzQ0MjEyNnxEWDhFQVFMX2dBQUJFQUVRQUFELUFWRF9nQUFJQm5OMGNtbHVad3dSQUE5bmRXVnpkRlZ6WlhKQmNHbExaWGtHYzNSeWFXNW5EQUlBQUFaemRISnBibWNNQ0FBR2MyOTFjbU5sQm5OMGNtbHVad3dDQUFBR2MzUnlhVzVuREJrQUYzQmxibVJwYm1kRGNtVmhkR1ZFWlhCc2IzbHRaVzUwQm5OMGNtbHVad3dDQUFBR2MzUnlhVzVuREFjQUJYTjBZWFJsQm5OMGNtbHVad3dhQUJoak9WcGlkVTk2V0dOclJuZFNhUzAyTjI1TlIyMVJQVDBHYzNSeWFXNW5EQXdBQ25KbFpHbHlaV04wVkc4R2MzUnlhVzVuREI0QUhHaDBkSEJ6T2k4dmJHbG5hSFJ1YVc1bkxtRnBMMjFsTDJGd2NITUdjM1J5YVc1bkRBd0FDbWx1ZG1sMFpVTnZaR1VHYzNSeWFXNW5EQUlBQUFaemRISnBibWNNRXdBUlpYaHdaWEpwYldWdWRHRjBhVzl1U1VRR2MzUnlhVzVuREFJQUFBWnpkSEpwYm1jTUVBQU9jbVZtWlhKeVpYSlFZWEpoYlhNR2MzUnlhVzVuREFZQUJHNTFiR3c9fLpDXXsxM9IW79SYjwa2IULntreczvtbQAcWXmgGoB8y', domain: 'lightning.ai', path: '/', httpOnly: false, secure: false, session: false, expires: 1780034126.536164 },
  { name: 'signals-sdk-session-id', value: '665a7635-8a4a-46a3-980c-a80e98237550', domain: '.lightning.ai', path: '/', httpOnly: false, secure: false, session: false, expires: 1777443927 },
  { name: 'signals-sdk-user-id', value: '5abbcb57-58ec-402e-a278-7b5e616def38', domain: '.lightning.ai', path: '/', httpOnly: false, secure: false, session: false, expires: 1808978127 },
];

async function run() {
  console.log('Launching headless browser...');
  const browser: Browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  console.log('Setting session cookies...');
  await context.addCookies(COOKIES);

  const page = await context.newPage();

  try {
    // 1. Go to home page - check if logged in
    console.log('\n=== Step 1: Home page ===');
    await page.goto('https://lightning.ai/', { timeout: 20_000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    console.log(`URL: ${page.url()}`);

    // Look for user account elements (buttons that indicate logged in state)
    const loginButton = await page.$('text=Log in');
    const userButton = await page.$('text=Start free');
    console.log(`Login button visible: ${!!loginButton}`);
    console.log(`Start free button visible: ${!!userButton}`);

    // 2. Try to access Studios directly
    console.log('\n=== Step 2: Try Studios ===');
    await page.goto('https://lightning.ai/studios', { timeout: 20_000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    console.log(`URL: ${page.url()}`);

    // 3. Try the actual app URL (React SPA routing)
    console.log('\n=== Step 3: Try app.lightning.ai ===');
    await page.goto('https://app.lightning.ai', { timeout: 20_000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    console.log(`URL: ${page.url()}`);
    const appText = await page.evaluate(() => document.body.innerText);
    console.log(appText.slice(0, 2000));

    // 4. Look for network requests to the actual API
    console.log('\n=== Step 4: Monitoring API calls ===');
    const apiCalls: string[] = [];
    page.on('request', req => {
      const url = req.url();
      if (url.includes('api.') || url.includes('.lightning.ai')) {
        apiCalls.push(`REQ: ${req.method()} ${url}`);
      }
    });
    page.on('response', resp => {
      const url = resp.url();
      if (url.includes('api.') || url.includes('.lightning.ai')) {
        apiCalls.push(`RES: ${resp.status()} ${url}`);
      }
    });

    await page.goto('https://lightning.ai', { timeout: 20_000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    console.log('API calls captured:');
    apiCalls.slice(0, 30).forEach(c => console.log(c));

    // 5. Try to find the studio SSH page via direct URL patterns
    console.log('\n=== Step 5: Try SSH connect page ===');
    await page.goto('https://lightning.ai/connect/ssh', { timeout: 20_000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    console.log(`URL: ${page.url()}`);
    const sshText = await page.evaluate(() => document.body.innerText);
    console.log(sshText.slice(0, 2000));

    // 6. Try workspace page
    console.log('\n=== Step 6: Try workspace ===');
    await page.goto('https://lightning.ai/workspace', { timeout: 20_000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    console.log(`URL: ${page.url()}`);
    const wsText = await page.evaluate(() => document.body.innerText);
    console.log(wsText.slice(0, 2000));

    // 7. Try Lightning ID token JWT decode - extract user info
    console.log('\n=== Step 7: JWT decode ===');
    const jwt = 'eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJhdWQiOlsiZ3JpZCJdLCJleHAiOjE3NzgwNDY5MjgsImlhdCI6MTc3NzQ0MjEyOCwiaXNzIjoiaHR0cHM6Ly9saWdodG5pbmcuYWkiLCJqdGkiOiJmNzc0OTlkZS1mNzUyLTRiNTktOGZkZC1jNWM0OWQzNzc5NzUiLCJuYmYiOjE3Nzc0NDIxMjgsInN1YiI6ImY4MWQ0OWNhLWE2NzItNDhlMS04MWJhLWIyOGZjMGY2MWE3NSIsInN1YmplY3RUeXBlIjoidXNlciJ9.DvD3IyJ0WSvBKnITCnQ93jul5Aoxy99TOuFcIJKyQdCMSPOzOSvEQmJNY91OgEHX_ZZFx44j4XIpd0ZsTFarwQ';
    try {
      const parts = jwt.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      console.log('JWT Payload:', JSON.stringify(payload, null, 2));
    } catch (e) {
      console.log('JWT decode failed:', e);
    }

    // 8. Check if session cookies actually work for API
    console.log('\n=== Step 8: Test API with session cookies ===');
    const sessionToken = 'ae31a57f-2dc6-47b2-97d5-a3a2764a55e0';
    const lightningIdToken = 'eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJhdWQiOlsiZ3JpZCJdLCJleHAiOjE3NzgwNDY5MjgsImlhdCI6MTc3NzQ0MjEyOCwiaXNzIjoiaHR0cHM6Ly9saWdodG5pbmcuYWkiLCJqdGkiOiJmNzc0OTlkZS1mNzUyLTRiNTktOGZkZC1jNWM0OWQzNzc5NzUiLCJuYmYiOjE3Nzc0NDIxMjgsInN1YiI6ImY4MWQ0OWNhLWE2NzItNDhlMS04MWJhLWIyOGZjMGY2MWE3NSIsInN1YmplY3RUeXBlIjoidXNlciJ9.DvD3IyJ0WSvBKnITCnQ93jul5Aoxy99TOuFcIJKyQdCMSPOzOSvEQmJNY91OgEHX_ZZFx44j4XIpd0ZsTFarwQ';

    // Try to call the Lightning API directly
    const apiResp = await fetch('https://lightning.ai/api/v1/account', {
      headers: {
        'Authorization': `Bearer ${lightningIdToken}`,
        'Content-Type': 'application/json',
      }
    }).catch(e => null);

    if (apiResp) {
      console.log(`Account API status: ${apiResp.status}`);
      const text = await apiResp.text();
      console.log(`Account API response: ${text.slice(0, 500)}`);
    } else {
      console.log('Account API call failed');
    }

    // 9. Try studio API
    const studioResp = await fetch('https://lightning.ai/api/v1/studios', {
      headers: {
        'Authorization': `Bearer ${lightningIdToken}`,
        'Content-Type': 'application/json',
      }
    }).catch(e => null);

    if (studioResp) {
      console.log(`Studios API status: ${studioResp.status}`);
      const text = await studioResp.text();
      console.log(`Studios API response: ${text.slice(0, 500)}`);
    }

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await browser.close();
  }
}

run().catch(console.error);
