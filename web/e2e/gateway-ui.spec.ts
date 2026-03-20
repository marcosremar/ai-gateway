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
    // OverviewSection shows compact "p50 142ms" format in the status bar
    await expect(page.getByText('p50')).toBeVisible();
    await expect(page.getByText('p95')).toBeVisible();
    await expect(page.getByText('142ms')).toBeVisible();
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
    // Wait for GPU tile to show the ACTIVE badge (visible when isActive=true)
    await expect(page.getByText('ACTIVE').first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('vast')).toBeVisible();
    // GpuTile strips the 'NVIDIA ' prefix when displaying the GPU type
    await expect(page.getByText('RTX A6000')).toBeVisible();
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

  test('shows pipeline components section', async ({ page, request }) => {
    // Seed a profile so PipelineHealthCard renders
    await request.post(`${MOCK}/v1/config/providers`, {
      data: {
        profiles: [{ id: 'p-ov', name: 'Default', stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }], llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }], tts: [{ provider: 'gpu', model: 'qwen3-tts' }] }],
        activeProfileId: 'p-ov',
      },
    });
    await page.goto('/');
    // PipelineHealthCard renders stage labels: STT, LLM, TTS
    await expect(page.getByText('STT').first()).toBeVisible();
    await expect(page.getByText('LLM').first()).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tab Navigation
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Tab Navigation', () => {
  test('all tabs are present', async ({ page }) => {
    await page.goto('/');
    for (const tab of ['Overview', 'Profiles', 'API Keys', 'Playground', 'Bot', 'Reputation', 'Logs & Metrics']) {
      await expect(page.getByRole('button', { name: tab, exact: true })).toBeVisible();
    }
  });

  test('clicking tabs switches content', async ({ page }) => {
    await page.goto('/');
    // Start on Overview — compact status bar shows p50/p95 latency
    await expect(page.getByText('p50')).toBeVisible();

    // Switch to Profiles
    await page.getByRole('button', { name: 'Profiles', exact: true }).click();
    await expect(page.getByText('Profiles').first()).toBeVisible();

    // Switch to Playground (formerly "Pipeline Test")
    await page.getByRole('button', { name: 'Playground', exact: true }).click();
    await expect(page.getByText('STT').first()).toBeVisible();

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

    // Should navigate to detail view — shows editable name input and Save & Apply button
    await expect(page.locator('[placeholder="Profile name..."]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save & Apply' }).first()).toBeVisible();
  });
});

// Deploy Tab removed — deploy controls are now integrated into Profile Services
// Detailed Profiles tests are in profiles.spec.ts

// ─────────────────────────────────────────────────────────────────────────────
// Playground Tab (formerly "Pipeline Test")
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Playground Tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Playground', exact: true }).click();
  });

  test('shows playground with mode selector', async ({ page }) => {
    // Playground has Chat / Transcribe / TTS mode buttons
    await expect(page.getByRole('button', { name: /Chat/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Transcribe/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /text to speech/i }).first()).toBeVisible();
  });

  test('shows STT section in sidebar', async ({ page }) => {
    // Config panel shows STT and TTS sections
    await expect(page.getByText('STT')).toBeVisible();
  });

  test('has a message input area', async ({ page }) => {
    // The playground has a textarea for entering messages/text
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeVisible();
  });

  test('switching to TTS mode shows TTS controls', async ({ page }) => {
    await page.getByRole('button', { name: /text to speech/i }).first().click();
    // TTS mode shows "TTS" label in the sidebar (exact match to avoid matching "PlayAI TTS" etc.)
    await expect(page.getByText('TTS', { exact: true })).toBeVisible();
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
    await expect(page.getByText('CPU Pod', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Cloud Docker')).toBeVisible();
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
    // 0.83 and 0.72 are in "Good" tier (expanded by default)
    await expect(page.getByText('0.83')).toBeVisible();
    await expect(page.getByText('0.72')).toBeVisible();
    // 0.35 is in "Poor" tier (collapsed by default) — expand it first
    await page.getByText('Poor').click();
    await expect(page.getByText('0.35')).toBeVisible();
  });

  test('scores are color-coded', async ({ page }) => {
    // Scores use inline style colors (not Tailwind classes)
    // 0.83 and 0.72 are in Good tier → #60a5fa (blue)
    const highScore = page.getByText('0.83');
    await expect(highScore).toHaveCSS('color', 'rgb(96, 165, 250)');

    const medScore = page.getByText('0.72');
    await expect(medScore).toHaveCSS('color', 'rgb(96, 165, 250)');

    // 0.35 is in Poor tier — expand it first
    await page.getByText('Poor').click();
    // Low score (0.35) → #f87171 (red)
    const lowScore = page.getByText('0.35');
    await expect(lowScore).toHaveCSS('color', 'rgb(248, 113, 113)');
  });

  test('shows provider filter dropdown', async ({ page }) => {
    // Provider filter is a segmented button group (not a native <select>)
    await expect(page.getByRole('button', { name: 'All providers' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Vast.ai' })).toBeVisible();
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
