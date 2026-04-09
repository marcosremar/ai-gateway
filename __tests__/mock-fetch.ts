/**
 * HTTP Mock Utility — URL-pattern based fetch interceptor.
 *
 * Provides pre-recorded fixture responses for RunPod and Vast.ai APIs
 * so GPU provider tests run without real credentials.
 *
 * Usage:
 *   import { installMockFetch } from './mock-fetch';
 *
 *   let restoreFetch: (() => void) | undefined;
 *   beforeAll(() => { if (useMock) restoreFetch = installMockFetch(); });
 *   afterAll(() => restoreFetch?.());
 */

import { vi } from 'vitest';

// ── Helpers ────────────────────────────────────────────────────────────────

function jsonResp(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

function getMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

// ── RunPod fixtures ────────────────────────────────────────────────────────

const RUNPOD_BASE = 'https://rest.runpod.io/v1';

const RUNPOD_POD = {
  id: 'mock-pod-rp1',
  name: 'parle-autoscale-mock',
  desiredStatus: 'RUNNING',
  gpuDisplayName: 'NVIDIA GeForce RTX 4090',
  publicIp: '123.45.67.89',
  portMappings: { '8000': 12345 },
  runtime: { gpus: [{ id: 'gpu0', gpuUtil: '70', memUtil: '60' }] },
};

// ── Vast.ai fixtures ────────────────────────────────────────────────────────

const VAST_BASE = 'https://console.vast.ai/api/v0';

const VAST_INST = {
  id: 12345678,
  actual_status: 'running',
  cur_state: 'running',
  gpu_name: 'RTX 4090',
  num_gpus: 1,
  gpu_ram: 24576,
  dph_total: 0.399,
  public_ipaddr: '98.76.54.32',
  ssh_host: '98.76.54.32',
  ssh_port: 22,
  direct_port_start: 32100,
  ports: {
    '8000/tcp': [{ HostIp: '98.76.54.32', HostPort: '32100' }],
  },
  reliability2: 0.98,
  inet_down: 900,
  inet_up: 900,
};

// ── Route table ────────────────────────────────────────────────────────────

type Route = {
  match: (url: string, method: string) => boolean;
  handle: (url: string, init?: RequestInit) => Response;
};

const ROUTES: Route[] = [
  // ── RunPod REST ──────────────────────────────────────────────────────────

  // GET /pods — list all pods
  {
    match: (url, m) => url === `${RUNPOD_BASE}/pods` && m === 'GET',
    handle: () => jsonResp([RUNPOD_POD]),
  },
  // GET /pods/fake* — non-existent pod → 404
  {
    match: (url, m) => url.startsWith(`${RUNPOD_BASE}/pods/fake`) && m === 'GET',
    handle: () => jsonResp({ error: 'pod not found' }, 404),
  },
  // GET /pods/:id — any real pod → 200
  {
    match: (url, m) => url.startsWith(`${RUNPOD_BASE}/pods/`) && m === 'GET',
    handle: () => jsonResp(RUNPOD_POD),
  },

  // ── RunPod GraphQL ───────────────────────────────────────────────────────
  {
    match: (url) => url.includes('runpod.io/graphql'),
    handle: () => jsonResp({
      data: {
        myself: {
          email: 'mock@example.com',
          machineQuota: 10,
          clientBalance: 50.0,
          creditBalance: 50.0,
          currentSpendPerHr: 0.0,
          pods: [],
        },
        gpuTypes: [
          { id: 'NVIDIA GeForce RTX 4090', displayName: 'RTX 4090', memoryInGb: 24, communityPrice: 0.44, securePrice: 0.74 },
          { id: 'NVIDIA GeForce RTX 3090', displayName: 'RTX 3090', memoryInGb: 24, communityPrice: 0.22, securePrice: 0.44 },
        ],
      },
    }),
  },

  // ── Vast.ai REST ─────────────────────────────────────────────────────────

  // GET /instances/ — list all instances
  {
    match: (url, m) => url === `${VAST_BASE}/instances/` && m === 'GET',
    handle: () => jsonResp({ instances: [VAST_INST] }),
  },
  // GET /instances/9999999/ — non-existent (returns empty object → falls through to null)
  {
    match: (url, m) => url.includes('/instances/9999999/') && m === 'GET',
    handle: () => jsonResp({}),
  },
  // GET /instances/:id/ — specific instance
  {
    match: (url, m) => /\/instances\/\d+\//.test(url) && m === 'GET',
    handle: () => jsonResp({ instances: VAST_INST }),
  },
  // GET /endptjobs/ — serverless endpoints (empty)
  {
    match: (url, m) => url.includes('/endptjobs/') && m === 'GET',
    handle: () => jsonResp([]),
  },
  // POST /bundles/ — offer search (sorted ascending by price)
  {
    match: (url, m) => url.includes('/bundles/') && m === 'POST',
    handle: () => jsonResp({
      offers: [
        { id: 22222, gpu_name: 'RTX 3090', num_gpus: 1, gpu_ram: 24576, dph_total: 0.299, reliability2: 0.95, inet_down: 700, inet_up: 400, direct_port_count: 5, rentable: true, rented: false },
        { id: 11111, gpu_name: 'RTX 4090', num_gpus: 1, gpu_ram: 24576, dph_total: 0.399, reliability2: 0.98, inet_down: 900, inet_up: 500, direct_port_count: 5, rentable: true, rented: false },
      ],
    }),
  },
  // GET /users/current/ — account balance
  {
    match: (url, m) => url.includes('/users/current/') && m === 'GET',
    handle: () => jsonResp({ credit: 25.0, email: 'mock@example.com' }),
  },
];

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Install a global fetch mock that routes by URL pattern.
 * Returns a cleanup function — call it in afterAll().
 */
export function installMockFetch(): () => void {
  const mockFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = getUrl(input);
    const method = getMethod(input, init);

    for (const route of ROUTES) {
      if (route.match(url, method)) {
        return route.handle(url, init);
      }
    }

    throw new Error(`[mock-fetch] No handler for: ${method} ${url}\nAdd a route to __tests__/mock-fetch.ts`);
  });

  vi.stubGlobal('fetch', mockFn);
  return () => vi.unstubAllGlobals();
}

/** Mock fetch that always returns a 401 (invalid API key). */
export function installMockFetch401(): () => void {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResp({ error: 'Unauthorized' }, 401)));
  return () => vi.unstubAllGlobals();
}

/**
 * Minimal HTTP server fixture responses for gateway-live tests.
 * Used when no real gateway is running at GATEWAY_URL.
 */
export const GATEWAY_HANDLERS: Route[] = [
  { match: (url) => url.endsWith('/health'), handle: () => jsonResp({ status: 'ok' }) },
  {
    match: (url, m) => url.includes('/v1/chat/completions') && m === 'POST',
    handle: () => jsonResp({
      id: 'mock-chat-1',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'PONG Hello world' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    }),
  },
  {
    match: (url, m) => url.includes('/v1/audio/transcriptions') && m === 'POST',
    handle: () => jsonResp({ text: 'hello world this is a test of speech recognition' }),
  },
  {
    match: (url) => url.includes('/v1/gpu/status'),
    handle: () => jsonResp({ status: 'idle', podId: null }),
  },
  {
    match: (url) => url.includes('/v1/workloads'),
    handle: () => jsonResp({ workloads: [] }),
  },
];
