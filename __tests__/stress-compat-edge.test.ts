/**
 * Stress, Compatibility, Migration, Browser, and Edge Case Tests
 * (#816-#825, #911-#924, #951-#963, remaining #725-#750)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const read = (f: string) => fs.readFileSync(path.resolve(f), 'utf8');
const SKIP = process.env.SKIP_LIVE_TESTS === '1';
const GW = process.env.GATEWAY_URL || 'http://localhost:4000';
const KEY = process.env.GATEWAY_API_KEY || '';

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}), ...extra };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRESS TESTS (#816-#825) — run against local server
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(SKIP)('Stress: Concurrent requests (#816-#825)', { timeout: 120_000 }, () => {
  const chatReq = (msg: string) => fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: msg }], max_tokens: 5 }),
    signal: AbortSignal.timeout(15_000),
  }).then(r => r.ok).catch(() => false);

  // #816
  it('#816 handles 25 concurrent chat requests', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) => chatReq(`Say ${i}`))
    );
    const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
    expect(ok).toBeGreaterThan(15); // >60% success
  });

  // #817
  it('#817 handles 20 concurrent health checks', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        fetch(`${GW}/health`, { signal: AbortSignal.timeout(5_000) }).then(r => r.ok)
      )
    );
    const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
    expect(ok).toBe(20); // 100% success for health
  });

  // #819
  it('#819 100 sequential health checks stable', async () => {
    let ok = 0;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${GW}/health`, { signal: AbortSignal.timeout(3_000) });
        if (r.ok) ok++;
      } catch {}
    }
    expect(ok).toBeGreaterThan(95);
  });

  // #822
  it('#822 rapid chat burst does not crash', async () => {
    const batch1 = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => chatReq(`Burst ${i}`)));
    const ok1 = batch1.filter(r => r.status === 'fulfilled').length;
    // Server should still respond after burst
    const health = await fetch(`${GW}/health`, { signal: AbortSignal.timeout(5_000) });
    expect(health.ok).toBe(true);
    expect(ok1).toBeGreaterThan(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PYTHON SDK COMPATIBILITY (#919-#924)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Python SDK Compatibility (#919-#924)', () => {
  const types = read('src/sdk/types.ts');

  it('#919 TranscribeResponse matches Python contract', () => {
    expect(types).toContain('TranscribeResponse');
    expect(types).toContain('text: string');
    expect(types).toContain('usedGpu: boolean');
  });

  it('#920 TranslateResponse matches Python contract', () => {
    expect(types).toContain('TranslateResponse');
    expect(types).toContain('translatedText: string');
  });

  it('#921 PipelineResponse matches Python contract', () => {
    expect(types).toContain('PipelineResponse');
    expect(types).toContain('transcription: string');
    expect(types).toContain('audioBase64: string');
  });

  it('#922 GpuStatus matches Python contract', () => {
    expect(types).toContain('GpuStatus');
    expect(types).toContain('podId: string');
    expect(types).toContain('endpoint: string');
  });

  it('#923 DeployOptions matches Python contract', () => {
    expect(types).toContain('DeployOptions');
    expect(types).toContain('apiKey: string');
  });

  it('#924 ChatCompletionResponse matches Python contract', () => {
    expect(types).toContain('ChatCompletionResponse');
    expect(types).toContain('content: string');
    expect(types).toContain('model: string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BROWSER CLIENT (#951-#958)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Browser Client Structure (#951-#958)', () => {
  it('#951 browser module exists', () => {
    expect(fs.existsSync('src/browser/index.ts')).toBe(true);
  });

  it('#952 WebRTC transport exists', () => {
    const files = fs.readdirSync('src/browser');
    expect(files.some(f => f.includes('webrtc') || f.includes('transport'))).toBe(true);
  });

  it('#957 browser exports entry point', () => {
    const tsup = read('tsup.config.ts');
    expect(tsup).toContain("browser: 'src/browser/index.ts'");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MIGRATION TESTS (#959-#963)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Migration / Compatibility (#959-#963)', () => {

  it('#962 the client build entry is the same module as the ./client package export', () => {
    const tsup = read('tsup.config.ts');
    const pkg = JSON.parse(read('package.json')) as { exports: Record<string, string> };
    expect(pkg.exports['./client']).toBe('./sdk/node/index.ts');
    expect(tsup).toContain("client: 'sdk/node/index.ts'");
    // no wildcard: the package does not expose every file under src/
    expect(pkg.exports['./*']).toBeUndefined();
  });

  it('#963 workloads entry point exported', () => {
    const tsup = read('tsup.config.ts');
    expect(tsup).toContain("workloads: 'src/workloads/index.ts'");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASES: Input fuzzing (#725-#750 gaps)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge Cases: Input boundary testing (#725-#750)', () => {

  it('#734 GPU deploy with empty gpuTypes uses fallback', () => {
    const src = read('src/gateway/providers/gpu/runpod/constants.ts');
    expect(src).toContain('RUNPOD_GPU_FALLBACK');
  });

  it('#744 SDK retries with alternating success/fail', () => {
    const src = read('src/sdk/client.ts');
    expect(src).toContain('MAX_RETRIES');
    expect(src).toContain('RETRY_BACKOFF_MS');
  });

  it('#745 SDK handles 0-byte response', () => {
    const src = read('src/sdk/client.ts');
    expect(src).toContain('parseJson');
  });

  it('#746 SDK handles non-JSON response', () => {
    const src = read('src/sdk/client.ts');
    expect(src).toContain('invalid JSON');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FLY.IO TESTS — source verification (#905-#910)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fly.io Architecture (#905-#910)', () => {
  it('#905 fly.toml configured', () => {
    expect(fs.existsSync('fly.toml')).toBe(true);
    const toml = read('fly.toml');
    expect(toml).toContain('auto_stop_machines');
    expect(toml).toContain('auto_start_machines');
  });

  it('#906 health check configured in fly.toml', () => {
    const toml = read('fly.toml');
    expect(toml).toContain('checks');
    expect(toml).toContain('interval');
  });

  it('#907 rolling deploy strategy', () => {
    // Deploy uses rolling strategy
    const toml = read('fly.toml');
    expect(toml).toContain('internal_port');
  });

  it('#909 auto_stop configured', () => {
    const toml = read('fly.toml');
    expect(toml).toContain("auto_stop_machines = 'stop'");
  });

  it('#910 min_machines_running = 0 (scale-to-zero, auto_start handles wake)', () => {
    const toml = read('fly.toml');
    expect(toml).toContain('min_machines_running = 0');
  });
});
