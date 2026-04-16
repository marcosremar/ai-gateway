/**
 * Config — Docker Image Resolution & Catalog Tests
 *
 * Tests resolveDockerImageForGpus, getImageCatalog, and STANDARD_TO_BLACKWELL
 * mapping. Covers Blackwell swap logic, universal images (no swap), mixed GPU
 * lists, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveDockerImageForGpus,
  getImageCatalog,
  DOCKER_IMAGE_NAMES,
  DOCKER_IMAGE_VERSION,
  STANDARD_TO_BLACKWELL,
  BLACKWELL_TO_STANDARD,
} from '../server/config';

// ── resolveDockerImageForGpus ───────────────────────────────────────────────

describe('resolveDockerImageForGpus', () => {
  // ── Blackwell swap (only mistral has a mapping) ─────────────────────────

  it('swaps mistral:latest to blackwell variant for RTX 5090', () => {
    const result = resolveDockerImageForGpus(
      'marcosremar/babelcast-mistral:latest',
      ['NVIDIA GeForce RTX 5090'],
    );
    expect(result).toBe('marcosremar/babelcast-blackwell-mistral:latest');
  });

  it('swaps mistral versioned tag for RTX 5090', () => {
    const result = resolveDockerImageForGpus(
      `marcosremar/babelcast-mistral:${DOCKER_IMAGE_VERSION}`,
      ['NVIDIA GeForce RTX 5090'],
    );
    expect(result).toBe(`marcosremar/babelcast-blackwell-mistral:${DOCKER_IMAGE_VERSION}`);
  });

  it('swaps for all Blackwell GPU variants', () => {
    const blackwellGpus = ['RTX 5090', 'RTX 5080', 'RTX 5070 Ti', 'RTX 5070', 'RTX 5060 Ti', 'RTX 5060'];
    for (const gpu of blackwellGpus) {
      const result = resolveDockerImageForGpus(
        'marcosremar/babelcast-mistral:latest',
        [`NVIDIA GeForce ${gpu}`],
      );
      expect(result).toBe('marcosremar/babelcast-blackwell-mistral:latest');
    }
  });

  // ── Universal images (no swap needed) ───────────────────────────────────

  it('does NOT swap babelcast-subtitle for Blackwell (universal image)', () => {
    const result = resolveDockerImageForGpus(
      'marcosremar/babelcast-subtitle:latest',
      ['NVIDIA GeForce RTX 5090'],
    );
    expect(result).toBe('marcosremar/babelcast-subtitle:latest');
  });

  it('does NOT swap babelcast-translategemma for Blackwell', () => {
    const result = resolveDockerImageForGpus(
      'marcosremar/babelcast-translategemma:latest',
      ['NVIDIA GeForce RTX 5090'],
    );
    expect(result).toBe('marcosremar/babelcast-translategemma:latest');
  });

  it('does NOT swap babelcast-groq for Blackwell', () => {
    const result = resolveDockerImageForGpus(
      'marcosremar/babelcast-groq:latest',
      ['NVIDIA GeForce RTX 5090'],
    );
    expect(result).toBe('marcosremar/babelcast-groq:latest');
  });

  // ── Non-Blackwell GPUs (no swap ever) ──────────────────────────────────

  it('passes through for RTX 4090 (Ada)', () => {
    const result = resolveDockerImageForGpus(
      'marcosremar/babelcast-mistral:latest',
      ['NVIDIA GeForce RTX 4090'],
    );
    expect(result).toBe('marcosremar/babelcast-mistral:latest');
  });

  it('passes through for A100', () => {
    const result = resolveDockerImageForGpus(
      'marcosremar/babelcast-mistral:latest',
      ['NVIDIA A100-SXM4-80GB'],
    );
    expect(result).toBe('marcosremar/babelcast-mistral:latest');
  });

  // ── Mixed GPU lists ────────────────────────────────────────────────────

  it('uses PRIMARY (first) GPU for swap decision — Blackwell first → swap', () => {
    const result = resolveDockerImageForGpus(
      'marcosremar/babelcast-mistral:latest',
      ['NVIDIA GeForce RTX 5090', 'NVIDIA GeForce RTX 4090'],
    );
    expect(result).toBe('marcosremar/babelcast-blackwell-mistral:latest');
  });

  it('uses PRIMARY GPU — non-Blackwell first → no swap', () => {
    const result = resolveDockerImageForGpus(
      'marcosremar/babelcast-mistral:latest',
      ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 5090'],
    );
    expect(result).toBe('marcosremar/babelcast-mistral:latest');
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it('handles empty gpuTypes array', () => {
    const result = resolveDockerImageForGpus('marcosremar/babelcast-mistral:latest', []);
    expect(result).toBe('marcosremar/babelcast-mistral:latest');
  });

  it('handles unknown docker image with Blackwell GPU', () => {
    const result = resolveDockerImageForGpus('unknown/image:latest', ['NVIDIA GeForce RTX 5090']);
    expect(result).toBe('unknown/image:latest');
  });

  it('handles empty string GPU type', () => {
    const result = resolveDockerImageForGpus('marcosremar/babelcast-mistral:latest', ['']);
    expect(result).toBe('marcosremar/babelcast-mistral:latest');
  });

  it('is case-sensitive on GPU name matching', () => {
    // "rtx 5090" lowercase should NOT match
    const result = resolveDockerImageForGpus(
      'marcosremar/babelcast-mistral:latest',
      ['NVIDIA GeForce rtx 5090'],
    );
    expect(result).toBe('marcosremar/babelcast-mistral:latest');
  });
});

// ── STANDARD_TO_BLACKWELL / BLACKWELL_TO_STANDARD ───────────────────────────

describe('Blackwell image maps', () => {
  it('STANDARD_TO_BLACKWELL has only mistral entries', () => {
    const keys = Object.keys(STANDARD_TO_BLACKWELL);
    expect(keys.length).toBe(2);
    expect(keys.every(k => k.includes('babelcast-mistral'))).toBe(true);
  });

  it('BLACKWELL_TO_STANDARD is the inverse of STANDARD_TO_BLACKWELL', () => {
    for (const [std, bw] of Object.entries(STANDARD_TO_BLACKWELL)) {
      expect(BLACKWELL_TO_STANDARD[bw]).toBe(std);
    }
  });

  it('babelcast-subtitle is NOT in STANDARD_TO_BLACKWELL (universal image)', () => {
    const hasSubtitle = Object.keys(STANDARD_TO_BLACKWELL).some(k => k.includes('subtitle'));
    expect(hasSubtitle).toBe(false);
  });
});

// ── getImageCatalog ─────────────────────────────────────────────────────────

describe('getImageCatalog', () => {
  it('returns version and image lists', () => {
    const catalog = getImageCatalog();
    expect(catalog.version).toBe(DOCKER_IMAGE_VERSION);
    expect(catalog.images.length).toBe(DOCKER_IMAGE_NAMES.length);
    expect(catalog.latestImages.length).toBe(DOCKER_IMAGE_NAMES.length);
  });

  it('versioned images use DOCKER_IMAGE_VERSION tag', () => {
    const catalog = getImageCatalog();
    for (const img of catalog.images) {
      expect(img).toMatch(new RegExp(`:${DOCKER_IMAGE_VERSION}$`));
    }
  });

  it('latest images use :latest tag', () => {
    const catalog = getImageCatalog();
    for (const img of catalog.latestImages) {
      expect(img).toMatch(/:latest$/);
    }
  });

  it('includes babelcast-subtitle in catalog', () => {
    const catalog = getImageCatalog();
    expect(catalog.latestImages).toContain('marcosremar/babelcast-subtitle:latest');
  });
});

// ── DOCKER_IMAGE_NAMES ──────────────────────────────────────────────────────

describe('DOCKER_IMAGE_NAMES', () => {
  it('includes babelcast-subtitle', () => {
    expect(DOCKER_IMAGE_NAMES).toContain('marcosremar/babelcast-subtitle');
  });

  it('all names follow marcosremar/* pattern', () => {
    for (const name of DOCKER_IMAGE_NAMES) {
      expect(name).toMatch(/^marcosremar\//);
    }
  });

  it('has no duplicate entries', () => {
    const unique = new Set(DOCKER_IMAGE_NAMES);
    expect(unique.size).toBe(DOCKER_IMAGE_NAMES.length);
  });
});
