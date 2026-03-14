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
    await expect(page.getByText('Provider Metrics')).toBeVisible();
    await expect(page.getByText('groq').first()).toBeVisible();
  });

  test('shows pipeline components section', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Pipeline Components')).toBeVisible();
    // Components are rendered with uppercase names
    await expect(page.getByText('STT').or(page.getByText('stt')).first()).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tab Navigation
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Tab Navigation', () => {
  test('all tabs are present', async ({ page }) => {
    await page.goto('/');
    for (const tab of ['Overview', 'Providers', 'GPU Deploy', 'Pipeline Test', 'Bot', 'Reputation', 'Logs & Metrics']) {
      await expect(page.getByRole('button', { name: tab })).toBeVisible();
    }
  });

  test('clicking tabs switches content', async ({ page }) => {
    await page.goto('/');
    // Start on Overview
    await expect(page.getByText('P50 Latency')).toBeVisible();

    // Switch to Providers
    await page.getByRole('button', { name: 'Providers' }).click();
    await expect(page.getByText('AI Providers')).toBeVisible();

    // Switch to GPU Deploy
    await page.getByRole('button', { name: 'GPU Deploy' }).click();
    await expect(page.getByText('Deploy Configuration')).toBeVisible();

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
// Providers Tab (replaces API Keys)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Providers Tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Providers' }).click();
  });

  test('shows section header', async ({ page }) => {
    await expect(page.getByText('AI Providers')).toBeVisible();
    await expect(page.getByText('Provider status, pipeline configuration, and profiles')).toBeVisible();
  });

  test('shows cloud provider buttons with status', async ({ page }) => {
    // Providers are shown with Configured/No key status
    // Use .first() since provider names also appear in pipeline stage cards
    await expect(page.getByText('Groq', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('OpenAI', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Deepgram', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Fireworks', { exact: true }).first()).toBeVisible();
  });

  test('shows GPU provider buttons', async ({ page }) => {
    await expect(page.getByText('GPU Providers')).toBeVisible();
    await expect(page.getByText('Vast.ai')).toBeVisible();
    await expect(page.getByText('TensorDock')).toBeVisible();
    await expect(page.getByText('RunPod')).toBeVisible();
  });

  test('shows info banner about env configuration', async ({ page }) => {
    await expect(page.getByText('environment variables')).toBeVisible();
  });

  test('configured providers show Configured text', async ({ page }) => {
    // groq and deepgram are configured in mock
    const configuredText = page.getByText('Configured');
    await expect(configuredText.first()).toBeVisible();
  });

  test('shows pipeline configuration section', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Provider Configuration' })).toBeVisible();
  });

  test('shows 3-column pipeline stage cards (STT, LLM, TTS)', async ({ page }) => {
    // Stage cards have labels and subtitles
    await expect(page.getByText('Speech-to-Text')).toBeVisible();
    await expect(page.getByText('Translation')).toBeVisible();
    await expect(page.getByText('Text-to-Speech')).toBeVisible();
  });

  test('shows cloud/GPU mode indicator', async ({ page }) => {
    // Mode indicator is a centered horizontal toggle — may be below the fold
    const modeToggle = page.getByText('API providers');
    await modeToggle.scrollIntoViewIfNeeded();
    await expect(modeToggle).toBeVisible();
    await expect(page.getByText('Self-hosted', { exact: true })).toBeVisible();
  });

  test('shows provider metrics table when available', async ({ page }) => {
    await expect(page.getByText('Provider Metrics')).toBeVisible();
    // groq should show with stats from mock
    await expect(page.getByText('95ms').first()).toBeVisible();
  });

  // ── Fallback chain tests ──

  test('pipeline stages show editable fallback chains with primary badge', async ({ page }) => {
    // The STT stage should show at least the default primary provider
    await expect(page.getByText('#1 Primary').first()).toBeVisible();
  });

  test('can add fallback to pipeline stage', async ({ page }) => {
    // Click "Add fallback" on the first stage (STT)
    const addBtn = page.getByText('Add fallback').first();
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    // Fallback form should appear with provider/model selects
    await expect(page.locator('label', { hasText: 'Provider' }).first()).toBeVisible();
    await expect(page.locator('label', { hasText: 'Model' }).first()).toBeVisible();

    // Click Add to add the fallback
    const confirmBtn = page.getByRole('button', { name: 'Add' }).first();
    await confirmBtn.click();

    // Should now show a #2 Fallback badge
    await expect(page.getByText('#2 Fallback').first()).toBeVisible();
  });

  // ── Profile tests ──

  test('shows profiles section', async ({ page }) => {
    // Profiles section is below the fold — scroll to it
    const profilesHeading = page.getByText('Manage Profiles');
    await profilesHeading.scrollIntoViewIfNeeded();
    await expect(profilesHeading).toBeVisible();
    await expect(page.getByText('No saved profiles')).toBeVisible();
  });

  test('can create and apply a profile', async ({ page }) => {
    // Scroll to profiles section
    const newBtn = page.getByText('New profile');
    await newBtn.scrollIntoViewIfNeeded();
    await expect(newBtn).toBeVisible();
    await newBtn.click();

    // Type profile name and save
    const input = page.locator('input[placeholder="Profile name..."]');
    await input.fill('Test Profile');
    await page.getByRole('button', { name: 'Save' }).click();

    // Profile should appear in the list
    await expect(page.getByText('Test Profile')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GPU Deploy Tab
// ─────────────────────────────────────────────────────────────────────────────

test.describe('GPU Deploy Tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'GPU Deploy' }).click();
  });

  test('shows docker image selector', async ({ page }) => {
    await expect(page.getByText('Docker Image', { exact: true })).toBeVisible();
    // Select is inside the main content area
    const select = page.locator('main select').first();
    await expect(select).toBeVisible();
    // Should have the default image selected
    await expect(select).toHaveValue('marcosremar/babelcast-mistral:latest');
  });

  test('shows GPU type pill buttons with VRAM info', async ({ page }) => {
    await expect(page.getByText('Select GPUs')).toBeVisible();
    await expect(page.getByText('RTX A6000')).toBeVisible();
    await expect(page.getByText('RTX 4090')).toBeVisible();
    await expect(page.getByText('A100 SXM4')).toBeVisible();
    // VRAM labels
    await expect(page.getByText('48GB').first()).toBeVisible();
  });

  test('GPU type pills can be toggled', async ({ page }) => {
    // Find the RTX 4090 button by its text content
    const pill = page.locator('button', { hasText: 'RTX 4090' });
    await expect(pill).toBeVisible();
    // Click to toggle selection
    await pill.click();
    // Click again to toggle off
    await pill.click();
    // No crash — just verifying interaction works
    await expect(pill).toBeVisible();
  });

  test('shows provider selector', async ({ page }) => {
    // Use exact match to avoid matching "Providers" tab button
    await expect(page.locator('main').getByText('Provider', { exact: true })).toBeVisible();
    // Find the provider select by looking for the one containing "Auto (best available)"
    const providerSelect = page.locator('main select', { has: page.locator('option', { hasText: 'Auto (best available)' }) });
    await expect(providerSelect).toBeVisible();
    await expect(providerSelect).toContainText('Auto (best available)');
  });

  test('deploy button triggers deploy and shows status', async ({ page }) => {
    // Target the Deploy action button inside main (not the tab button "GPU Deploy")
    const deployBtn = page.locator('main button', { hasText: 'Deploy' }).first();
    await expect(deployBtn).toBeEnabled();

    // Click and wait for the deploy POST to complete
    const [response] = await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/v1/gpu/deploy') && resp.status() === 202),
      deployBtn.click(),
    ]);
    expect(response.status()).toBe(202);

    // After deploy, polling should pick up the new status and show Deploy Status bar
    await expect(page.getByText('Deploy Status')).toBeVisible({ timeout: 15000 });
  });

  test('terminate button stops GPU', async ({ page, request }) => {
    // Set GPU to ready state first
    await request.post(`${MOCK}/mock/state`, { data: { gpuStatus: 'ready' } });
    await page.goto('/');
    await page.getByRole('button', { name: 'GPU Deploy' }).click();

    // Wait for deploy status bar to show
    await expect(page.getByText('Deploy Status')).toBeVisible({ timeout: 10000 });

    const stopBtn = page.getByRole('button', { name: 'Stop' });
    await expect(stopBtn).toBeEnabled();
    await stopBtn.click();

    // Deploy Status bar should disappear when idle
    await expect(page.getByText('Deploy Status')).not.toBeVisible({ timeout: 10000 });
  });

  test('GPU logs viewer loads logs', async ({ page }) => {
    await expect(page.getByText('GPU Logs')).toBeVisible({ timeout: 10000 });
    const refreshBtn = page.getByRole('button', { name: 'Refresh Logs' });
    await refreshBtn.click();

    await expect(page.getByText('Starting BabelCast GPU server')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('All models loaded')).toBeVisible();
  });

  test('shows error recovery UI when deploy failed', async ({ page, request }) => {
    await request.post(`${MOCK}/mock/state`, { data: { gpuStatus: 'error' } });
    await page.goto('/');
    await page.getByRole('button', { name: 'GPU Deploy' }).click();

    await expect(page.getByText('Deploy failed')).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: /Retry/ })).toBeVisible();
  });
});

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
    await expect(page.locator('aside h1')).toHaveText('AI Gateway');
  });
});
