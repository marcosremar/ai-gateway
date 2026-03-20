import { test, expect, type Page } from '@playwright/test';

const MOCK = 'http://localhost:4099';

// ── Helpers ──

async function seedGpuProfile(request: any) {
  await request.post(`${MOCK}/v1/config/providers`, {
    data: {
      profiles: [
        {
          id: 'prof-gpu',
          name: 'GPU Deploy Test',
          latency: 'realtime',
          enabled: true,
          stt: [{ provider: 'gpu', model: 'faster-whisper-large-v3' }],
          llm: [{ provider: 'gpu', model: 'translategemma' }],
          tts: [{ provider: 'gpu', model: 'qwen3-tts' }],
          services: [
            {
              id: 'svc-gpu',
              name: 'Babelcast Groq Cloud',
              kind: 'gpu-pod',
              dockerImage: 'marcosremar/babelcast-groq:latest',
              gpuTypes: ['NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000', 'A40'],
              gpuCloudProvider: 'vast',
            },
          ],
        },
      ],
      activeProfileId: 'prof-gpu',
    },
  });
}

/** Navigate to the GPU service card deploy settings panel. */
async function goToDeploySettings(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  await page.getByText('GPU Deploy Test').click();
  // Wait for profile detail to load
  await expect(page.getByText('GPU Deploy Test').first()).toBeVisible();
  await page.getByRole('button', { name: /Services/ }).click();
  // Wait for service card to be visible
  await expect(page.getByText('Babelcast Groq Cloud').first()).toBeVisible();
  // Wait for deploy settings to render
  await expect(page.getByText('Deploy Settings')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await request.post(`${MOCK}/mock/reset`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Deploy Settings Panel — Visibility
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Deploy Settings — Panel', () => {
  test.beforeEach(async ({ request }) => { await seedGpuProfile(request); });

  test('deploy settings panel is visible for GPU pod services', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByText('Deploy Settings')).toBeVisible();
  });

  test('image dropdown is present and visible', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.locator('select').first()).toBeVisible();
  });

  test('image dropdown contains expected options', async ({ page }) => {
    await goToDeploySettings(page);
    const select = page.locator('select').first();
    const options = await select.locator('option').allTextContents();
    // Should have docker image options
    expect(options.length).toBeGreaterThan(0);
  });

  test('deploy button is visible', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByRole('button', { name: 'Deploy' }).first()).toBeVisible();
  });

  test('Image label is visible', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByText('Image')).toBeVisible();
  });

  test('Min VRAM label is visible', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByText('Min VRAM')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Provider Selector
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Deploy Settings — Provider', () => {
  test.beforeEach(async ({ request }) => { await seedGpuProfile(request); });

  test('shows provider chips: Auto, Vast.ai, TensorDock, RunPod', async ({ page }) => {
    await goToDeploySettings(page);
    // These are the exact names from GPU_PROVIDERS in provider-types.ts
    await expect(page.getByRole('button', { name: 'Auto' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Vast.ai' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'TensorDock' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'RunPod' })).toBeVisible();
  });

  test('Auto is selected by default (cyan accent)', async ({ page }) => {
    await goToDeploySettings(page);
    const autoBtn = page.getByRole('button', { name: 'Auto' }).first();
    await expect(autoBtn).toHaveAttribute('style', /#06b6d4/);
  });

  test('clicking Vast.ai selects it', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'Vast.ai' }).click();
    // Auto-retry: wait for style to reflect selected state (cyan)
    await expect(page.getByRole('button', { name: 'Vast.ai' })).toHaveAttribute('style', /#06b6d4/);
  });

  test('clicking RunPod selects it', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'RunPod' }).click();
    await expect(page.getByRole('button', { name: 'RunPod' })).toHaveAttribute('style', /#06b6d4/);
  });

  test('clicking a provider deselects Auto', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'TensorDock' }).click();
    // Auto should no longer have cyan background
    const autoStyle = await page.getByRole('button', { name: 'Auto' }).first().getAttribute('style');
    expect(autoStyle).not.toContain('#06b6d4');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Region Selector
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Deploy Settings — Region', () => {
  test.beforeEach(async ({ request }) => { await seedGpuProfile(request); });

  test('shows region chips: Auto, US, EU, Asia', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByRole('button', { name: 'US' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'EU' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Asia' })).toBeVisible();
  });

  test('clicking EU selects it (blue accent)', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'EU' }).click();
    await expect(page.getByRole('button', { name: 'EU' })).toHaveAttribute('style', /#3b82f6/);
  });

  test('clicking Asia selects it', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'Asia' }).click();
    await expect(page.getByRole('button', { name: 'Asia' })).toHaveAttribute('style', /#3b82f6/);
  });

  test('clicking US selects it and deselects Auto', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'US' }).click();
    await expect(page.getByRole('button', { name: 'US' })).toHaveAttribute('style', /#3b82f6/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Min VRAM Selector
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Deploy Settings — Min VRAM', () => {
  test.beforeEach(async ({ request }) => { await seedGpuProfile(request); });

  test('shows all VRAM chips: Any, 8GB, 16GB, 24GB, 40GB, 80GB', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByRole('button', { name: 'Any' })).toBeVisible();
    await expect(page.getByRole('button', { name: '8GB' })).toBeVisible();
    await expect(page.getByRole('button', { name: '16GB' })).toBeVisible();
    await expect(page.getByRole('button', { name: '24GB' })).toBeVisible();
    await expect(page.getByRole('button', { name: '40GB' })).toBeVisible();
    await expect(page.getByRole('button', { name: '80GB' })).toBeVisible();
  });

  test('Any is selected by default (emerald accent)', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByRole('button', { name: 'Any' })).toHaveAttribute('style', /#10b981/);
  });

  test('clicking 24GB selects it', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '24GB' }).click();
    await expect(page.getByRole('button', { name: '24GB' })).toHaveAttribute('style', /#10b981/);
  });

  test('selecting 40GB deselects Any', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '40GB' }).click();
    await expect(page.getByRole('button', { name: '40GB' })).toHaveAttribute('style', /#10b981/);
    // Any no longer selected
    const anyStyle = await page.getByRole('button', { name: 'Any' }).getAttribute('style');
    expect(anyStyle).not.toContain('#10b981');
  });

  test('clicking Any after selecting VRAM reverts', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '16GB' }).click();
    await page.getByRole('button', { name: 'Any' }).click();
    await expect(page.getByRole('button', { name: 'Any' })).toHaveAttribute('style', /#10b981/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Parallel Launch Selector
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Deploy Settings — Parallel Launch', () => {
  test.beforeEach(async ({ request }) => { await seedGpuProfile(request); });

  test('shows 1, ×2, ×3, ×5 chips', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByRole('button', { name: '1' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: '×2' })).toBeVisible();
    await expect(page.getByRole('button', { name: '×3' })).toBeVisible();
    await expect(page.getByRole('button', { name: '×5' })).toBeVisible();
  });

  test('1 is selected by default (purple accent)', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByRole('button', { name: '1' }).first()).toHaveAttribute('style', /#8b5cf6/);
  });

  test('"Standard deploy." shown when count=1', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByText('Standard deploy.')).toBeVisible();
  });

  test('selecting ×3 shows race description and renames deploy button', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '×3' }).click();
    await expect(page.getByText(/3 instances/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Race ×3' })).toBeVisible();
  });

  test('selecting ×2 changes deploy button to "Race ×2"', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '×2' }).click();
    await expect(page.getByRole('button', { name: 'Race ×2' })).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-stop Selector
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Deploy Settings — Auto-stop', () => {
  test.beforeEach(async ({ request }) => { await seedGpuProfile(request); });

  test('shows time chips: 5m, 15m, 30m, 60m, Never', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByRole('button', { name: '5m' })).toBeVisible();
    await expect(page.getByRole('button', { name: '15m' })).toBeVisible();
    await expect(page.getByRole('button', { name: '30m' })).toBeVisible();
    await expect(page.getByRole('button', { name: '60m' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Never' })).toBeVisible();
  });

  test('15m is selected by default (amber accent)', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByRole('button', { name: '15m' })).toHaveAttribute('style', /#f59e0b/);
  });

  test('clicking Never shows "Manual stop only." description', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'Never' }).click();
    await expect(page.getByText('Manual stop only.')).toBeVisible();
  });

  test('clicking 30m shows idle description', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '30m' }).click();
    await expect(page.getByText('Idle 30m → stop.')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Disk Size Selector
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Deploy Settings — Disk Size', () => {
  test.beforeEach(async ({ request }) => { await seedGpuProfile(request); });

  test('shows disk size chips: 10GB, 20GB, 50GB, 100GB', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByRole('button', { name: '10GB' })).toBeVisible();
    await expect(page.getByRole('button', { name: '20GB' })).toBeVisible();
    await expect(page.getByRole('button', { name: '50GB' })).toBeVisible();
    await expect(page.getByRole('button', { name: '100GB' })).toBeVisible();
    await expect(page.getByText('Container disk.')).toBeVisible();
  });

  test('20GB is selected by default (blue accent)', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByRole('button', { name: '20GB' })).toHaveAttribute('style', /#93c5fd/);
  });

  test('clicking 50GB selects it', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '50GB' }).click();
    await expect(page.getByRole('button', { name: '50GB' })).toHaveAttribute('style', /#93c5fd/);
  });

  test('clicking 100GB deselects 20GB', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '100GB' }).click();
    await expect(page.getByRole('button', { name: '100GB' })).toHaveAttribute('style', /#93c5fd/);
    const style20 = await page.getByRole('button', { name: '20GB' }).getAttribute('style');
    expect(style20).not.toContain('#93c5fd');
  });

  test('clicking 10GB selects it', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '10GB' }).click();
    await expect(page.getByRole('button', { name: '10GB' })).toHaveAttribute('style', /#93c5fd/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Spot Instance + Benchmark Toggles
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Deploy Settings — Toggles', () => {
  test.beforeEach(async ({ request }) => { await seedGpuProfile(request); });

  test('Spot toggle is visible and off by default', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByText('Spot')).toBeVisible();
    const toggle = page.locator('[role="switch"]').first();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  test('Benchmark on ready label is visible', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByText('Benchmark on ready')).toBeVisible();
  });

  test('enabling Spot shows "Preemptible" warning', async ({ page }) => {
    await goToDeploySettings(page);
    const spotToggle = page.locator('[role="switch"]').first();
    await spotToggle.click();
    await expect(page.getByText('Preemptible')).toBeVisible();
  });

  test('boot time estimate is shown', async ({ page }) => {
    await goToDeploySettings(page);
    await expect(page.getByText(/2.+5 min/)).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Deploy Request Payload
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Deploy Settings — Payload', () => {
  test.beforeEach(async ({ request }) => { await seedGpuProfile(request); });

  test('default deploy sends dockerImage and diskGb=20', async ({ page, request }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    await page.waitForTimeout(500);

    const resp = await request.get(`${MOCK}/mock/last-deploy`);
    const data = await resp.json();
    expect(data.lastDeployBody.dockerImage).toContain('babelcast-groq');
    expect(data.lastDeployBody.diskGb).toBe(20);
  });

  test('selecting EU region sends region in payload', async ({ page, request }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'EU' }).click();
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    await page.waitForTimeout(500);

    const resp = await request.get(`${MOCK}/mock/last-deploy`);
    const data = await resp.json();
    expect(data.lastDeployBody.region).toBe('EU');
  });

  test('selecting Asia region sends region=Asia', async ({ page, request }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'Asia' }).click();
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    await page.waitForTimeout(500);

    const resp = await request.get(`${MOCK}/mock/last-deploy`);
    const data = await resp.json();
    expect(data.lastDeployBody.region).toBe('Asia');
  });

  test('selecting 24GB VRAM sends minVramGb=24', async ({ page, request }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '24GB' }).click();
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    await page.waitForTimeout(500);

    const resp = await request.get(`${MOCK}/mock/last-deploy`);
    const data = await resp.json();
    expect(data.lastDeployBody.minVramGb).toBe(24);
  });

  test('selecting 100GB disk sends diskGb=100', async ({ page, request }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '100GB' }).click();
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    await page.waitForTimeout(500);

    const resp = await request.get(`${MOCK}/mock/last-deploy`);
    const data = await resp.json();
    expect(data.lastDeployBody.diskGb).toBe(100);
  });

  test('selecting Vast.ai provider sends provider in payload', async ({ page, request }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'Vast.ai' }).click();
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    await page.waitForTimeout(500);

    const resp = await request.get(`${MOCK}/mock/last-deploy`);
    const data = await resp.json();
    expect(data.lastDeployBody.provider).toMatch(/vast/i);
  });

  test('race ×3 sends raceCount=3', async ({ page, request }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '×3' }).click();
    await page.getByRole('button', { name: 'Race ×3' }).click();
    await page.waitForTimeout(500);

    const resp = await request.get(`${MOCK}/mock/last-deploy`);
    const data = await resp.json();
    expect(data.lastDeployBody.raceCount).toBe(3);
  });

  test('spot instance sends interruptible=true', async ({ page, request }) => {
    await goToDeploySettings(page);
    const spotToggle = page.locator('[role="switch"]').first();
    await spotToggle.click();
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    await page.waitForTimeout(500);

    const resp = await request.get(`${MOCK}/mock/last-deploy`);
    const data = await resp.json();
    expect(data.lastDeployBody.interruptible).toBe(true);
  });

  test('Any VRAM does not send minVramGb', async ({ page, request }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    await page.waitForTimeout(500);

    const resp = await request.get(`${MOCK}/mock/last-deploy`);
    const data = await resp.json();
    expect(data.lastDeployBody.minVramGb).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Combined Options
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Deploy Settings — Combined Options', () => {
  test.beforeEach(async ({ request }) => { await seedGpuProfile(request); });

  test('can configure all options and deploy with correct payload', async ({ page, request }) => {
    await goToDeploySettings(page);

    // Set: TensorDock, EU, 40GB VRAM, 50GB disk, parallel ×2
    await page.getByRole('button', { name: 'TensorDock' }).click();
    await page.getByRole('button', { name: 'EU' }).click();
    await page.getByRole('button', { name: '40GB' }).click();
    await page.getByRole('button', { name: '50GB' }).click();
    await page.getByRole('button', { name: '×2' }).click();

    // Verify UI state
    await expect(page.getByRole('button', { name: 'Race ×2' })).toBeVisible();
    await expect(page.getByText(/2 instances/)).toBeVisible();

    // Deploy
    await page.getByRole('button', { name: 'Race ×2' }).click();
    await page.waitForTimeout(500);

    const resp = await request.get(`${MOCK}/mock/last-deploy`);
    const data = await resp.json();
    expect(data.lastDeployBody.provider).toMatch(/tensordock/i);
    expect(data.lastDeployBody.region).toBe('EU');
    expect(data.lastDeployBody.minVramGb).toBe(40);
    expect(data.lastDeployBody.diskGb).toBe(50);
    expect(data.lastDeployBody.raceCount).toBe(2);
  });
});
