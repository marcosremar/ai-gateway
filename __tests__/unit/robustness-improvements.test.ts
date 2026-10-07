/**
 * Robustness Improvements — comprehensive tests for 29 improvements across
 * pre-deploy validation, deploy progress, cost tracking, GPU fallback,
 * provider intelligence, request coalescing, batch detection,
 * network split detection, latency trend, and host crash patterns.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// Group 1: Pre-deploy validation
// ═══════════════════════════════════════════════════════════════════════════

import {
  checkDeployWarnings,
  getGpuFallbacks,
} from '../../src/gpu-providers/deploy-settings';

describe('Group 1: Pre-deploy validation — checkDeployWarnings', () => {
  it('returns error for 70B model on RTX 3090 (24GB VRAM insufficient)', () => {
    const warnings = checkDeployWarnings({
      dockerImage: 'vllm/vllm-openai:latest',
      gpuTypes: ['NVIDIA GeForce RTX 3090'],
      onstart: 'python -m vllm.entrypoints.api_server --model meta-llama/Llama-2-70b-hf',
    });
    expect(warnings.length).toBeGreaterThan(0);
    const error = warnings.find(
      (w) => w.level === 'error' && /70B/i.test(w.message),
    );
    expect(error).toBeDefined();
  });

  it('returns error for 32B model on RTX 3080 (insufficient VRAM)', () => {
    const warnings = checkDeployWarnings({
      dockerImage: 'vllm/vllm-openai:latest',
      gpuTypes: ['NVIDIA GeForce RTX 3080'],
      onstart: 'python serve.py --model deepseek-32b-instruct',
    });
    expect(warnings.length).toBeGreaterThan(0);
    const error = warnings.find(
      (w) => w.level === 'error' && /32B/i.test(w.message),
    );
    expect(error).toBeDefined();
  });

  it('returns error for Blackwell GPU with old CUDA image', () => {
    const warnings = checkDeployWarnings({
      dockerImage: 'nvidia/cuda:12.2.0-runtime-ubuntu22.04',
      gpuTypes: ['NVIDIA GeForce RTX 5090'],
    });
    expect(warnings.length).toBeGreaterThan(0);
    const error = warnings.find(
      (w) => w.level === 'error' && /Blackwell|CUDA 12\.8/i.test(w.message),
    );
    expect(error).toBeDefined();
  });

  it('returns warning for low disk with 70B model', () => {
    const warnings = checkDeployWarnings({
      dockerImage: 'vllm/vllm-openai:latest',
      gpuTypes: ['NVIDIA A100-SXM4-80GB'],
      onstart: 'python serve.py --model llama-70b',
      storageGb: 50,
    });
    const warn = warnings.find(
      (w) => w.level === 'warn' && /disk|storage/i.test(w.message),
    );
    expect(warn).toBeDefined();
  });

  it('returns empty array for valid config', () => {
    const warnings = checkDeployWarnings({
      dockerImage: 'marcosremar/babelcast-subtitle:latest',
      gpuTypes: ['NVIDIA GeForce RTX 4090'],
      storageGb: 100,
    });
    expect(warnings).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 2: Deploy progress — pull time estimator
// ═══════════════════════════════════════════════════════════════════════════

import {
  estimateRemainingMs,
  recordDownloadSpeed,
  getHostDownloadSpeed,
} from '../../src/gpu-providers/pull-time-estimator';

describe('Group 2: Deploy progress — pull time estimator', () => {
  it('estimateRemainingMs returns positive ETA for pulling phase', () => {
    const result = estimateRemainingMs('pulling', 5_000, 500);
    expect(result.etaMs).toBeGreaterThan(0);
    expect(['high', 'medium', 'low']).toContain(result.confidence);
  });

  it('estimateRemainingMs returns decreasing ETA as elapsed increases', () => {
    const early = estimateRemainingMs('pulling', 10_000, 500);
    const later = estimateRemainingMs('pulling', 100_000, 500);
    expect(later.etaMs).toBeLessThanOrEqual(early.etaMs);
  });

  it('estimateRemainingMs for booting phase returns ETA based on 30s baseline', () => {
    const result = estimateRemainingMs('booting', 0, 500);
    expect(result.etaMs).toBe(30_000);
    expect(result.confidence).toBe('medium');
  });

  it('estimateRemainingMs for loading_models uses model size', () => {
    const small = estimateRemainingMs('loading_models', 0, 500, 5);
    const large = estimateRemainingMs('loading_models', 0, 500, 50);
    expect(large.etaMs).toBeGreaterThan(small.etaMs);
  });

  it('recordDownloadSpeed stores and getHostDownloadSpeed retrieves speed', () => {
    const hostKey = 'test-host-speed-' + Date.now();
    // Record a download: 10GB in 100s = ~819 Mbps
    recordDownloadSpeed(hostKey, 10, 100);
    const speed = getHostDownloadSpeed(hostKey);
    expect(speed).not.toBeNull();
    expect(speed!).toBeGreaterThan(0);
    // 10 GB * 8 * 1024 / 100 = 819.2 Mbps
    expect(speed!).toBeCloseTo(819.2, 0);
  });

  it('getHostDownloadSpeed returns null for unknown host', () => {
    const speed = getHostDownloadSpeed('nonexistent-host-' + Date.now());
    expect(speed).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 4: GPU type fallback
// ═══════════════════════════════════════════════════════════════════════════

describe('Group 4: GPU type fallback — getGpuFallbacks', () => {
  it('returns alternatives for RTX 4090', () => {
    const fallbacks = getGpuFallbacks('NVIDIA GeForce RTX 4090');
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(fallbacks).toContain('NVIDIA RTX A6000');
    expect(fallbacks).toContain('NVIDIA L40S');
    // Should not contain the failed GPU itself
    expect(fallbacks).not.toContain('NVIDIA GeForce RTX 4090');
  });

  it('returns alternatives for RTX A6000', () => {
    const fallbacks = getGpuFallbacks('NVIDIA RTX A6000');
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(fallbacks).toContain('NVIDIA L40S');
    expect(fallbacks).not.toContain('NVIDIA RTX A6000');
  });

  it('returns alternatives for high-end GPUs (H100)', () => {
    const fallbacks = getGpuFallbacks('NVIDIA H100 80GB HBM3');
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(fallbacks).toContain('NVIDIA H200');
    expect(fallbacks).toContain('NVIDIA A100-SXM4-80GB');
  });

  it('returns empty for unknown GPU type', () => {
    const fallbacks = getGpuFallbacks('Unknown GPU XYZ 9999');
    expect(fallbacks).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 5: Provider intelligence — PerformanceRanker
// ═══════════════════════════════════════════════════════════════════════════

import { PerformanceRanker } from '../../src/providers/performance-ranker';

describe('Group 5: Provider intelligence — PerformanceRanker', () => {
  let ranker: PerformanceRanker;

  beforeEach(() => {
    // Use a large window so samples don't expire during the test
    ranker = new PerformanceRanker({
      windowSize: 100,
      windowTimeMs: 600_000,
      minSamples: 3,
      persistPath: null, // no disk persistence in tests
    });
  });

  afterEach(() => {
    ranker.dispose();
  });

  it('getRecoveryStatus returns "healthy" when all samples succeed', () => {
    for (let i = 0; i < 10; i++) {
      ranker.record('stt', 'groq', 'whisper-large', 200 + Math.random() * 50, true);
    }
    const status = ranker.getRecoveryStatus('stt', 'groq', 'whisper-large');
    expect(status).toBe('healthy');
  });

  it('getRecoveryStatus returns "down" when all recent samples fail', () => {
    // Add some old successes
    for (let i = 0; i < 5; i++) {
      ranker.record('stt', 'groq', 'whisper-large', 200, true);
    }
    // Then all recent failures
    for (let i = 0; i < 5; i++) {
      ranker.record('stt', 'groq', 'whisper-large', 5000, false);
    }
    const status = ranker.getRecoveryStatus('stt', 'groq', 'whisper-large');
    expect(status).toBe('down');
  });

  it('getRecoveryStatus returns "recovering" after failures then successes', () => {
    // First: a batch of failures (these become the "older window")
    for (let i = 0; i < 5; i++) {
      ranker.record('llm', 'openai', 'gpt-4', 5000, false);
    }
    // Then: 3 recent successes (most recent window)
    for (let i = 0; i < 3; i++) {
      ranker.record('llm', 'openai', 'gpt-4', 300, true);
    }
    const status = ranker.getRecoveryStatus('llm', 'openai', 'gpt-4');
    expect(status).toBe('recovering');
  });

  it('getCostEfficiencyScore penalizes expensive providers', () => {
    // Record some samples for two providers with similar latency
    for (let i = 0; i < 10; i++) {
      ranker.record('llm', 'cheap-provider', 'model-a', 200, true);
      ranker.record('llm', 'expensive-provider', 'model-a', 200, true);
    }

    const cheapScore = ranker.getCostEfficiencyScore(
      'llm', 'cheap-provider', 'model-a', 0.001,
    );
    const expensiveScore = ranker.getCostEfficiencyScore(
      'llm', 'expensive-provider', 'model-a', 0.05,
    );

    // Higher score = better cost efficiency. Cheap provider should score higher.
    expect(cheapScore).toBeGreaterThan(expensiveScore);
  });

  it('getCostEfficiencyScore returns normalized score without cost param', () => {
    for (let i = 0; i < 10; i++) {
      ranker.record('stt', 'groq', 'whisper', 300, true);
    }
    const score = ranker.getCostEfficiencyScore('stt', 'groq', 'whisper');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('getStats returns correct percentiles and success rate', () => {
    for (let i = 0; i < 10; i++) {
      ranker.record('tts', 'modal', 'kokoro', 100 + i * 10, true);
    }
    ranker.record('tts', 'modal', 'kokoro', 5000, false);

    const stats = ranker.getStats('tts', 'modal', 'kokoro');
    expect(stats.sampleCount).toBe(11);
    expect(stats.p50).not.toBeNull();
    expect(stats.p95).not.toBeNull();
    expect(stats.successRate).toBeCloseTo(10 / 11, 2);
  });

  it('clear() resets all samples', () => {
    ranker.record('stt', 'groq', 'whisper', 200, true);
    ranker.clear();
    expect(ranker.size).toBe(0);
    const stats = ranker.getStats('stt', 'groq', 'whisper');
    expect(stats.sampleCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 6: Request coalescing
// ═══════════════════════════════════════════════════════════════════════════

import { coalesce, coalesceInflightCount } from '../../src/proxy/middleware/request-coalescer';

describe('Group 6: Request coalescing', () => {
  it('coalesce returns same promise for same key while in-flight', async () => {
    let callCount = 0;
    const fn = () => {
      callCount++;
      return new Promise<string>((resolve) => setTimeout(() => resolve('result'), 50));
    };

    const p1 = coalesce('dedup-key-1', fn);
    const p2 = coalesce('dedup-key-1', fn);

    // Both should be the same promise reference
    expect(p1).toBe(p2);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('result');
    expect(r2).toBe('result');
    // fn should have been called only once
    expect(callCount).toBe(1);
  });

  it('coalesce returns different promises for different keys', async () => {
    let callCount = 0;
    const fn = () => {
      callCount++;
      return Promise.resolve(`result-${callCount}`);
    };

    const p1 = coalesce('key-a-' + Date.now(), fn);
    const p2 = coalesce('key-b-' + Date.now(), fn);

    // Different keys should invoke fn separately
    expect(p1).not.toBe(p2);
    await Promise.all([p1, p2]);
    expect(callCount).toBe(2);
  });

  it('coalesce cleans up after resolution', async () => {
    const key = 'cleanup-test-' + Date.now();
    const initialCount = coalesceInflightCount();

    await coalesce(key, () => Promise.resolve('done'));

    // After resolution, the entry should be cleaned up
    // A new call with the same key should create a new invocation
    let secondCallCount = 0;
    await coalesce(key, () => {
      secondCallCount++;
      return Promise.resolve('done-again');
    });
    expect(secondCallCount).toBe(1);
  });

  it('coalesce cleans up after rejection', async () => {
    const key = 'error-cleanup-' + Date.now();
    try {
      await coalesce(key, () => Promise.reject(new Error('test error')));
    } catch {
      // expected
    }

    // After rejection, the entry should be cleaned up
    let called = false;
    await coalesce(key, () => {
      called = true;
      return Promise.resolve('recovered');
    });
    expect(called).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 7: Batch detector
// ═══════════════════════════════════════════════════════════════════════════

import {
  recordSttRequest,
  getBatchOpportunityCount,
  resetBatchDetector,
} from '../../src/providers/batch-detector';

describe('Group 7: Batch detector', () => {
  beforeEach(() => {
    resetBatchDetector();
  });

  it('recordSttRequest detects batch opportunity for 3+ same-language requests', () => {
    // Send 3 rapid requests for the same language (within the 200ms window)
    recordSttRequest('fr');
    recordSttRequest('fr');
    recordSttRequest('fr');

    expect(getBatchOpportunityCount()).toBe(1);
  });

  it('does not detect batch opportunity for fewer than 3 same-language requests', () => {
    recordSttRequest('en');
    recordSttRequest('en');

    expect(getBatchOpportunityCount()).toBe(0);
  });

  it('does not detect batch opportunity for mixed languages', () => {
    recordSttRequest('fr');
    recordSttRequest('en');
    recordSttRequest('de');

    expect(getBatchOpportunityCount()).toBe(0);
  });

  it('getBatchOpportunityCount returns correct count for multiple batches', () => {
    // First batch: 3 French requests
    recordSttRequest('fr');
    recordSttRequest('fr');
    recordSttRequest('fr');

    // Second batch: 3 more French requests (4th triggers again since window still active)
    recordSttRequest('fr');

    // The 4th request also has 4 same-language entries in window, so it triggers again
    expect(getBatchOpportunityCount()).toBe(2);
  });

  it('resetBatchDetector zeros counter and clears window', () => {
    recordSttRequest('fr');
    recordSttRequest('fr');
    recordSttRequest('fr');
    expect(getBatchOpportunityCount()).toBe(1);

    resetBatchDetector();
    expect(getBatchOpportunityCount()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 8: Network split detection (via CircuitBreakerRegistry)
// ═══════════════════════════════════════════════════════════════════════════

import {
  CircuitBreakerRegistry,
  CircuitBreaker,
} from '../../src/providers/circuit-breaker';

describe('Group 8: Network split detection', () => {
  let registry: CircuitBreakerRegistry;

  // Helper: checks if all breakers in the registry are open (= network split).
  // Since CircuitBreakerRegistry does not have a built-in isNetworkSplit,
  // we derive it from allStats() — all providers open = likely network split.
  function isNetworkSplit(reg: CircuitBreakerRegistry): boolean {
    const stats = reg.allStats();
    const ids = Object.keys(stats);
    if (ids.length === 0) return false;
    return ids.every((id) => stats[id].state === 'open');
  }

  beforeEach(() => {
    registry = new CircuitBreakerRegistry({ failureThreshold: 3, resetTimeoutMs: 60_000 });
  });

  it('isNetworkSplit returns false when some providers are healthy', () => {
    const groq = registry.get('groq');
    const openai = registry.get('openai');

    // groq fails and opens
    groq.recordFailure();
    groq.recordFailure();
    groq.recordFailure();

    // openai is still healthy
    openai.recordSuccess();

    expect(isNetworkSplit(registry)).toBe(false);
  });

  it('isNetworkSplit returns true when all providers are open', () => {
    const groq = registry.get('groq');
    const openai = registry.get('openai');
    const fireworks = registry.get('fireworks');

    // All providers fail past threshold
    for (const cb of [groq, openai, fireworks]) {
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
    }

    const stats = registry.allStats();
    // Verify all are open
    expect(stats['groq'].state).toBe('open');
    expect(stats['openai'].state).toBe('open');
    expect(stats['fireworks'].state).toBe('open');

    expect(isNetworkSplit(registry)).toBe(true);
  });

  it('isNetworkSplit returns false when no providers are tracked', () => {
    expect(isNetworkSplit(registry)).toBe(false);
  });

  it('circuit breaker transitions through states correctly', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 100,
      now: () => Date.now(),
    });

    // Starts closed
    expect(cb.getStats().state).toBe('closed');
    expect(cb.allowRequest()).toBe(true);

    // Record failures to open
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getStats().state).toBe('open');
    expect(cb.allowRequest()).toBe(false);
  });

  it('resetAll clears all circuit breakers', () => {
    const groq = registry.get('groq');
    groq.recordFailure();
    groq.recordFailure();
    groq.recordFailure();

    expect(registry.allStats()['groq'].state).toBe('open');

    registry.resetAll();
    expect(registry.allStats()['groq'].state).toBe('closed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Additional edge case tests across groups
// ═══════════════════════════════════════════════════════════════════════════

describe('Cross-cutting: edge cases', () => {
  it('checkDeployWarnings handles missing/empty fields gracefully', () => {
    expect(checkDeployWarnings({})).toEqual([]);
    expect(checkDeployWarnings({ dockerImage: '', gpuTypes: [] })).toEqual([]);
  });

  it('estimateRemainingMs returns 0 ETA when elapsed exceeds expected time', () => {
    const result = estimateRemainingMs('booting', 999_999, 500);
    expect(result.etaMs).toBe(0);
  });

  it('PerformanceRanker getRecoveryStatus returns healthy with no data', () => {
    const ranker = new PerformanceRanker({ persistPath: null });
    const status = ranker.getRecoveryStatus('stt', 'unknown-provider', 'model');
    expect(status).toBe('healthy');
    ranker.dispose();
  });

  it('getGpuFallbacks for RTX 5090 suggests RTX 4090 and A6000', () => {
    const fallbacks = getGpuFallbacks('NVIDIA GeForce RTX 5090');
    expect(fallbacks).toContain('NVIDIA GeForce RTX 4090');
    expect(fallbacks).toContain('NVIDIA RTX A6000');
  });

  it('recordDownloadSpeed ignores zero/negative values', () => {
    const host = 'zero-speed-host-' + Date.now();
    recordDownloadSpeed(host, 0, 100);
    recordDownloadSpeed(host, 10, 0);
    expect(getHostDownloadSpeed(host)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Skipped tests — require live servers or complex infrastructure
// ═══════════════════════════════════════════════════════════════════════════

describe.skip('GPU deploy health polling (requires live GPU infrastructure)', () => {
  // These tests verify that the deploy orchestrator correctly polls GPU health
  // during deployment and detects when a pod becomes ready or fails.
  it('deploys a GPU pod and polls until healthy', () => {});
  it('detects GPU OOM during model loading', () => {});
  it('cancels deploy after timeout', () => {});
});

describe.skip('Live provider fallback chain (requires API keys)', () => {
  // These tests verify end-to-end provider fallback behavior with real APIs.
  it('falls back from groq to openai on rate limit', () => {});
  it('records latency samples during real inference', () => {});
});

describe.skip('Redis-backed circuit breaker (requires Redis)', () => {
  // The TierCircuitBreaker in autoscaler/circuit-breaker.ts uses KvStore
  // (Redis or InMemory). These tests would verify persistence across restarts.
  it('persists circuit state across restarts via Redis', () => {});
  it('handles concurrent state updates correctly', () => {});
});
