/**
 * Regression tests for three GPU deploy bugs found during 2026-05-17 triage:
 *
 *   1. CLI `gpu deploy` silently dropped the `--provider` flag, so users
 *      could not pin a deploy to a single provider; tier cascade always ran.
 *   2. The race loop substituted any Docker image with
 *      `docker/modal/babelcast.py` whenever the Modal tier ran, returning the
 *      existing babelcast Modal serve endpoint as "ready" in ~4s. Modal won
 *      the race and hijacked the user's deploy.
 *   3. Vast.ai search hardcoded `inet_down: { gte: 2000 }`, rejecting all
 *      RTX 3060 hosts (max ~1 Gbps) even when settings asked for a lower
 *      bandwidth floor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
  };
});

import {
  dropModalForDockerImage,
  filterTiers,
  type GpuTier,
} from '../../src/gpu-providers/deploy-orchestrator';
import {
  getMinInetDownMbps,
  setMinInetDownMbps,
  flushDeploySettings,
} from '../../src/gpu-providers/deploy-settings';

const makeTier = (name: GpuTier['name']): GpuTier => ({
  client: {} as never,
  name,
  label: name,
  apiKey: 'test-key',
});

describe('Bug 2 — dropModalForDockerImage (modal race hijack guard)', () => {
  const vast = makeTier('vast');
  const runpod = makeTier('runpod');
  const modal = makeTier('modal');
  const allTiers: GpuTier[] = [vast, runpod, modal];

  it('drops modal when image is a docker reference and no provider forced', () => {
    const out = dropModalForDockerImage(allTiers, 'gezp/ubuntu-desktop:22.04-cu12.2.2');
    expect(out.map(t => t.name)).toEqual(['vast', 'runpod']);
  });

  it('drops modal when image is a docker reference and provider is something else', () => {
    const out = dropModalForDockerImage(allTiers, 'marcosremar/musetalk:latest', 'vast');
    expect(out.map(t => t.name)).toEqual(['vast', 'runpod']);
  });

  it('keeps modal when image ends with .py (legitimate Modal deploy script)', () => {
    const out = dropModalForDockerImage(allTiers, 'docker/modal/babelcast.py');
    expect(out.map(t => t.name)).toEqual(['vast', 'runpod', 'modal']);
  });

  it('keeps modal when user explicitly forces provider=modal', () => {
    const out = dropModalForDockerImage(allTiers, 'whatever/image:latest', 'modal');
    expect(out.map(t => t.name)).toEqual(['vast', 'runpod', 'modal']);
  });

  it('returns the original list when modal is not present', () => {
    const out = dropModalForDockerImage([vast, runpod], 'foo/bar:latest');
    expect(out.map(t => t.name)).toEqual(['vast', 'runpod']);
  });

  it('composes correctly with filterTiers (force vast → only vast → modal-drop is a no-op)', () => {
    const filtered = filterTiers(allTiers, 'vast');
    if ('error' in filtered) throw new Error('filterTiers should have succeeded');
    const out = dropModalForDockerImage(filtered.tiers, 'foo/bar:latest', 'vast');
    expect(out.map(t => t.name)).toEqual(['vast']);
  });
});

describe('Bug 3 — minInetDownMbps deploy setting', () => {
  beforeEach(() => flushDeploySettings());

  it('has a default >= 0', () => {
    expect(getMinInetDownMbps()).toBeGreaterThanOrEqual(0);
  });

  it('default matches the documented 2000 Mbps floor', () => {
    expect(getMinInetDownMbps()).toBe(2000);
  });

  it('setMinInetDownMbps lowers the threshold to fit cheap consumer GPUs', () => {
    setMinInetDownMbps(500);
    expect(getMinInetDownMbps()).toBe(500);
  });

  it('setMinInetDownMbps clamps negative input to 0', () => {
    setMinInetDownMbps(-100);
    expect(getMinInetDownMbps()).toBe(0);
  });
});
