/**
 * Live MCP/Vast chaos probe.
 *
 * This test is intentionally opt-in because it spends real Vast.ai money.
 * It exercises the public MCP surface, not direct Vast APIs:
 *
 *   RUN_LIVE_MCP_VAST_CHAOS=1 SKIP_LIVE_TESTS=0 bunx vitest run --config vitest.config.ts --no-changed __tests__/mcp-vast-live-chaos.test.ts
 */
import { describe, expect, it } from 'vitest';
import { loadEnv } from './helpers';

type McpToolResult = {
  endpoint?: string;
  status?: number;
  ok?: boolean;
  body?: unknown;
};

const shouldRun = process.env.RUN_LIVE_MCP_VAST_CHAOS === '1' && process.env.SKIP_LIVE_TESTS !== '1';
const liveDescribe = shouldRun ? describe : describe.skip;

function gatewayUrl() {
  return (process.env.AIGW_LIVE_GATEWAY_URL || process.env.AI_GATEWAY_URL || 'https://parle-ai-gateway.fly.dev').replace(/\/+$/, '');
}

function apiKey() {
  loadEnv();
  const keys = process.env.AIGW_LIVE_API_KEY || process.env.GATEWAY_API_KEY || process.env.GATEWAY_API_KEYS?.split(',')[0];
  if (!keys) throw new Error('Set AIGW_LIVE_API_KEY, GATEWAY_API_KEY, or GATEWAY_API_KEYS before running live MCP chaos');
  return keys.trim();
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
      Authorization: `Bearer ${apiKey()}`,
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

async function listMatchingInstances(labelPrefix: string) {
  const list = await callMcpTool('gateway.request', { method: 'GET', path: '/v1/gpu/list' }, `list-${Date.now()}`);
  const body = list.tool.body as { instances?: Array<{ id?: string; instanceId?: string; name?: string; label?: string }> } | undefined;
  const instances = body?.instances ?? [];
  return instances.filter(instance => JSON.stringify(instance).includes(labelPrefix));
}

async function terminateLabel(labelPrefix: string, parallelSlot?: string) {
  if (parallelSlot) {
    await callMcpTool('gpu.deploy.terminate', { body: { parallelSlot } }, `term-slot-${parallelSlot}`);
  }
  for (const instance of await listMatchingInstances(labelPrefix)) {
    const instanceId = instance.id || instance.instanceId;
    if (instanceId) {
      await callMcpTool('gpu.deploy.terminate', { body: { instanceId } }, `term-inst-${instanceId}`);
    }
  }
}

liveDescribe('live MCP Vast chaos', () => {
  it('cancels an app-slot race without leaving delayed Vast instances behind', async () => {
    const labelPrefix = `mcp-live-${Date.now().toString(36)}`;
    const parallelSlot = `${labelPrefix}-slot`;
    const body = {
      provider: 'vast',
      dockerImage: 'nvidia/cuda:12.4.1-base-ubuntu22.04',
      gpuTypes: ['RTX 3060', 'RTX 3060 Ti', 'RTX 3090', 'RTX 4090'],
      searchMode: 'full',
      strictFastBoot: false,
      allowUnverified: true,
      minVramGb: 8,
      storageGb: 20,
      maxCostUsd: 0.5,
      raceCount: 10,
      readinessProbe: 'ssh',
      bootTimeoutSec: 75,
      requireDirectPort: false,
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

      await new Promise(resolve => setTimeout(resolve, 3_000));
      const cancelled = await callMcpTool('gpu.deploy.terminate', { body: { parallelSlot } }, `cancel-${labelPrefix}`);
      expect(cancelled.httpStatus).toBe(200);
      expect(cancelled.tool.status).toBeGreaterThanOrEqual(200);
      expect(cancelled.tool.status).toBeLessThan(300);

      const deadline = Date.now() + 90_000;
      let matches = await listMatchingInstances(labelPrefix);
      while (Date.now() < deadline && matches.length > 0) {
        await terminateLabel(labelPrefix);
        await new Promise(resolve => setTimeout(resolve, 5_000));
        matches = await listMatchingInstances(labelPrefix);
      }
      expect(matches).toEqual([]);
    } finally {
      await terminateLabel(labelPrefix, parallelSlot);
    }
  }, 180_000);
});
