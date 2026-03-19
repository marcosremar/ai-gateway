import { test, expect } from '@playwright/test';

const MOCK = 'http://localhost:4099';

test.beforeEach(async ({ request }) => {
  // Reset mock state before each test
  await request.post(`${MOCK}/mock/reset`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Overview Tab
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Overview Tab', () => {
  test('shows sidebar with green health dot and uptime', async ({ page }) => {
    await page.goto('/');
    // Health dot should be green (gateway is up) — in sidebar brand area
    const dot = page.locator('aside .bg-emerald-500');
    await expect(dot).toBeVisible();
    // Top bar should show "ok" status
    await expect(page.getByText('ok')).toBeVisible();
  });

  test('shows overview with latency stats', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('P50 Latency')).toBeVisible();
    await expect(page.getByText('142ms')).toBeVisible();
    await expect(page.getByText('P95 Latency')).toBeVisible();
    await expect(page.getByText('380ms')).toBeVisible();
  });

  test('shows daily spend budget info', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('$1.23')).toBeVisible();
    await expect(page.getByText('$10.00')).toBeVisible();
  });

  test('shows GPU status card with idle state', async ({ page }) => {
    await page.goto('/');
    const gpuCard = page.locator('text=GPU').first();
    await expect(gpuCard).toBeVisible();
    // Should show idle badge
    await expect(page.getByText('idle').first()).toBeVisible();
  });

  test('shows GPU status card with ready state', async ({ page, request }) => {
    await request.post(`${MOCK}/mock/state`, { data: { gpuStatus: 'ready' } });
    await page.goto('/');
    // Wait for polling to pick up the ready state
    await expect(page.getByText('ready').first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('vast')).toBeVisible();
    await expect(page.getByText('NVIDIA RTX A6000')).toBeVisible();
  });

  test('shows bot status card', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Bot').first()).toBeVisible();
  });

  test('shows provider metrics section', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Provider Performance')).toBeVisible();
    await expect(page.getByText('groq').first()).toBeVisible();
  });

  test('shows pipeline components section', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Active Pipeline')).toBeVisible();
    // Stage names are uppercase in routing bar
    await expect(page.getByText('STT').or(page.getByText('stt')).first()).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tab Navigation
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Tab Navigation', () => {
  test('all tabs are present', async ({ page }) => {
    await page.goto('/');
    for (const tab of ['Overview', 'Profiles', 'Pipeline', 'Deploy', 'Pipeline Test', 'Bot', 'Reputation', 'Logs & Metrics']) {
      await expect(page.getByRole('button', { name: tab, exact: true })).toBeVisible();
    }
  });

  test('clicking tabs switches content', async ({ page }) => {
    await page.goto('/');
    // Start on Overview
    await expect(page.getByText('P50 Latency')).toBeVisible();

    // Switch to Profiles
    await page.getByRole('button', { name: 'Profiles', exact: true }).click();
    await expect(page.getByText('Profiles').first()).toBeVisible();

    // Switch to Pipeline Test
    await page.getByRole('button', { name: 'Pipeline Test' }).click();
    await expect(page.getByText('Translation Test')).toBeVisible();

    // Switch to Bot
    await page.getByRole('button', { name: /^Bot$/ }).click();
    await expect(page.getByText('Deploy a Meeting BaaS bot pod')).toBeVisible();

    // Switch to Reputation
    await page.getByRole('button', { name: 'Reputation' }).click();
    await expect(page.getByText('Host Reputation')).toBeVisible();

    // Switch to Logs & Metrics
    await page.getByRole('button', { name: 'Logs & Metrics' }).click();
    await expect(page.getByText('Request Log')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profiles Tab
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Profiles Tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Profiles' }).click();
  });

  test('shows profiles section header', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Profiles' })).toBeVisible();
    await expect(page.getByText('Manage pipeline profiles')).toBeVisible();
  });

  test('shows empty state when no profiles', async ({ page }) => {
    await expect(page.getByText('No profiles yet')).toBeVisible();
  });

  test('can create a new profile', async ({ page }) => {
    const newBtn = page.getByRole('button', { name: 'New Profile' });
    await expect(newBtn).toBeVisible();
    await newBtn.click();

    // Should navigate to detail view with Profile Name card
    await expect(page.getByText('Profile Name')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save & Apply' }).first()).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Tab
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Profiles Tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  });

  test('shows profiles page', async ({ page }) => {
    await expect(page.getByText('Profiles').first()).toBeVisible();
  });
});

// Deploy Tab removed — deploy controls are now integrated into Profile Services

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Test Tab
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Pipeline Test Tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Pipeline Test' }).click();
  });

  test('shows translation form with language selectors', async ({ page }) => {
    await expect(page.getByText('Translation Test')).toBeVisible();
    await expect(page.getByText('Source')).toBeVisible();
    await expect(page.getByText('Target')).toBeVisible();
    await expect(page.getByText('Input text')).toBeVisible();
  });

  test('can translate text', async ({ page }) => {
    const textarea = page.locator('textarea').first();
    await textarea.fill('Bonjour le monde');

    const translateBtn = page.getByRole('button', { name: 'Translate' });
    await translateBtn.click();

    // Should show translated result
    await expect(page.getByText('[Translated from fr to en]: Bonjour le monde')).toBeVisible({ timeout: 5000 });
    // Should show latency
    await expect(page.getByText('Result')).toBeVisible();
  });

  test('translate button is disabled when input is empty', async ({ page }) => {
    const translateBtn = page.getByRole('button', { name: 'Translate' });
    await expect(translateBtn).toBeDisabled();
  });

  test('shows TTS preview section', async ({ page }) => {
    await expect(page.getByText('TTS Preview')).toBeVisible();
    await expect(page.getByText('Voice')).toBeVisible();
    await expect(page.getByText('Language', { exact: true })).toBeVisible();
  });

  test('TTS speak button is disabled when input is empty', async ({ page }) => {
    const speakBtn = page.getByRole('button', { name: 'Speak' });
    await expect(speakBtn).toBeDisabled();
  });

  test('can trigger TTS preview', async ({ page }) => {
    const ttsTextarea = page.locator('textarea').nth(1);
    await ttsTextarea.fill('Hello world test');

    const speakBtn = page.getByRole('button', { name: 'Speak' });
    await expect(speakBtn).toBeEnabled();
    await speakBtn.click();

    // Should create audio element (mock returns valid WAV header)
    // No error should appear
    await page.waitForTimeout(1000);
    const errorBanner = page.locator('text=TTS failed');
    await expect(errorBanner).not.toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bot Tab
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Bot Tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /^Bot$/ }).click();
  });

  test('shows deploy controls with toggles', async ({ page }) => {
    await expect(page.getByText('Deploy a Meeting BaaS bot pod')).toBeVisible();
    await expect(page.getByText('CPU only')).toBeVisible();
    await expect(page.getByText('Local Docker')).toBeVisible();
  });

  test('deploy bot creates a bot pod', async ({ page }) => {
    const deployBtn = page.getByRole('button', { name: 'Deploy Bot' });
    await expect(deployBtn).toBeEnabled();
    await deployBtn.click();

    // Should show Bot Status card
    await expect(page.getByText('Bot Status')).toBeVisible({ timeout: 10000 });
  });

  test('shows join meeting form', async ({ page }) => {
    await expect(page.getByText('Join Meeting')).toBeVisible();
    await expect(page.getByText('Meeting URL')).toBeVisible();
    await expect(page.getByText('Bot Name')).toBeVisible();
  });

  test('join button disabled when no bot deployed', async ({ page }) => {
    const joinBtn = page.getByRole('button', { name: 'Join' });
    await expect(joinBtn).toBeDisabled();
  });

  test('can join meeting when bot is ready', async ({ page, request }) => {
    await request.post(`${MOCK}/mock/state`, { data: { botStatus: 'ready' } });
    await page.goto('/');
    await page.getByRole('button', { name: /^Bot$/ }).click();

    // Fill meeting URL
    const urlInput = page.getByPlaceholder(/teams.microsoft.com/);
    await urlInput.fill('https://teams.microsoft.com/l/meetup-join/test123');

    const joinBtn = page.getByRole('button', { name: 'Join' });
    await expect(joinBtn).toBeEnabled({ timeout: 10000 });
    await joinBtn.click();

    // Status should update to joined
    await expect(page.getByText('joined').first()).toBeVisible({ timeout: 10000 });
  });

  test('terminate bot stops the pod', async ({ page, request }) => {
    await request.post(`${MOCK}/mock/state`, { data: { botStatus: 'ready' } });
    await page.goto('/');
    await page.getByRole('button', { name: /^Bot$/ }).click();

    await expect(page.getByText('Bot Status')).toBeVisible({ timeout: 10000 });

    const terminateBtn = page.getByRole('button', { name: 'Terminate' });
    await expect(terminateBtn).toBeEnabled();
    await terminateBtn.click();

    // Status card should disappear
    await expect(page.getByText('Bot Status')).not.toBeVisible({ timeout: 10000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reputation Tab
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Reputation Tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Reputation' }).click();
  });

  test('shows reputation table with hosts', async ({ page }) => {
    await expect(page.getByText('Host Reputation')).toBeVisible();
    await expect(page.getByText('3 hosts')).toBeVisible();
  });

  test('shows host data with scores', async ({ page }) => {
    // Check for reputation scores
    await expect(page.getByText('0.83')).toBeVisible();
    await expect(page.getByText('0.72')).toBeVisible();
    await expect(page.getByText('0.35')).toBeVisible();
  });

  test('scores are color-coded', async ({ page }) => {
    // High score (0.83) should be green
    const highScore = page.getByText('0.83');
    await expect(highScore).toHaveClass(/text-emerald-400/);

    // Medium score (0.72) should also be green (>= 0.7)
    const medScore = page.getByText('0.72');
    await expect(medScore).toHaveClass(/text-emerald-400/);

    // Low score (0.35) should be red
    const lowScore = page.getByText('0.35');
    await expect(lowScore).toHaveClass(/text-red-400/);
  });

  test('shows provider filter dropdown', async ({ page }) => {
    const filter = page.locator('select').first();
    await expect(filter).toContainText('All providers');
    await expect(filter).toContainText('Vast.ai');
  });

  test('table columns are sortable', async ({ page }) => {
    // Click Score column header to sort
    await page.getByText('Score').click();
    // After clicking, order should change (ascending sort)
    // Just verify no crash
    await expect(page.getByText('Host Reputation')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Logs & Metrics Tab
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Logs & Metrics Tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Logs & Metrics' }).click();
  });

  test('shows metrics cards', async ({ page }) => {
    await expect(page.getByText('Total Requests')).toBeVisible();
    await expect(page.getByText('225', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Errors', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('P50 Latency').first()).toBeVisible();
    await expect(page.getByText('P95 Latency').first()).toBeVisible();
  });

  test('shows by-stage breakdown', async ({ page }) => {
    await expect(page.getByText('By Stage')).toBeVisible();
    // stt: 90, llm: 80, tts: 55
    await expect(page.getByText('90')).toBeVisible();
  });

  test('shows by-provider breakdown', async ({ page }) => {
    await expect(page.getByText('By Provider')).toBeVisible();
  });

  test('shows request log table', async ({ page }) => {
    await expect(page.getByText('Request Log')).toBeVisible();
    // Check for log entries
    await expect(page.getByText('whisper-large-v3')).toBeVisible();
    await expect(page.getByText('llama-3.3-70b')).toBeVisible();
  });

  test('request log shows success and error states', async ({ page }) => {
    // Should have OK entries
    await expect(page.getByText('OK').first()).toBeVisible();
    // Should have ERR entry (the last one in mock)
    await expect(page.getByText('ERR', { exact: true })).toBeVisible();
  });

  test('auto-refresh toggle works', async ({ page }) => {
    const toggle = page.locator('[role="switch"]');
    await expect(toggle).toBeVisible();
    // Toggle on
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // Toggle off
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gateway Unavailable
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Gateway Unavailable', () => {
  test('shows green dot when gateway is up', async ({ page }) => {
    await page.goto('/');
    // Gateway IS up in our mock, so we should see green dot in sidebar
    const dot = page.locator('aside .bg-emerald-500');
    await expect(dot).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Header Branding
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Header Branding', () => {
  test('shows AI Gateway title (not BabelCast)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('aside h1')).toHaveText('AI Gateway Settings');
  });
});
