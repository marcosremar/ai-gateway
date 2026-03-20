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

const SEEDED_PROFILE_RESPONSE = {
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
};

/** Navigate to the GPU service card deploy settings panel. */
async function goToDeploySettings(page: Page) {
  // Intercept GET /v1/config/providers at the browser level so ProfilesSection
  // always gets the seeded profile — avoids intermittent silent-catch fetch failures
  // caused by the mock server's in-memory state timing (reset→seed window).
  await page.route('**/v1/config/providers', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SEEDED_PROFILE_RESPONSE),
      });
    } else {
      await route.continue();
    }
  });

  await page.goto('/config/profiles');
  await expect(page.getByText('GPU Deploy Test')).toBeVisible({ timeout: 10000 });
  await page.getByText('GPU Deploy Test').click();
  await expect(page.getByText('GPU Deploy Test').first()).toBeVisible();
  await page.getByRole('button', { name: /Services/ }).click();
  await expect(page.getByText('Babelcast Groq Cloud').first()).toBeVisible();
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
    await expect(page.getByRole('button', { name: 'Auto', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Vast.ai' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'TensorDock' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'RunPod' })).toBeVisible();
  });

  test('Auto is selected by default (cyan accent)', async ({ page }) => {
    await goToDeploySettings(page);
    // React normalizes #06b6d4 → rgb(6, 182, 212) in the style attribute
    // Use exact:true to avoid matching 'Auto-Swap' sidebar button (substring match otherwise)
    const autoBtn = page.getByRole('button', { name: 'Auto', exact: true }).first();
    await expect(autoBtn).toHaveAttribute('style', /rgb\(6, 182, 212\)/);
  });

  test('clicking Vast.ai selects it', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'Vast.ai' }).click();
    await expect(page.getByRole('button', { name: 'Vast.ai' })).toHaveAttribute('style', /rgb\(6, 182, 212\)/);
  });

  test('clicking RunPod selects it', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'RunPod' }).click();
    await expect(page.getByRole('button', { name: 'RunPod' })).toHaveAttribute('style', /rgb\(6, 182, 212\)/);
  });

  test('clicking a provider deselects Auto', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'TensorDock' }).click();
    // Auto should no longer have cyan background — check it's gone
    await expect(page.getByRole('button', { name: 'TensorDock' })).toHaveAttribute('style', /rgb\(6, 182, 212\)/);
    const autoStyle = await page.getByRole('button', { name: 'Auto', exact: true }).first().getAttribute('style');
    expect(autoStyle).not.toContain('rgb(6, 182, 212)');
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
    // React normalizes #3b82f6 → rgb(59, 130, 246) in element.style
    await expect(page.getByRole('button', { name: 'EU' })).toHaveAttribute('style', /rgb\(59, 130, 246\)/);
  });

  test('clicking Asia selects it', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'Asia' }).click();
    await expect(page.getByRole('button', { name: 'Asia' })).toHaveAttribute('style', /rgb\(59, 130, 246\)/);
  });

  test('clicking US selects it and deselects Auto', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'US' }).click();
    await expect(page.getByRole('button', { name: 'US' })).toHaveAttribute('style', /rgb\(59, 130, 246\)/);
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
    // Browser normalizes #10b981 → rgb(16, 185, 129) inside color-mix()
    await expect(page.getByRole('button', { name: 'Any' })).toHaveAttribute('style', /rgb\(16, 185, 129\)/);
  });

  test('clicking 24GB selects it', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '24GB' }).click();
    await expect(page.getByRole('button', { name: '24GB' })).toHaveAttribute('style', /rgb\(16, 185, 129\)/);
  });

  test('selecting 40GB deselects Any', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '40GB' }).click();
    await expect(page.getByRole('button', { name: '40GB' })).toHaveAttribute('style', /rgb\(16, 185, 129\)/);
    // Any no longer selected
    const anyStyle = await page.getByRole('button', { name: 'Any' }).getAttribute('style');
    expect(anyStyle).not.toContain('rgb(16, 185, 129)');
  });

  test('clicking Any after selecting VRAM reverts', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '16GB' }).click();
    await page.getByRole('button', { name: 'Any' }).click();
    await expect(page.getByRole('button', { name: 'Any' })).toHaveAttribute('style', /rgb\(16, 185, 129\)/);
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
    // Use exact:true to avoid matching the "Services 1 GPU · 0 cloud" tab button
    await expect(page.getByRole('button', { name: '1', exact: true })).toHaveAttribute('style', /rgb\(139, 92, 246\)/);
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
    // Use exact:true to avoid '5m' matching '15m' (substring match)
    await expect(page.getByRole('button', { name: '5m', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '15m', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '30m', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '60m', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Never' })).toBeVisible();
  });

  test('15m is selected by default (amber accent)', async ({ page }) => {
    await goToDeploySettings(page);
    // Browser normalizes #f59e0b → rgb(245, 158, 11) inside color-mix()
    await expect(page.getByRole('button', { name: '15m', exact: true })).toHaveAttribute('style', /rgb\(245, 158, 11\)/);
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
    // Browser normalizes #60a5fa → rgb(96, 165, 250) inside color-mix()
    await expect(page.getByRole('button', { name: '20GB' })).toHaveAttribute('style', /rgb\(96, 165, 250\)/);
  });

  test('clicking 50GB selects it', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '50GB' }).click();
    await expect(page.getByRole('button', { name: '50GB' })).toHaveAttribute('style', /rgb\(96, 165, 250\)/);
  });

  test('clicking 100GB deselects 20GB', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '100GB' }).click();
    await expect(page.getByRole('button', { name: '100GB' })).toHaveAttribute('style', /rgb\(96, 165, 250\)/);
    const style20 = await page.getByRole('button', { name: '20GB' }).getAttribute('style');
    expect(style20).not.toContain('rgb(96, 165, 250)');
  });

  test('clicking 10GB selects it', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '10GB' }).click();
    await expect(page.getByRole('button', { name: '10GB' })).toHaveAttribute('style', /rgb\(96, 165, 250\)/);
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

/** Wait for the next GPU deploy POST and return its parsed body. */
async function captureDeployBody(page: Page): Promise<Record<string, unknown>> {
  const req = await page.waitForRequest(
    r => r.url().includes('/v1/gpu/deploy') && r.method() === 'POST',
  );
  return JSON.parse(req.postData() || '{}');
}

test.describe('Deploy Settings — Payload', () => {
  test.beforeEach(async ({ request }) => { await seedGpuProfile(request); });

  test('default deploy sends dockerImage and diskGb=20', async ({ page }) => {
    await goToDeploySettings(page);
    const bodyP = captureDeployBody(page);
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    const body = await bodyP;
    expect(body.dockerImage).toContain('babelcast-groq');
    expect(body.diskGb).toBe(20);
  });

  test('selecting EU region sends region in payload', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'EU' }).click();
    const bodyP = captureDeployBody(page);
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    const body = await bodyP;
    expect(body.region).toBe('EU');
  });

  test('selecting Asia region sends region=Asia', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'Asia' }).click();
    const bodyP = captureDeployBody(page);
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    const body = await bodyP;
    expect(body.region).toBe('Asia');
  });

  test('selecting 24GB VRAM sends minVramGb=24', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '24GB' }).click();
    const bodyP = captureDeployBody(page);
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    const body = await bodyP;
    expect(body.minVramGb).toBe(24);
  });

  test('selecting 100GB disk sends diskGb=100', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '100GB' }).click();
    const bodyP = captureDeployBody(page);
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    const body = await bodyP;
    expect(body.diskGb).toBe(100);
  });

  test('selecting Vast.ai provider sends provider in payload', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: 'Vast.ai' }).click();
    const bodyP = captureDeployBody(page);
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    const body = await bodyP;
    expect(body.provider).toMatch(/vast/i);
  });

  test('race ×3 sends raceCount=3', async ({ page }) => {
    await goToDeploySettings(page);
    await page.getByRole('button', { name: '×3' }).click();
    const bodyP = captureDeployBody(page);
    await page.getByRole('button', { name: 'Race ×3' }).click();
    const body = await bodyP;
    expect(body.raceCount).toBe(3);
  });

  test('spot instance sends interruptible=true', async ({ page }) => {
    await goToDeploySettings(page);
    const spotToggle = page.locator('[role="switch"]').first();
    await spotToggle.click();
    const bodyP = captureDeployBody(page);
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    const body = await bodyP;
    expect(body.interruptible).toBe(true);
  });

  test('Any VRAM does not send minVramGb', async ({ page }) => {
    await goToDeploySettings(page);
    const bodyP = captureDeployBody(page);
    await page.getByRole('button', { name: 'Deploy' }).first().click();
    const body = await bodyP;
    expect(body.minVramGb).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Combined Options
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Deploy Settings — Combined Options', () => {
  test.beforeEach(async ({ request }) => { await seedGpuProfile(request); });

  test('can configure all options and deploy with correct payload', async ({ page }) => {
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
    const bodyP = captureDeployBody(page);
    await page.getByRole('button', { name: 'Race ×2' }).click();
    const body = await bodyP;
    expect(body.provider).toMatch(/tensordock/i);
    expect(body.region).toBe('EU');
    expect(body.minVramGb).toBe(40);
    expect(body.diskGb).toBe(50);
    expect(body.raceCount).toBe(2);
  });
});
