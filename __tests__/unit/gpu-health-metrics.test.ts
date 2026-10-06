/**
 * Unit tests for server/gpu-health-metrics.ts — parseAndStoreGpuMetrics
 *
 * Strategy: mock server/state and src/logger so only the pure parsing +
 * warning logic runs. Each test group re-imports the module when the
 * module-level `consecutiveZeroUtilProbes` counter matters.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Shared mock factories ─────────────────────────────────────────────────────

function makeStateMock() {
  const setDeployState = vi.fn();
  return {
    deployState: { status: 'ready', alert: '' },
    setDeployState,
  };
}

function makeLoggerMock() {
  const warn = vi.fn();
  const log = vi.fn();
  return {
    createLogger: vi.fn(() => ({ warn, log, error: vi.fn(), debug: vi.fn(), info: vi.fn() })),
    _warn: warn,
    _log: log,
  };
}

// ── Convenience: import a fresh module instance with fresh mocks ──────────────

async function freshImport() {
  vi.resetModules();

  const stateMock = makeStateMock();
  const loggerMock = makeLoggerMock();

  vi.doMock('../../server/state', () => stateMock);
  vi.doMock('../../src/logger', () => ({ createLogger: loggerMock.createLogger }));

  const mod = await import('../../server/gpu-health-metrics');
  return { mod, stateMock, loggerMock };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Temperature field aliases
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseAndStoreGpuMetrics — temperature field aliases', () => {
  afterEach(() => { vi.resetModules(); });

  it('reads gpu_temp_c (primary field)', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_temp_c: 72 });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuTemp: 72 }),
    );
  });

  it('falls back to gpu_temperature when gpu_temp_c absent', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_temperature: 68 });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuTemp: 68 }),
    );
  });

  it('falls back to temperature when first two aliases absent', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ temperature: 55 });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuTemp: 55 }),
    );
  });

  it('defaults to 0 when no temperature field present', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_util_pct: 50 }); // provide another metric so state is updated
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuTemp: 0 }),
    );
  });

  it('prefers gpu_temp_c over gpu_temperature', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_temp_c: 90, gpu_temperature: 70 });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuTemp: 90 }),
    );
  });

  it('ignores non-numeric temperature field', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_util_pct: 30, gpu_temp_c: 'hot' });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuTemp: 0 }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Utilization field aliases
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseAndStoreGpuMetrics — utilization field aliases', () => {
  afterEach(() => { vi.resetModules(); });

  it('reads gpu_util_pct (primary field)', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_util_pct: 85 });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuUtil: 85 }),
    );
  });

  it('falls back to gpu_utilization', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_utilization: 40 });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuUtil: 40 }),
    );
  });

  it('falls back to utilization', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ utilization: 60 });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuUtil: 60 }),
    );
  });

  it('defaults to -1 when no util field present', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_temp_c: 70 }); // provide another metric
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuUtil: -1 }),
    );
  });

  it('prefers gpu_util_pct over gpu_utilization', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_util_pct: 95, gpu_utilization: 50 });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuUtil: 95 }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Memory field aliases
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseAndStoreGpuMetrics — memory field aliases', () => {
  afterEach(() => { vi.resetModules(); });

  it('reads gpu_mem_used_gb and gpu_mem_total_gb (primary fields)', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_mem_used_gb: 20, gpu_mem_total_gb: 24 });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuMemUsed: 20, gpuMemTotal: 24 }),
    );
  });

  it('falls back to gpu_memory_used / gpu_memory_total', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_memory_used: 10, gpu_memory_total: 16 });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuMemUsed: 10, gpuMemTotal: 16 }),
    );
  });

  it('falls back to vram_used_gb / vram_total_gb', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ vram_used_gb: 6, vram_total_gb: 8 });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuMemUsed: 6, gpuMemTotal: 8 }),
    );
  });

  it('defaults memUsed and memTotal to 0 when absent', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_temp_c: 70 });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuMemUsed: 0, gpuMemTotal: 0 }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// setDeployState gating — only called when at least one metric is present
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseAndStoreGpuMetrics — setDeployState gating', () => {
  afterEach(() => { vi.resetModules(); });

  it('does NOT call setDeployState when data is empty (all at defaults)', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({});
    // util defaults to -1 which is < 0, temp/mem default to 0
    // none of the conditions (temp>0, util>=0, memUsed>0, memTotal>0) is true
    expect(stateMock.setDeployState).not.toHaveBeenCalled();
  });

  it('calls setDeployState when only temp is present', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_temp_c: 60 });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuTemp: 60 }),
    );
  });

  it('calls setDeployState when util=0 (zero is >=0)', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_util_pct: 0 });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuUtil: 0 }),
    );
  });

  it('calls setDeployState when only memory is present', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_mem_total_gb: 24 });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuMemTotal: 24 }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Thermal warning — > 85C triggers alert
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseAndStoreGpuMetrics — thermal warnings', () => {
  afterEach(() => { vi.resetModules(); });

  it('emits warn log and sets alert when temp > 85', async () => {
    const { mod, stateMock, loggerMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_temp_c: 90 });
    expect(loggerMock._warn).toHaveBeenCalledWith(
      expect.stringContaining('HIGH TEMPERATURE'),
    );
    expect(loggerMock._warn).toHaveBeenCalledWith(
      expect.stringContaining('90C'),
    );
    // Alert setDeployState call includes the word "temperature"
    const alertCall = stateMock.setDeployState.mock.calls.find(
      (c: any[]) => c[0]?.alert,
    );
    expect(alertCall).toBeDefined();
    expect(alertCall![0].alert).toContain('90C');
  });

  it('does NOT warn when temp == 85 (boundary — threshold is strictly >85)', async () => {
    const { mod, loggerMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_temp_c: 85 });
    expect(loggerMock._warn).not.toHaveBeenCalledWith(
      expect.stringContaining('HIGH TEMPERATURE'),
    );
  });

  it('does NOT warn when temp is 84', async () => {
    const { mod, loggerMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_temp_c: 84 });
    expect(loggerMock._warn).not.toHaveBeenCalledWith(
      expect.stringContaining('HIGH TEMPERATURE'),
    );
  });

  it('warns at 86', async () => {
    const { mod, loggerMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_temp_c: 86 });
    expect(loggerMock._warn).toHaveBeenCalledWith(
      expect.stringContaining('HIGH TEMPERATURE'),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OOM warnings — memory > 95%
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseAndStoreGpuMetrics — OOM memory warnings', () => {
  afterEach(() => { vi.resetModules(); });

  it('warns when memPct > 95 (e.g. 23.5/24 ≈ 97.9%)', async () => {
    const { mod, loggerMock, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_mem_used_gb: 23.5, gpu_mem_total_gb: 24 });
    expect(loggerMock._warn).toHaveBeenCalledWith(
      expect.stringContaining('HIGH MEMORY'),
    );
    const alertCall = stateMock.setDeployState.mock.calls.find(
      (c: any[]) => c[0]?.alert?.includes('critical'),
    );
    expect(alertCall).toBeDefined();
  });

  it('does NOT warn when memPct == 95 (boundary — threshold is strictly >95)', async () => {
    const { mod, loggerMock } = await freshImport();
    // 19.2 / 20.0 = 96% → should warn; use 19/20 = 95% → should not
    mod.parseAndStoreGpuMetrics({ gpu_mem_used_gb: 19, gpu_mem_total_gb: 20 });
    expect(loggerMock._warn).not.toHaveBeenCalledWith(
      expect.stringContaining('HIGH MEMORY'),
    );
  });

  it('does NOT warn when memTotal is 0 (guards against division by zero)', async () => {
    const { mod, loggerMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_mem_used_gb: 10, gpu_mem_total_gb: 0 });
    expect(loggerMock._warn).not.toHaveBeenCalledWith(
      expect.stringContaining('HIGH MEMORY'),
    );
  });

  it('does NOT warn when memUsed is 0', async () => {
    const { mod, loggerMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_mem_used_gb: 0, gpu_mem_total_gb: 24 });
    expect(loggerMock._warn).not.toHaveBeenCalledWith(
      expect.stringContaining('HIGH MEMORY'),
    );
  });

  it('alert string includes used/total values', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ gpu_mem_used_gb: 22.9, gpu_mem_total_gb: 24 });
    const alertCall = stateMock.setDeployState.mock.calls.find(
      (c: any[]) => c[0]?.alert?.includes('critical'),
    );
    expect(alertCall![0].alert).toContain('24.0GB');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Idle GPU counter — consecutive zero-utilization probe tracking
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseAndStoreGpuMetrics — idle GPU consecutive counter', () => {
  afterEach(() => { vi.resetModules(); });

  it('increments counter on util=0 and emits warning at exactly 10 consecutive zeros', async () => {
    const { mod, loggerMock } = await freshImport();

    // 9 probes at 0% — no warning yet
    for (let i = 0; i < 9; i++) {
      mod.parseAndStoreGpuMetrics({ gpu_util_pct: 0 });
    }
    expect(loggerMock._warn).not.toHaveBeenCalledWith(
      expect.stringContaining('GPU utilization 0%'),
    );

    // 10th probe — warning fires
    mod.parseAndStoreGpuMetrics({ gpu_util_pct: 0 });
    expect(loggerMock._warn).toHaveBeenCalledWith(
      expect.stringContaining('GPU utilization 0%'),
    );
  });

  it('resets counter when util > 0, so 9+1+10 does NOT re-trigger at 10', async () => {
    const { mod, loggerMock } = await freshImport();

    // Run up to 9
    for (let i = 0; i < 9; i++) {
      mod.parseAndStoreGpuMetrics({ gpu_util_pct: 0 });
    }
    // Reset via non-zero util
    mod.parseAndStoreGpuMetrics({ gpu_util_pct: 50 });
    // 10 more zeros — counter started fresh, so warning fires at probe #10
    for (let i = 0; i < 9; i++) {
      mod.parseAndStoreGpuMetrics({ gpu_util_pct: 0 });
    }
    // Only 9 zeros after reset — no warning yet
    expect(loggerMock._warn).not.toHaveBeenCalledWith(
      expect.stringContaining('GPU utilization 0%'),
    );
  });

  it('warning fires only once at the threshold (not on 11th, 12th, etc.)', async () => {
    const { mod, loggerMock } = await freshImport();

    for (let i = 0; i < 12; i++) {
      mod.parseAndStoreGpuMetrics({ gpu_util_pct: 0 });
    }
    const warnCalls = loggerMock._warn.mock.calls.filter(
      (c: any[]) => c[0]?.includes('GPU utilization 0%'),
    );
    expect(warnCalls.length).toBe(1); // exactly once at the threshold
  });

  it('util=-1 (no util field) does NOT increment idle counter', async () => {
    const { mod, loggerMock } = await freshImport();

    // 15 probes with no util field (defaults to -1)
    for (let i = 0; i < 15; i++) {
      mod.parseAndStoreGpuMetrics({ gpu_temp_c: 70 });
    }
    expect(loggerMock._warn).not.toHaveBeenCalledWith(
      expect.stringContaining('GPU utilization 0%'),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Combined scenarios
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseAndStoreGpuMetrics — combined scenarios', () => {
  afterEach(() => { vi.resetModules(); });

  it('full health payload updates all four metrics', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({
      gpu_temp_c: 75,
      gpu_util_pct: 90,
      gpu_mem_used_gb: 18,
      gpu_mem_total_gb: 24,
    });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuTemp: 75, gpuUtil: 90, gpuMemUsed: 18, gpuMemTotal: 24 }),
    );
  });

  it('both thermal and OOM conditions at once produce two separate warn calls', async () => {
    const { mod, loggerMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({
      gpu_temp_c: 92,
      gpu_util_pct: 85,
      gpu_mem_used_gb: 23.8,
      gpu_mem_total_gb: 24,
    });
    const highTempWarn = loggerMock._warn.mock.calls.some((c: any[]) => c[0]?.includes('HIGH TEMPERATURE'));
    const oomWarn = loggerMock._warn.mock.calls.some((c: any[]) => c[0]?.includes('HIGH MEMORY'));
    expect(highTempWarn).toBe(true);
    expect(oomWarn).toBe(true);
  });

  it('vram alias fields work as standalone payload', async () => {
    const { mod, stateMock } = await freshImport();
    mod.parseAndStoreGpuMetrics({ vram_used_gb: 7.5, vram_total_gb: 8 });
    expect(stateMock.setDeployState).toHaveBeenCalledWith(
      expect.objectContaining({ gpuMemUsed: 7.5, gpuMemTotal: 8 }),
    );
  });
});
