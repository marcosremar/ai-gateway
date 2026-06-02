/**
 * Fly Gateway fine-tune/GPU validation — real API, no GPU spend.
 *
 * Run:
 *   SKIP_LIVE_TESTS=0 bunx vitest run --config vitest.config.ts __tests__/finetune-fly-real-api.test.ts
 *
 * The tests call the deployed Gateway API. They intentionally use validation
 * and dry-run endpoints only, so they do not reserve Vast.ai machines.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from './helpers';

const DEFAULT_FLY_GATEWAY_URL = 'https://parle-ai-gateway.fly.dev';

let gatewayUrl = DEFAULT_FLY_GATEWAY_URL;
let gatewayKey = '';

function resolveGatewayKey(): string {
  const firstMultiKey = process.env.GATEWAY_API_KEYS?.split(',')[0]?.split(':')[0]?.trim();
  return process.env.AIGW_APP_KEY
    || process.env.AI_GATEWAY_KEY
    || firstMultiKey
    || process.env.GATEWAY_API_KEY
    || '';
}

function gatewayHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(gatewayKey ? { Authorization: `Bearer ${gatewayKey}` } : {}),
    ...extra,
  };
}

async function gatewayJson(path: string, init: RequestInit = {}): Promise<{ status: number; data: any }> {
  const res = await fetch(`${gatewayUrl}${path}`, {
    ...init,
    headers: {
      ...gatewayHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

const runLive = process.env.SKIP_LIVE_TESTS === '0';

describe.skipIf(!runLive)('Fly Gateway fine-tune real API', () => {
  beforeAll(async () => {
    await loadEnv();
    gatewayUrl = (process.env.AI_GATEWAY_URL || process.env.GATEWAY_URL || DEFAULT_FLY_GATEWAY_URL).replace(/\/+$/, '');
    gatewayKey = resolveGatewayKey();
    if (!gatewayKey) {
      throw new Error('missing Gateway API key: set AIGW_APP_KEY, AI_GATEWAY_KEY, GATEWAY_API_KEYS, or GATEWAY_API_KEY');
    }
    expect(gatewayUrl).toMatch(/^https:\/\/.+fly\.dev$/);
  });

  it('uses the deployed Fly Gateway and returns health ok', async () => {
    const { status, data } = await gatewayJson('/health');

    expect(status).toBe(200);
    expect(data.status).toBe('ok');
  });

  it('validates Vast deploy policy as serial direct-or-proxy SSH by default', async () => {
    const { status, data } = await gatewayJson('/v1/gpu/deploy/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: `e2e-finetune-validate-${Date.now()}`,
        provider: 'vast',
        gpuTypes: ['RTX 5090'],
        dockerImage: 'marcosremar/gpu-dev:latest',
        readinessProbe: 'ssh',
        finetune: true,
        bootTimeoutSec: 600,
      }),
    });

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.dryRun).toBe(true);
    expect(data.provider).toBe('vast');
    expect(data.deployPolicy).toMatchObject({
      directSshRequired: false,
      vastProxyAllowed: true,
      sshAccessPolicy: 'direct-or-proxy',
    });
  });

  it('dry-runs fine-tune start and rewrites macOS output paths on Fly', async () => {
    const runName = `whisper-gemma-e2e-${Date.now()}`;
    const macOutput = `/Users/marcos/projects/gemma1b-tts-integration/job_output/${runName}`;

    const { status, data } = await gatewayJson('/v1/gpu/finetune', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dryRun: true,
        type: 'custom',
        scriptPath: '/tmp/aigw-dry-run.sh',
        trainCmd: 'true',
        gpu: 'RTX 5090',
        providers: ['vast'],
        preferSpot: false,
        selectMode: 'fast',
        maxCost: 2.5,
        maxSpend: 0.25,
        timeoutMin: 10,
        bootTimeoutSec: 600,
        image: 'marcosremar/gpu-dev:latest',
        output: macOutput,
        r2Prefix: `tts-ptbr-training/ckpts/${runName}`,
      }),
    });

    expect(status).toBe(200);
    expect(data.status).toBe('validated');
    expect(data.dryRun).toBe(true);
    expect(data.gpuType).toBe('RTX 5090');
    expect(data.runtime).toMatchObject({
      requestedOutput: macOutput,
      outputRewritten: true,
      remoteRunner: true,
    });
    expect(data.runtime.output).toBe(`/tmp/ai-gateway-finetune/${runName}`);
    expect(data.plan?.blockers).toEqual([]);
  });
});
