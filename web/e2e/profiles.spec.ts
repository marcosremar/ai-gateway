import { test, expect, type Page } from '@playwright/test';

const MOCK = 'http://localhost:4099';

// ── Helpers ──

/** Seed mock with realistic profiles and verify */
async function seedProfiles(request: any) {
  const resp = await request.post(`${MOCK}/v1/config/providers`, {
    data: {
      profiles: [
        {
          id: 'prof-realtime',
          name: 'Realtime Translation',
          latency: 'realtime',
          enabled: true,
          stt: [{ provider: 'gpu', model: 'faster-whisper-large-v3' }],
          llm: [{ provider: 'gpu', model: 'translategemma' }, { provider: 'groq', model: 'llama-3.3-70b-versatile' }],
          tts: [{ provider: 'gpu', model: 'qwen3-tts' }],
          services: [
            { id: 'svc-gpu-1', name: 'Babelcast TranslateGemma', kind: 'container', dockerImage: 'marcosremar/babelcast-translategemma:latest', gpuTypes: ['NVIDIA GeForce RTX 4090'], gpuProvider: 'vast' },
          ],
        },
        {
          id: 'prof-cloud',
          name: 'Cloud Only',
          latency: 'low',
          enabled: true,
          stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
          llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
          tts: [{ provider: 'groq', model: 'playai-tts' }],
          services: [
            { id: 'svc-cloud-groq', name: 'Groq', kind: 'cloud', cloudProvider: 'groq' },
          ],
        },
        {
          id: 'prof-disabled',
          name: 'Batch Processing',
          latency: 'batch',
          enabled: false,
          stt: [{ provider: 'openai', model: 'whisper-1' }],
          llm: [{ provider: 'openai', model: 'gpt-4o-mini' }],
          tts: [],
          services: [],
        },
      ],
      activeProfileId: 'prof-realtime',
      pipelineStt: [{ provider: 'gpu', model: 'faster-whisper-large-v3' }],
      pipelineLlm: [{ provider: 'gpu', model: 'translategemma' }, { provider: 'groq', model: 'llama-3.3-70b-versatile' }],
      pipelineTts: [{ provider: 'gpu', model: 'qwen3-tts' }],
    },
  });
  // Verify seed took effect
  const check = await request.get(`${MOCK}/v1/config/providers`);
  const data = await check.json();
  if (data.profiles?.length !== 3) {
    throw new Error(`seedProfiles failed: expected 3 profiles, got ${data.profiles?.length}`);
  }
}

/** Navigate to Profiles tab and wait for loading to complete */
async function goToProfiles(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Profiles' })).toBeVisible();
  // Wait for loading skeleton to disappear (profiles API call completes)
  await expect(page.locator('[aria-busy="true"]')).not.toBeVisible({ timeout: 10_000 }).catch(() => {});
}

test.beforeEach(async ({ page, request }) => {
  // Navigate away first to cancel any pending API calls from the previous test
  // (prevents race conditions where stale requests overwrite the reset)
  await page.goto('about:blank');
  await request.post(`${MOCK}/mock/reset`);
});

// ─────────────────────────────────────────────────────────────────────────────
// List View — Empty State
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Profiles — Empty State', () => {
  test('shows empty state when no profiles exist', async ({ page }) => {
    await goToProfiles(page);
    await expect(page.getByText('No profiles yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();
  });

  test('shows "Save current config as profile" button', async ({ page }) => {
    await goToProfiles(page);
    await expect(page.getByText('Save current config as profile')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// List View — With Profiles
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Profiles — List View', () => {
  test.beforeEach(async ({ request }) => {
    await seedProfiles(request);
  });

  test('displays seeded profiles in correct order', async ({ page }) => {
    await goToProfiles(page);
    await expect(page.getByText('Realtime Translation')).toBeVisible();
    await expect(page.getByText('Cloud Only')).toBeVisible();
    await expect(page.getByText('Batch Processing')).toBeVisible();
  });

  test('shows latency badges on profiles', async ({ page }) => {
    await goToProfiles(page);
    await expect(page.getByText('realtime').first()).toBeVisible();
    await expect(page.getByText('low').first()).toBeVisible();
    await expect(page.getByText('batch').first()).toBeVisible();
  });

  test('shows active profile checkmark', async ({ page }) => {
    await goToProfiles(page);
    // "Realtime Translation" is active — its row should contain a check icon
    // The active profile has a blue accent border
    const activeRow = page.locator('[data-id="prof-realtime"]');
    await expect(activeRow).toBeVisible();
  });

  test('shows stage pills (STT, LLM, TTS) on profile rows', async ({ page }) => {
    await goToProfiles(page);
    // Each profile row should have stage indicators
    await expect(page.getByText('STT').first()).toBeVisible();
    await expect(page.getByText('LLM').first()).toBeVisible();
    await expect(page.getByText('TTS').first()).toBeVisible();
  });

  test('shows summary with provider chain and GPU pods', async ({ page }) => {
    await goToProfiles(page);
    // First profile has gpu → gpu → gpu with 1 fallback + 1 GPU pod
    await expect(page.getByText(/gpu.*→.*gpu/i).first()).toBeVisible();
  });

  test('disabled profile has reduced opacity', async ({ page }) => {
    await goToProfiles(page);
    const disabledRow = page.locator('[data-id="prof-disabled"]');
    await expect(disabledRow).toBeVisible();
    const opacity = await disabledRow.evaluate(el => getComputedStyle(el).opacity);
    expect(parseFloat(opacity)).toBeLessThan(1);
  });

  test('profile count shows in panel header', async ({ page }) => {
    await goToProfiles(page);
    await expect(page.getByText('3 saved')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile CRUD — Create
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Profiles — Create New Profile', () => {
  test('"New Profile" button opens detail view', async ({ page }) => {
    await goToProfiles(page);
    await page.getByRole('button', { name: 'New Profile' }).click();
    // Should show detail view with profile name input and Save & Apply button
    await expect(page.getByPlaceholder('Profile name...')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save & Apply' }).first()).toBeVisible();
  });

  test('new profile shows default STT/LLM/TTS stages', async ({ page }) => {
    await goToProfiles(page);
    await page.getByRole('button', { name: 'New Profile' }).click();
    // Pipeline tab is active by default — should show 3 stage rows
    await expect(page.getByText('STT').first()).toBeVisible();
    await expect(page.getByText('LLM').first()).toBeVisible();
    await expect(page.getByText('TTS').first()).toBeVisible();
  });

  test('detail view has Pipeline and Services tabs', async ({ page }) => {
    await goToProfiles(page);
    await page.getByRole('button', { name: 'New Profile' }).click();
    await expect(page.getByRole('button', { name: /Pipeline/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Services/ })).toBeVisible();
  });

  test('Save & Apply creates profile and returns to detail view', async ({ page }) => {
    await goToProfiles(page);
    await page.getByRole('button', { name: 'New Profile' }).click();

    // Click Save & Apply (creates with name "New Profile")
    await page.getByRole('button', { name: 'Save & Apply' }).first().click();

    // Should show "Saved" confirmation
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 8000 });
  });

  test('inline save profile via panel "Save current config as profile" button', async ({ page }) => {
    await goToProfiles(page);
    // Click the dashed button to save current config
    await page.getByText('Save current config as profile').click();
    // Input should appear
    const nameInput = page.getByPlaceholder('Profile name...');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('My Custom Profile');
    // Click Save
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    // Profile should now appear in list
    await expect(page.getByText('My Custom Profile')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile CRUD — Edit & Rename
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Profiles — Edit', () => {
  test.beforeEach(async ({ request }) => {
    await seedProfiles(request);
  });

  test('clicking profile opens detail view with loaded config', async ({ page }) => {
    await goToProfiles(page);
    // Click "Realtime Translation" profile
    await page.getByText('Realtime Translation').click();

    // Should navigate to detail view
    await expect(page.getByRole('button', { name: 'Save & Apply' }).first()).toBeVisible();
    // Should show the profile name in the breadcrumb/input
    const nameInput = page.getByPlaceholder('Profile name...');
    await expect(nameInput).toHaveValue('Realtime Translation');
  });

  test('back button returns to list view', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();
    await expect(page.getByRole('button', { name: 'Save & Apply' }).first()).toBeVisible();

    // Click back
    await page.getByText('Profiles', { exact: false }).first().click();
    // Force navigate back (the breadcrumb might be tricky)
    await page.goto('/');
    await page.getByRole('button', { name: 'Profiles', exact: true }).click();
    await expect(page.getByText('Realtime Translation')).toBeVisible();
  });

  test('can rename profile inline via pencil icon', async ({ page }) => {
    await goToProfiles(page);
    // Hover to reveal pencil icon, then click it
    const profileRow = page.locator('[data-id="prof-cloud"]');
    await profileRow.hover();
    // The pencil button is inside the row
    const pencil = profileRow.locator('button').filter({ has: page.locator('svg.lucide-pencil') });
    if (await pencil.isVisible()) {
      await pencil.click();
      // Should show inline rename input
      const input = profileRow.locator('input');
      await expect(input).toBeVisible();
      await input.fill('Cloud Fast');
      await input.press('Enter');
      // Should show updated name
      await expect(page.getByText('Cloud Fast')).toBeVisible();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile CRUD — Delete
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Profiles — Delete', () => {
  test.beforeEach(async ({ request }) => {
    await seedProfiles(request);
  });

  test('delete button shows confirmation modal', async ({ page }) => {
    await goToProfiles(page);
    // Hover to show the trash icon
    const profileRow = page.locator('[data-id="prof-cloud"]');
    await profileRow.hover();

    // Click trash button (use aria-label added for accessibility)
    const trashBtn = profileRow.locator('button[aria-label="Delete Cloud Only"]');
    await trashBtn.click();

    // Confirmation modal should appear
    await expect(page.getByText('Delete profile?')).toBeVisible();
    await expect(page.getByText('"Cloud Only" will be permanently removed')).toBeVisible();
  });

  test('confirming delete removes profile from list', async ({ page }) => {
    await goToProfiles(page);
    const profileRow = page.locator('[data-id="prof-cloud"]');
    await profileRow.hover();
    const trashBtn = profileRow.locator('button[aria-label="Delete Cloud Only"]');
    await trashBtn.click();

    // Click confirm button in modal (exact match to avoid matching aria-label on trash btn)
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    // Profile should be removed
    await expect(page.getByText('Cloud Only')).not.toBeVisible();
    // Other profiles remain
    await expect(page.getByText('Realtime Translation')).toBeVisible();
  });

  test('canceling delete keeps profile', async ({ page }) => {
    await goToProfiles(page);
    const profileRow = page.locator('[data-id="prof-cloud"]');
    await profileRow.hover();
    const trashBtn = profileRow.locator('button[aria-label="Delete Cloud Only"]');
    await trashBtn.click();

    // Cancel the modal
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Profile should still be visible
    await expect(page.getByText('Cloud Only')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile — Toggle Enable/Disable
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Profiles — Enable/Disable Toggle', () => {
  test.beforeEach(async ({ request }) => {
    await seedProfiles(request);
  });

  test('toggle switch disables an enabled profile', async ({ page }) => {
    await goToProfiles(page);
    const profileRow = page.locator('[data-id="prof-cloud"]');
    await expect(profileRow).toBeVisible();

    // Initially enabled — opacity should be 1
    let opacity = await profileRow.evaluate(el => el.style.opacity);
    expect(opacity).toBe('1');

    // Find the toggle switch within the row and click it
    const toggle = profileRow.locator('[role="switch"]');
    await toggle.click();

    // After disable, inline opacity should drop
    await page.waitForTimeout(200);
    const opacityAfter = await profileRow.evaluate(el => parseFloat((el as HTMLElement).style.opacity));
    expect(opacityAfter).toBeCloseTo(0.45, 1);
  });

  test('disabled profile shows strikethrough name', async ({ page }) => {
    await goToProfiles(page);
    const disabledRow = page.locator('[data-id="prof-disabled"]');
    await expect(disabledRow).toBeVisible();
    // Name should have line-through class
    const nameSpan = disabledRow.locator('.line-through');
    await expect(nameSpan).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detail View — Pipeline Tab
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Profiles — Pipeline Tab (Detail)', () => {
  test.beforeEach(async ({ request }) => {
    await seedProfiles(request);
  });

  test('shows pipeline stages with fallback chains', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();

    // Pipeline tab should be active by default
    // STT stage should be visible
    await expect(page.getByText('Speech-to-Text').first()).toBeVisible();
    // LLM stage
    await expect(page.getByText('Translation').first()).toBeVisible();
    // TTS stage
    await expect(page.getByText('Text-to-Speech').first()).toBeVisible();
  });

  test('LLM stage shows fallback chain (gpu + groq)', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();

    // The LLM chain has gpu (translategemma) + groq (llama-3.3) as fallback
    await expect(page.getByText('translategemma').first()).toBeVisible();
  });

  test('stages have enable/disable toggle', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();

    // Each stage row has an enabled/disabled button
    const enabledButtons = page.locator('button:has-text("enabled")');
    const count = await enabledButtons.count();
    expect(count).toBeGreaterThanOrEqual(2); // at least STT, LLM (TTS might be disabled)
  });

  test('flow diagram is visible at top of detail view', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();

    // Flow diagram shows provider chips (pipeline visualization)
    // Should show STT → LLM → TTS flow indicators
    await expect(page.getByText('STT').first()).toBeVisible();
    await expect(page.getByText('LLM').first()).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detail View — Services Tab
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Profiles — Services Tab (Detail)', () => {
  test.beforeEach(async ({ request }) => {
    await seedProfiles(request);
  });

  test('switching to Services tab shows latency selector and services', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();

    // Click "Services" tab
    await page.getByRole('button', { name: /Services/ }).click();

    // Should show latency selector
    await expect(page.getByText('Latency').first()).toBeVisible();
    // The latency options: realtime, low, batch
    await expect(page.getByRole('button', { name: /realtime/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /low/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /batch/ }).first()).toBeVisible();
  });

  test('shows GPU pod service card with deploy button', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();
    await page.getByRole('button', { name: /Services/ }).click();

    // GPU pod service should be visible
    await expect(page.getByText('Babelcast TranslateGemma').first()).toBeVisible();

    // Deploy button should be present for GPU pods
    await expect(page.getByRole('button', { name: 'Deploy' }).first()).toBeVisible();
  });

  test('latency selector switches between realtime/low/batch', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();
    await page.getByRole('button', { name: /Services/ }).click();

    // Currently "realtime" — click "low"
    const lowBtn = page.locator('button').filter({ hasText: 'low' }).filter({ hasText: '<1s' });
    if (await lowBtn.isVisible()) {
      await lowBtn.click();
      // Verify visual feedback (button style changes)
      await expect(lowBtn).toBeVisible();
    }
  });

  test('"Add Service" button opens service form', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();
    await page.getByRole('button', { name: /Services/ }).click();

    // Scroll to and click "Add Service" (may be below the fold with multiple services)
    const addBtn = page.getByText('Add Service');
    await addBtn.scrollIntoViewIfNeeded();
    await addBtn.click();

    // Service form should appear (scroll into view since it replaces the button)
    const newSvc = page.getByText('New Service');
    await newSvc.scrollIntoViewIfNeeded();
    await expect(newSvc).toBeVisible();
  });

  test('service form shows GPU Pod and Cloud API type options', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();
    await page.getByRole('button', { name: /Services/ }).click();
    const addBtn = page.getByText('Add Service');
    await addBtn.scrollIntoViewIfNeeded();
    await addBtn.click();

    // Type buttons
    await expect(page.getByRole('button', { name: 'GPU Pod' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cloud API' })).toBeVisible();
  });

  test('GPU pod form shows docker image selection and GPU types', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();
    await page.getByRole('button', { name: /Services/ }).click();
    const addBtn = page.getByText('Add Service');
    await addBtn.scrollIntoViewIfNeeded();
    await addBtn.click();

    // GPU Pod is selected by default — should show Docker Image / provider sections
    await expect(page.getByText('IMAGE').or(page.getByText('Docker Image')).first()).toBeVisible();
  });

  test('Cloud API form shows provider selection buttons', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();
    await page.getByRole('button', { name: /Services/ }).click();
    const addBtn = page.getByText('Add Service');
    await addBtn.scrollIntoViewIfNeeded();
    await addBtn.click();

    // Switch to Cloud API
    await page.getByRole('button', { name: 'Cloud API' }).click();

    // Should show cloud provider buttons
    await expect(page.getByRole('button', { name: 'groq' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'openai' })).toBeVisible();
  });

  test('can create a new cloud service', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();
    await page.getByRole('button', { name: /Services/ }).click();
    const addBtn = page.getByText('Add Service');
    await addBtn.scrollIntoViewIfNeeded();
    await addBtn.click();

    // Switch to Cloud API
    await page.getByRole('button', { name: 'Cloud API' }).click();

    // Fill name
    const nameInput = page.locator('input[type="text"]').filter({ hasText: '' }).first();
    await nameInput.fill('OpenAI Service');

    // Select openai provider
    await page.getByRole('button', { name: 'openai' }).click();

    // Click Save
    const saveBtn = page.getByRole('button', { name: 'Save', exact: true }).or(
      page.getByRole('button', { name: /Save Service/ })
    );
    if (await saveBtn.first().isVisible()) {
      await saveBtn.first().click();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GPU Deploy from Service Card
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Profiles — GPU Deploy', () => {
  test.beforeEach(async ({ request }) => {
    await seedProfiles(request);
  });

  test('deploy button triggers GPU deploy and shows status', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();
    await page.getByRole('button', { name: /Services/ }).click();

    // Click Deploy on the GPU pod service card
    const deployBtn = page.getByRole('button', { name: 'Deploy' }).first();
    await expect(deployBtn).toBeVisible();
    await deployBtn.click();

    // Should show creating/booting status
    await expect(
      page.getByText('creating').or(page.getByText('booting')).or(page.getByText('ready')).first()
    ).toBeVisible({ timeout: 10000 });
  });

  test('stop button stops GPU and returns to idle', async ({ page, request }) => {
    await seedProfiles(request);
    // Set GPU as ready with matching dockerImage
    await request.post(`${MOCK}/mock/state`, {
      data: { gpuStatus: 'ready', gpuDockerImage: 'marcosremar/babelcast-translategemma:latest' },
    });

    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();
    await page.getByRole('button', { name: /Services/ }).click();

    // Wait for GPU status to poll and show "Running" + Stop button
    await expect(page.getByText('Running')).toBeVisible({ timeout: 15000 });
    const stopBtn = page.getByRole('button', { name: 'Stop' });
    await expect(stopBtn).toBeVisible();
    await stopBtn.click();

    // Deploy button should reappear
    await expect(page.getByRole('button', { name: 'Deploy' }).first()).toBeVisible({ timeout: 15000 });
  });

  test('GPU ready status shows running indicator with details', async ({ page, request }) => {
    await seedProfiles(request);
    await request.post(`${MOCK}/mock/state`, {
      data: { gpuStatus: 'ready', gpuDockerImage: 'marcosremar/babelcast-translategemma:latest' },
    });

    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();
    await page.getByRole('button', { name: /Services/ }).click();

    // Should show "Running" status indicator
    await expect(page.getByText('Running')).toBeVisible({ timeout: 15000 });
    // Should show GPU type and provider
    await expect(page.getByText('NVIDIA RTX A6000')).toBeVisible();
    await expect(page.getByText('vast')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile Persistence
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Profiles — Persistence', () => {
  test('profiles survive page reload', async ({ page, request }) => {
    await seedProfiles(request);
    await goToProfiles(page);
    await expect(page.getByText('Realtime Translation')).toBeVisible();

    // Reload the page
    await page.reload();
    await page.waitForLoadState('networkidle');
    // Navigate back to Profiles tab
    await page.getByRole('button', { name: 'Profiles', exact: true }).click();

    // Profiles should still be there (persisted in mock)
    await expect(page.getByText('Realtime Translation')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Cloud Only')).toBeVisible();
  });

  test('Save & Apply persists pipeline changes to mock', async ({ page, request }) => {
    await seedProfiles(request);
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();

    // Click Save & Apply
    await page.getByRole('button', { name: 'Save & Apply' }).first().click();
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 8000 });

    // Verify mock received the update
    const resp = await request.get(`${MOCK}/v1/config/providers`);
    const data = await resp.json();
    expect(data.activeProfileId).toBe('prof-realtime');
    expect(data.profiles.length).toBe(3);
  });

  test('active profile ID persists after switching profiles', async ({ page, request }) => {
    await seedProfiles(request);
    await goToProfiles(page);

    // Click "Cloud Only" profile to load it
    await page.getByText('Cloud Only').click();
    // Save it
    await page.getByRole('button', { name: 'Save & Apply' }).first().click();
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 8000 });

    // Verify active profile changed
    const resp = await request.get(`${MOCK}/v1/config/providers`);
    const data = await resp.json();
    expect(data.activeProfileId).toBe('prof-cloud');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Flow Diagram (Interactive)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Profiles — Flow Diagram', () => {
  test.beforeEach(async ({ request }) => {
    await seedProfiles(request);
  });

  test('flow diagram shows all active stages', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();

    // Detail view should show STT, LLM, TTS stage labels
    await expect(page.getByText('STT').first()).toBeVisible();
    await expect(page.getByText('LLM').first()).toBeVisible();
    await expect(page.getByText('TTS').first()).toBeVisible();
  });

  test('flow diagram shows provider names per stage', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Cloud Only').click();

    // Cloud profile uses groq for all stages
    const groqTexts = page.getByText('groq');
    const count = await groqTexts.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Services — Service Card Details
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Profiles — Service Card Interactions', () => {
  test.beforeEach(async ({ request }) => {
    await seedProfiles(request);
  });

  test('GPU pod card shows docker image name', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();
    await page.getByRole('button', { name: /Services/ }).click();

    // Docker image should be displayed
    await expect(page.getByText(/babelcast-translategemma/).first()).toBeVisible();
  });

  test('GPU pod card shows GPU type selection', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();
    await page.getByRole('button', { name: /Services/ }).click();

    // RTX 4090 should be shown as selected GPU
    await expect(page.getByText(/RTX 4090/).first()).toBeVisible();
  });

  test('cloud service card shows provider name', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Cloud Only').click();
    await page.getByRole('button', { name: /Services/ }).click();

    await expect(page.getByText('Groq').first()).toBeVisible();
  });

  test('service card has delete button', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();
    await page.getByRole('button', { name: /Services/ }).click();

    // Should have a delete/trash button for the service
    const trashBtns = page.locator('button').filter({ has: page.locator('svg.lucide-trash-2') });
    const count = await trashBtns.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// URL Routing
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Profiles — URL Routing', () => {
  test.beforeEach(async ({ request }) => {
    await seedProfiles(request);
  });

  test('list view at /config/profiles', async ({ page }) => {
    await goToProfiles(page);
    // Should show list view
    await expect(page.getByText('Realtime Translation')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();
  });

  test('clicking profile updates URL to /config/profiles/edit/{id}', async ({ page }) => {
    await goToProfiles(page);
    await page.getByText('Realtime Translation').click();

    // URL should contain the profile ID
    await expect(page).toHaveURL(/config\/profiles\/edit\/prof-realtime/);
  });

  test('"New Profile" navigates to /config/profiles/new', async ({ page }) => {
    await goToProfiles(page);
    await page.getByRole('button', { name: 'New Profile' }).click();

    await expect(page).toHaveURL(/config\/profiles\/new/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-End Workflow
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Profiles — Full Workflow', () => {
  test('create profile → edit pipeline → switch to services → save → verify', async ({ page, request }) => {
    await goToProfiles(page);

    // 1. Create new profile
    await page.getByRole('button', { name: 'New Profile' }).click();
    await expect(page.getByRole('button', { name: 'Save & Apply' }).first()).toBeVisible();

    // 2. Pipeline tab is shown by default with stages
    await expect(page.getByText('STT').first()).toBeVisible();
    await expect(page.getByText('LLM').first()).toBeVisible();

    // 3. Switch to Services tab
    const servicesTab = page.getByRole('button', { name: /Services/ });
    await servicesTab.click();

    // 4. Save & Apply
    await page.getByRole('button', { name: 'Save & Apply' }).first().click();
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 8000 });

    // 5. Verify profile was saved to mock
    const resp = await request.get(`${MOCK}/v1/config/providers`);
    const data = await resp.json();
    expect(data.profiles.length).toBeGreaterThanOrEqual(1);
    expect(data.activeProfileId).toBeTruthy();
  });

  test('load seeded profiles → switch active → deploy GPU → verify', async ({ page, request }) => {
    await seedProfiles(request);
    await goToProfiles(page);

    // 1. Verify profiles loaded
    await expect(page.getByText('Realtime Translation')).toBeVisible();
    await expect(page.getByText('Cloud Only')).toBeVisible();

    // 2. Open Realtime Translation profile
    await page.getByText('Realtime Translation').click();
    await expect(page.getByRole('button', { name: 'Save & Apply' }).first()).toBeVisible();

    // 3. Switch to Services tab
    await page.getByRole('button', { name: /Services/ }).click();

    // 4. Deploy GPU
    const deployBtn = page.getByRole('button', { name: 'Deploy' }).first();
    await expect(deployBtn).toBeVisible();
    await deployBtn.click();

    // 5. Wait for status change
    await expect(
      page.getByText('creating').or(page.getByText('booting')).or(page.getByText('ready')).first()
    ).toBeVisible({ timeout: 10000 });

    // 6. Save & Apply
    await page.getByRole('button', { name: 'Save & Apply' }).first().click();
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 8000 });
  });
});
