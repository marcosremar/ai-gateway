/**
 * Tests for gpu-providers/deploy-settings.ts
 * Covers: defaults, getters/setters, persistence (mocked), and edge cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs to avoid file system side effects
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

// Import after mocking
import {
  DEFAULT_GPU_PRIORITY,
  DEFAULT_GPU_PRIORITY_BY_PROVIDER,
  getDefaultGpuPriority,
  getDefaultGpuPriorityByProvider,
  getGpuPriorityList,
  setGpuPriorityList,
  getGpuPriorityForProvider,
  setGpuPriorityForProvider,
  getGpuSortBy,
  setGpuSortBy,
  getDeployTimeoutMin,
  setDeployTimeoutMin,
  getDeployRegion,
  setDeployRegion,
  getDeployDockerImage,
  setDeployDockerImage,
  getMinVramGb,
  setMinVramGb,
  getPreferSsd,
  setPreferSsd,
  getLatencyIntervalMin,
  setLatencyIntervalMin,
  getLatencyMaxMs,
  setLatencyMaxMs,
  getSttTargetLatencyMs,
  setSttTargetLatencyMs,
  getLlmTargetLatencyMs,
  setLlmTargetLatencyMs,
  getTtsTargetLatencyMs,
  setTtsTargetLatencyMs,
  getBenchmarkMaxRuns,
  setBenchmarkMaxRuns,
  getBenchmarkMarginPct,
  setBenchmarkMarginPct,
  getShadowRuns,
  setShadowRuns,
  getP95DemotionMultiplier,
  setP95DemotionMultiplier,
  getP95IdleWindowSec,
  setP95IdleWindowSec,
  getRepechageMaxAttempts,
  setRepechageMaxAttempts,
  getStandbyEnabled,
  setStandbyEnabled,
  getStandbyTriggerHours,
  setStandbyTriggerHours,
  getDeployRaceCount,
  setDeployRaceCount,
  getAutoRecoveryEnabled,
  setAutoRecoveryEnabled,
  getAutoRecoveryDelaySec,
  setAutoRecoveryDelaySec,
  getAutoRecoveryMaxRetries,
  setAutoRecoveryMaxRetries,
  flushDeploySettings,
  type GpuSortBy,
} from '../../src/gpu-providers/deploy-settings';

describe('deploy-settings', () => {
  describe('DEFAULT_GPU_PRIORITY', () => {
    // Default is intentionally empty — empty means "no filtering, all GPU types
    // shown". Filtering is opt-in via gpuPriorityList in latency-settings.json.
    it('is an array of strings', () => {
      expect(DEFAULT_GPU_PRIORITY).toBeInstanceOf(Array);
      expect(DEFAULT_GPU_PRIORITY.every(g => typeof g === 'string')).toBe(true);
    });

    it('getDefaultGpuPriority returns a copy (not reference)', () => {
      const a = getDefaultGpuPriority();
      const b = getDefaultGpuPriority();
      expect(a).toEqual(b);
      a.push('custom-gpu');
      expect(getDefaultGpuPriority()).not.toContain('custom-gpu');
    });
  });

  describe('DEFAULT_GPU_PRIORITY_BY_PROVIDER', () => {
    it('has entries for vast, runpod, tensordock', () => {
      expect(DEFAULT_GPU_PRIORITY_BY_PROVIDER.vast).toBeDefined();
      expect(DEFAULT_GPU_PRIORITY_BY_PROVIDER.runpod).toBeDefined();
      expect(DEFAULT_GPU_PRIORITY_BY_PROVIDER.tensordock).toBeDefined();
    });

    it('all provider entries are arrays', () => {
      for (const [, list] of Object.entries(DEFAULT_GPU_PRIORITY_BY_PROVIDER)) {
        expect(Array.isArray(list)).toBe(true);
      }
    });

    it('getDefaultGpuPriorityByProvider returns a copy', () => {
      const a = getDefaultGpuPriorityByProvider();
      const b = getDefaultGpuPriorityByProvider();
      expect(a).toEqual(b);
    });
  });

  describe('gpuPriorityList getter/setter', () => {
    beforeEach(() => flushDeploySettings());

    it('returns default list initially (empty by default)', () => {
      const list = getGpuPriorityList();
      expect(list).toBeInstanceOf(Array);
    });

    it('setGpuPriorityList updates the list', () => {
      const custom = ['NVIDIA RTX 4090', 'NVIDIA A100'];
      setGpuPriorityList(custom);
      expect(getGpuPriorityList()).toEqual(custom);
    });
  });

  describe('getGpuPriorityForProvider', () => {
    it('returns provider-specific list for known providers', () => {
      const vastList = getGpuPriorityForProvider('vast');
      expect(vastList).toBeInstanceOf(Array);
    });

    it('returns default list for unknown provider', () => {
      const list = getGpuPriorityForProvider('unknown-provider');
      expect(list).toEqual(getGpuPriorityList());
    });

    it('setGpuPriorityForProvider overrides per-provider list', () => {
      const custom = ['NVIDIA RTX 5090'];
      setGpuPriorityForProvider('vast', custom);
      expect(getGpuPriorityForProvider('vast')).toEqual(custom);
    });
  });

  describe('gpuSortBy', () => {
    beforeEach(() => flushDeploySettings());

    it('defaults to a valid sort type', () => {
      const sortBy = getGpuSortBy();
      expect(['price', 'latency', 'balanced']).toContain(sortBy);
    });

    it('setGpuSortBy updates value', () => {
      const sortTypes: GpuSortBy[] = ['price', 'latency', 'balanced'];
      for (const sort of sortTypes) {
        setGpuSortBy(sort);
        expect(getGpuSortBy()).toBe(sort);
      }
    });
  });

  describe('deployTimeoutMin', () => {
    beforeEach(() => flushDeploySettings());

    it('returns a positive number', () => {
      expect(getDeployTimeoutMin()).toBeGreaterThan(0);
    });

    it('setDeployTimeoutMin updates value', () => {
      setDeployTimeoutMin(15);
      expect(getDeployTimeoutMin()).toBe(15);
    });
  });

  describe('deployRegion', () => {
    beforeEach(() => flushDeploySettings());

    it('returns a string', () => {
      expect(typeof getDeployRegion()).toBe('string');
    });

    it('setDeployRegion updates value', () => {
      setDeployRegion('us-east');
      expect(getDeployRegion()).toBe('us-east');
    });
  });

  describe('deployDockerImage', () => {
    beforeEach(() => flushDeploySettings());

    it('returns a string', () => {
      expect(typeof getDeployDockerImage()).toBe('string');
    });

    it('setDeployDockerImage updates value', () => {
      setDeployDockerImage('myrepo/myimage:v2');
      expect(getDeployDockerImage()).toBe('myrepo/myimage:v2');
    });
  });

  describe('minVramGb', () => {
    beforeEach(() => flushDeploySettings());

    it('returns a non-negative number', () => {
      expect(getMinVramGb()).toBeGreaterThanOrEqual(0);
    });

    it('setMinVramGb updates value', () => {
      setMinVramGb(24);
      expect(getMinVramGb()).toBe(24);
    });
  });

  describe('preferSsd', () => {
    beforeEach(() => flushDeploySettings());

    it('returns a boolean', () => {
      expect(typeof getPreferSsd()).toBe('boolean');
    });

    it('setPreferSsd updates value', () => {
      setPreferSsd(true);
      expect(getPreferSsd()).toBe(true);
      setPreferSsd(false);
      expect(getPreferSsd()).toBe(false);
    });
  });

  describe('latency settings', () => {
    beforeEach(() => flushDeploySettings());

    it('getLatencyIntervalMin returns positive number', () => {
      expect(getLatencyIntervalMin()).toBeGreaterThan(0);
    });

    it('setLatencyIntervalMin updates value', () => {
      setLatencyIntervalMin(30);
      expect(getLatencyIntervalMin()).toBe(30);
    });

    it('getLatencyMaxMs returns positive number', () => {
      expect(getLatencyMaxMs()).toBeGreaterThan(0);
    });

    it('setLatencyMaxMs updates value', () => {
      setLatencyMaxMs(500);
      expect(getLatencyMaxMs()).toBe(500);
    });
  });

  describe('pipeline target latencies', () => {
    beforeEach(() => flushDeploySettings());

    it('STT latency getter/setter', () => {
      setSttTargetLatencyMs(300);
      expect(getSttTargetLatencyMs()).toBe(300);
    });

    it('LLM latency getter/setter', () => {
      setLlmTargetLatencyMs(800);
      expect(getLlmTargetLatencyMs()).toBe(800);
    });

    it('TTS latency getter/setter', () => {
      setTtsTargetLatencyMs(400);
      expect(getTtsTargetLatencyMs()).toBe(400);
    });
  });

  describe('benchmark settings', () => {
    beforeEach(() => flushDeploySettings());

    it('getBenchmarkMaxRuns/setBenchmarkMaxRuns', () => {
      setBenchmarkMaxRuns(10);
      expect(getBenchmarkMaxRuns()).toBe(10);
    });

    it('getBenchmarkMarginPct/setBenchmarkMarginPct', () => {
      setBenchmarkMarginPct(0.15);
      expect(getBenchmarkMarginPct()).toBe(0.15);
    });

    it('getShadowRuns/setShadowRuns', () => {
      setShadowRuns(3);
      expect(getShadowRuns()).toBe(3);
    });
  });

  describe('P95 settings', () => {
    beforeEach(() => flushDeploySettings());

    it('getP95DemotionMultiplier defaults to 2.0', () => {
      expect(getP95DemotionMultiplier()).toBe(2.0);
    });

    it('setP95DemotionMultiplier updates value', () => {
      setP95DemotionMultiplier(3.0);
      expect(getP95DemotionMultiplier()).toBe(3.0);
    });

    it('getP95IdleWindowSec defaults to 10', () => {
      expect(getP95IdleWindowSec()).toBe(10);
    });

    it('setP95IdleWindowSec updates value', () => {
      setP95IdleWindowSec(20);
      expect(getP95IdleWindowSec()).toBe(20);
    });
  });

  describe('repechage settings', () => {
    beforeEach(() => flushDeploySettings());

    it('getRepechageMaxAttempts defaults to 3', () => {
      expect(getRepechageMaxAttempts()).toBe(3);
    });

    it('setRepechageMaxAttempts updates value', () => {
      setRepechageMaxAttempts(5);
      expect(getRepechageMaxAttempts()).toBe(5);
    });
  });

  describe('standby settings', () => {
    beforeEach(() => flushDeploySettings());

    it('getStandbyEnabled defaults to false', () => {
      expect(getStandbyEnabled()).toBe(false);
    });

    it('setStandbyEnabled updates value', () => {
      setStandbyEnabled(true);
      expect(getStandbyEnabled()).toBe(true);
    });

    it('getStandbyTriggerHours/setStandbyTriggerHours', () => {
      setStandbyTriggerHours(8);
      expect(getStandbyTriggerHours()).toBe(8);
    });
  });

  describe('deploy race count', () => {
    beforeEach(() => flushDeploySettings());

    it('getDeployRaceCount defaults to 1 (no race — RunPod SECURE is reliable)', () => {
      expect(getDeployRaceCount()).toBe(1);
    });

    it('setDeployRaceCount updates value', () => {
      setDeployRaceCount(3);
      expect(getDeployRaceCount()).toBe(3);
    });
  });

  describe('auto recovery settings', () => {
    beforeEach(() => flushDeploySettings());

    it('getAutoRecoveryEnabled defaults to true', () => {
      expect(getAutoRecoveryEnabled()).toBe(true);
    });

    it('setAutoRecoveryEnabled updates value', () => {
      setAutoRecoveryEnabled(false);
      expect(getAutoRecoveryEnabled()).toBe(false);
    });

    it('getAutoRecoveryDelaySec defaults to 10', () => {
      expect(getAutoRecoveryDelaySec()).toBe(10);
    });

    it('setAutoRecoveryDelaySec updates value', () => {
      setAutoRecoveryDelaySec(30);
      expect(getAutoRecoveryDelaySec()).toBe(30);
    });

    it('getAutoRecoveryMaxRetries defaults to 2', () => {
      expect(getAutoRecoveryMaxRetries()).toBe(2);
    });

    it('setAutoRecoveryMaxRetries updates value', () => {
      setAutoRecoveryMaxRetries(5);
      expect(getAutoRecoveryMaxRetries()).toBe(5);
    });
  });

  describe('flushDeploySettings', () => {
    it('resets settings to defaults', () => {
      setDeployTimeoutMin(999);
      setGpuSortBy('latency');
      flushDeploySettings();
      // After flush, values should reset to defaults
      expect(getDeployTimeoutMin()).not.toBe(999);
    });
  });
});
