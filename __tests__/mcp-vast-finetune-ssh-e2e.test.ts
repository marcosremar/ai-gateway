/**
 * Live MCP/Vast fine-tune SSH acquisition probe.
 *
 * This test is intentionally opt-in because it reserves a real Vast.ai GPU.
 * It exercises the public MCP surface, not direct Vast APIs:
 *
 *   RUN_LIVE_MCP_VAST_FINETUNE_SSH=1 SKIP_LIVE_TESTS=0 bunx vitest run --config vitest.config.ts --no-changed __tests__/mcp-vast-finetune-ssh-e2e.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from './helpers';

type McpToolResult = {
  endpoint?: string;
  status?: number;
  ok?: boolean;
  body?: unknown;
};

const shouldRun = process.env.RUN_LIVE_MCP_VAST_FINETUNE_SSH === '1' && process.env.SKIP_LIVE_TESTS !== '1';
const liveDescribe = shouldRun ? describe : describe.skip;
let cachedApiKey = '';

function gatewayUrl() {
  return (process.env.AIGW_LIVE_GATEWAY_URL || process.env.AI_GATEWAY_URL || 'https://parle-ai-gateway.fly.dev').replace(/\/+$/, '');
}

async function apiKey() {
  if (cachedApiKey) return cachedApiKey;
  await loadEnv();
  const keys = process.env.AIGW_LIVE_API_KEY
    || process.env.AIGW_APP_KEY
    || process.env.AI_GATEWAY_KEY
    || process.env.GATEWAY_API_KEY
    || process.env.GATEWAY_API_KEYS?.split(',')[0]?.split(':')[0];
  if (!keys) throw new Error('Set AIGW_LIVE_API_KEY, GATEWAY_API_KEY, or GATEWAY_API_KEYS before running live MCP fine-tune SSH e2e');
  cachedApiKey = keys.trim();
  return cachedApiKey;
}

function parseToolText(payload: unknown): McpToolResult {
  const text = (payload as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text;
  if (!text) return {};
  return JSON.parse(text) as McpToolResult;
}

async function callMcpTool(name: string, args: Record<string, unknown>, id: string) {
  const response = await fetch(`${gatewayUrl()}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await apiKey()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const payload = await response.json() as unknown;
  return { httpStatus: response.status, payload, tool: parseToolText(payload) };
}

function isVastProxyHost(host: string): boolean {
  return /(^|\.)vast\.ai$/i.test(host);
}

async function listMatchingInstances(labelPrefix: string) {
  const list = await callMcpTool('gateway.request', { method: 'GET', path: '/v1/gpu/list' }, `list-${Date.now()}`);
  const body = list.tool.body as { instances?: Array<{ id?: string; instanceId?: string; label?: string; instanceName?: string }> } | undefined;
  const instances = body?.instances ?? [];
  return instances.filter(instance => JSON.stringify(instance).includes(labelPrefix));
}

async function cleanup(labelPrefix: string, parallelSlot: string) {
  await callMcpTool('gpu.deploy.terminate', { body: { parallelSlot, force: true } }, `term-slot-${parallelSlot}`).catch(() => {});
  for (const instance of await listMatchingInstances(labelPrefix).catch(() => [])) {
    const instanceId = instance.id || instance.instanceId;
    if (instanceId) {
      await callMcpTool('gpu.deploy.terminate', { body: { instanceId, force: true } }, `term-inst-${instanceId}`).catch(() => {});
    }
  }
}

liveDescribe('live MCP Vast fine-tune SSH acquisition', () => {
  vi.setConfig({ retry: 0 });

  it('defaults a Vast fine-tune SSH deploy to direct SSH and cleans up the app slot', async () => {
    const labelPrefix = `mcp-ft-ssh-${Date.now().toString(36)}`;
    const parallelSlot = `${labelPrefix}-slot`;
    const body = {
      provider: 'vast',
      dockerImage: 'pytorch/pytorch:2.7.1-cuda12.8-cudnn9-devel',
      gpuTypes: ['NVIDIA GeForce RTX 5090'],
      searchMode: 'high_quality',
      strictFastBoot: true,
      storageGb: 40,
      maxCostUsd: 2.5,
      raceCount: 1,
      finetune: true,
      readinessProbe: 'ssh',
      bootTimeoutSec: 300,
      runSmokeTests: false,
      onstart: 'sleep infinity',
      noTierCascade: true,
      interruptible: false,
      idleTimeoutMin: 5,
      parallelSlot,
      label: labelPrefix,
    };

    try {
      const create = await callMcpTool('gpu.deploy.create', { body }, `create-${labelPrefix}`);
      expect(create.httpStatus).toBe(200);
      expect(create.tool.status).toBe(202);

      const deadline = Date.now() + 660_000;
      let lastStatus: Record<string, unknown> = {};
      while (Date.now() < deadline) {
        const status = await callMcpTool(
          'gateway.request',
          { method: 'GET', path: '/v1/gpu/status', query: { parallelSlot } },
          `status-${Date.now()}`,
        );
        lastStatus = (status.tool.body ?? {}) as Record<string, unknown>;
        const phase = String(lastStatus.phase || lastStatus.status || '');
        const sshHost = String(lastStatus.sshHost || (lastStatus.providerMeta as Record<string, unknown> | undefined)?.sshHost || '');
        const sshPort = Number(lastStatus.sshPort || (lastStatus.providerMeta as Record<string, unknown> | undefined)?.sshPort || 0);

        if (phase === 'ready' || lastStatus.gpuHealthy === true) {
          expect(sshHost).toBeTruthy();
          expect(sshPort).toBeGreaterThan(0);
          expect(isVastProxyHost(sshHost)).toBe(false);
          return;
        }
        if (phase === 'error') {
          throw new Error(`deploy errored before direct SSH: ${JSON.stringify(lastStatus).slice(0, 800)}`);
        }
        await new Promise(resolve => setTimeout(resolve, 10_000));
      }
      throw new Error(`timed out waiting for direct SSH readiness: ${JSON.stringify(lastStatus).slice(0, 800)}`);
    } finally {
      await cleanup(labelPrefix, parallelSlot);
      const deadline = Date.now() + 90_000;
      let matches = [] as Awaited<ReturnType<typeof listMatchingInstances>>;
      do {
        matches = await listMatchingInstances(labelPrefix);
        if (matches.length === 0) break;
        await cleanup(labelPrefix, parallelSlot);
        await new Promise(resolve => setTimeout(resolve, 5_000));
      } while (Date.now() < deadline);
      expect(matches).toEqual([]);
    }
  }, 780_000);
});
