/**
 * GPU Error Handling — Integration Tests
 *
 * Tests that GPU fetch errors are properly logged,
 * metrics DB has retry logic, and standby handles failures.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const readSource = (file: string) => readFileSync(join(__dirname, '..', file), 'utf-8');

describe('GPU Fetch Error Logging', () => {
  it('should log error body on GPU STT/LLM/TTS HTTP failures', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'ai-handlers.ts'), 'utf-8');

    // All three GPU fetch functions should log the response body
    expect(source).toContain('[gpu:stt] HTTP');
    expect(source).toContain('[gpu:llm] HTTP');
    expect(source).toContain('[gpu:tts] HTTP');

    // Should read response text for debugging
    expect(source).toContain("await gpuRes.text().catch(() => '')");
  });
});

describe('Metrics DB Retry', () => {
  it('should retry DB writes on failure', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'metrics.ts'), 'utf-8');

    // Should have retry logic
    expect(source).toContain('tryWrite');
    expect(source).toContain('attempt < 2');
    // Should include attempt number in log
    expect(source).toContain('attempt %d');
  });
});

describe('Standby Deploy Error Recovery', () => {
  it('should reset standby state to idle after error timeout', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'gpu-standby.ts'), 'utf-8');

    // After deploy failure, should auto-reset to idle
    expect(source).toContain("status === 'error'");
    expect(source).toContain("status: 'idle'");
  });

  it('should export isHandoverDraining', () => {
    const source = readSource('server/gpu-standby.ts');
    expect(source).toContain('export function isHandoverDraining');
  });
});

describe('Deploy Settings Debounce', () => {
  it('should have debounced save and flush functions', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'gpu-providers', 'deploy-settings.ts'),
      'utf-8',
    );

    // Should debounce saves
    expect(source).toContain('_settingsSaveTimer');
    expect(source).toContain('300'); // 300ms debounce

    // Should have flush function
    expect(source).toContain('function flushDeploySettings');
  });
});

describe('Readiness History Debounce', () => {
  it('should debounce saveRun writes', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'gpu-readiness.ts'),
      'utf-8',
    );

    expect(source).toContain('_pendingSaveRun');
    expect(source).toContain('_pendingSaveData');
    // 500ms debounce
    expect(source).toContain('500');
  });

  it('should reuse STT benchmark WAV buffer', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'gpu-readiness.ts'),
      'utf-8',
    );

    // Should create WAV once at module level
    expect(source).toContain('STT_BENCH_WAV');
    // Should NOT create WAV inside the loop
    const benchFnIdx = source.indexOf('async function benchmarkService');
    const benchBody = source.slice(benchFnIdx, benchFnIdx + 2000);
    expect(benchBody).not.toContain('Buffer.alloc(headerSize + dataSize)');
    expect(benchBody).toContain('STT_BENCH_WAV');
  });

  it('should batch WS broadcasts during benchmark', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'gpu-readiness.ts'),
      'utf-8',
    );

    // Should only broadcast every Nth run
    expect(source).toContain('% 3 === 0');
    expect(source).toContain('i === maxRuns - 1');
  });
});

describe('Health Recovery Guard', () => {
  it('should check isReadinessCheckInProgress before starting readiness in markGpuHealthy', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'providers.ts'), 'utf-8');

    // Should import isReadinessCheckInProgress
    expect(source).toContain('isReadinessCheckInProgress');
    // Should guard against concurrent checks
    expect(source).toContain('readiness check already running');
  });
});
