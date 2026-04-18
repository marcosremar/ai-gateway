// Contract test for the dynamic app registry. Replaces the hardcoded
// DOCKER_IMAGE_NAMES const (see server/app-registry.ts).

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each test uses a fresh AI_GATEWAY_HOME so the file-backed store is isolated.
let tempDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ai-gateway-reg-'));
  originalHome = process.env.AI_GATEWAY_HOME;
  process.env.AI_GATEWAY_HOME = tempDir;
  // Bust the module-level cache so `AI_GATEWAY_HOME` is re-read at import time.
  vi.resetModules();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.AI_GATEWAY_HOME;
  else process.env.AI_GATEWAY_HOME = originalHome;
});

describe('app-registry', () => {
  it('seeds the default apps on first boot', async () => {
    const { listImages } = await import('../server/app-registry');
    const images = listImages();
    const names = images.map(e => e.name);
    expect(names).toContain('wan-i2v');
    expect(names).toContain('musetalk');
    expect(names).toContain('babelcast-mistral');
    // Each seed entry must carry a boot estimate and image name.
    for (const e of images) {
      expect(e.image).toMatch(/^[a-z0-9.-]+\/[a-z0-9.-]+$/i);
      expect(e.bootEstimateS).toBeGreaterThan(0);
    }
  });

  it('registers a new app and persists it across reloads', async () => {
    const { registerImage, listImages, reloadRegistry } = await import('../server/app-registry');

    await registerImage({
      name: 'custom-model',
      image: 'acme/custom-model',
      bootEstimateS: 90,
      tags: ['custom'],
    });

    // Drop in-memory cache — force a re-read from the JSON file.
    reloadRegistry();

    const names = listImages().map(e => e.name);
    expect(names).toContain('custom-model');
  });

  it('unregisters an app', async () => {
    const { registerImage, unregisterImage, getImage } = await import('../server/app-registry');

    await registerImage({ name: 'tmp-app', image: 'acme/tmp', bootEstimateS: 60 });
    expect(getImage('tmp-app')).toBeDefined();

    const removed = await unregisterImage('tmp-app');
    expect(removed).toBe(true);
    expect(getImage('tmp-app')).toBeUndefined();
  });

  it('unregister returns false for unknown names', async () => {
    const { unregisterImage } = await import('../server/app-registry');
    expect(await unregisterImage('does-not-exist')).toBe(false);
  });

  it('bootEstimateForImage falls back to default for unknown images', async () => {
    const { bootEstimateForImage } = await import('../server/app-registry');
    // Registered image
    expect(bootEstimateForImage('marcosremar/musetalk')).toBe(300);
    // Unknown image → default 250
    expect(bootEstimateForImage('someuser/unknown-image')).toBe(250);
    // Handles :tag suffix
    expect(bootEstimateForImage('marcosremar/musetalk:v1.3.0')).toBe(300);
  });

  it('register with the same name updates in place (no duplicates)', async () => {
    const { registerImage, listImages } = await import('../server/app-registry');

    await registerImage({ name: 'dup-app', image: 'acme/v1', bootEstimateS: 30 });
    await registerImage({ name: 'dup-app', image: 'acme/v2', bootEstimateS: 60 });

    const matches = listImages().filter(e => e.name === 'dup-app');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.image).toBe('acme/v2');
    expect(matches[0]!.bootEstimateS).toBe(60);
  });

  it('getImageCatalogDynamic exposes the catalog in the legacy shape', async () => {
    const { getImageCatalogDynamic } = await import('../server/app-registry');
    const cat = getImageCatalogDynamic('v9.9.9');
    expect(cat.version).toBe('v9.9.9');
    expect(cat.images.some(i => i.endsWith(':v9.9.9'))).toBe(true);
    expect(cat.latestImages.some(i => i.endsWith(':latest'))).toBe(true);
    expect(cat.entries.length).toBeGreaterThan(0);
  });
});
