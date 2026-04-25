import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProviderCooldownTracker, PROVIDER_LABELS } from '../../src/gpu-providers/deploy-orchestrator';

describe('ProviderCooldownTracker', () => {
  let tracker: ProviderCooldownTracker;

  beforeEach(() => {
    tracker = new ProviderCooldownTracker();
  });

  it('constructs with default values', () => {
    expect(tracker).toBeDefined();
    expect(tracker.getFailCount('runpod')).toBe(0);
    expect(tracker.isCoolingDown('runpod')).toBe(false);
  });

  it('recordFailure → isInCooldown returns true', async () => {
    await tracker.recordFailure('runpod');
    expect(tracker.isCoolingDown('runpod')).toBe(true);
    expect(tracker.getFailCount('runpod')).toBe(1);
  });

  it('markSuccess resets fail count and clears cooldown', async () => {
    await tracker.recordFailure('runpod');
    await tracker.recordFailure('runpod');
    expect(tracker.isCoolingDown('runpod')).toBe(true);

    await tracker.recordSuccess('runpod');
    expect(tracker.isCoolingDown('runpod')).toBe(false);
    expect(tracker.getFailCount('runpod')).toBe(0);
  });

  it('exponential backoff increases cooldown with fail count', async () => {
    const base = 60_000;
    const max = 15 * 60_000; // MAX_COOLDOWN_MS is 15 min

    await tracker.recordFailure('vast');
    const t1 = tracker.getRemainingSeconds('vast');
    expect(t1).toBeGreaterThan(0);

    await tracker.recordFailure('vast');
    const t2 = tracker.getRemainingSeconds('vast');
    expect(t2).toBeGreaterThan(t1);

    await tracker.recordFailure('vast');
    await tracker.recordFailure('vast');
    const t4 = tracker.getRemainingSeconds('vast');
    expect(t4).toBeLessThanOrEqual(Math.round(max / 1000));
  });

  describe('loadFromFile / saveToFile', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cooldown-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('persists and reloads cooldowns', async () => {
      const filePath = path.join(tmpDir, 'cooldowns.json');
      await tracker.recordFailure('tensordock');
      await tracker.loadFromFile(filePath);
      await tracker.recordFailure('modal');

      const tracker2 = new ProviderCooldownTracker();
      await tracker2.loadFromFile(filePath);
      expect(tracker2.getFailCount('tensordock')).toBe(1);
      expect(tracker2.getFailCount('modal')).toBe(1);
      expect(tracker2.isCoolingDown('tensordock')).toBe(true);
    });

    it('ignores expired entries on load', async () => {
      const filePath = path.join(tmpDir, 'expired.json');
      const data = {
        old: {
          failedAt: Date.now() - 120_000,
          cooldownUntilMs: Date.now() - 60_000,
          failCount: 3,
        },
        active: {
          failedAt: Date.now(),
          cooldownUntilMs: Date.now() + 60_000,
          failCount: 1,
        },
      };
      fs.writeFileSync(filePath, JSON.stringify(data));

      const tracker2 = new ProviderCooldownTracker();
      await tracker2.loadFromFile(filePath);
      expect(tracker2.isCoolingDown('old')).toBe(false);
      expect(tracker2.isCoolingDown('active')).toBe(true);
    });

    it('does not crash on non-existent file', async () => {
      await expect(
        tracker.loadFromFile(path.join(tmpDir, 'nope.json'))
      ).resolves.not.toThrow();
    });
  });

  describe('getActiveCooldowns', () => {
    it('returns null/empty for non-cooldown provider', () => {
      const info = tracker.getActiveCooldowns();
      expect(info['vast']).toBeUndefined();
    });

    it('returns cooldown info for active cooldown', async () => {
      await tracker.recordFailure('runpod');
      const info = tracker.getActiveCooldowns();
      expect(info['runpod']).toBeDefined();
      expect(typeof info['runpod'].until).toBe('number');
      expect(typeof info['runpod'].remainSec).toBe('number');
      expect(info['runpod'].failCount).toBe(1);
      expect(info['runpod'].remainSec).toBeGreaterThan(0);
    });
  });
});

describe('PROVIDER_LABELS', () => {
  it('has labels for runpod, vast, tensordock, modal', () => {
    expect(PROVIDER_LABELS.runpod).toBe('RunPod');
    expect(PROVIDER_LABELS.vast).toBe('Vast.ai');
    expect(PROVIDER_LABELS.tensordock).toBe('TensorDock');
    expect(PROVIDER_LABELS.modal).toBe('Modal');
  });
});
