import { describe, expect, it, afterEach } from 'vitest';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import { createProxyServer } from '../src/proxy/server';
import { createGatewayMcpHandler, DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from '../src/gateway/mcp/server';
import type { GatewayMcpOptions } from '../src/gateway/mcp/server';
import type { CustomRoute, ProviderMapping } from '../src/proxy/types';

describe('Gateway MCP endpoint', () => {
  let server: Server | undefined;

  it('uses a 600s default gateway request timeout', () => {
    expect(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS).toBe(600_000);
  });

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function start(
    providers: ProviderMapping = {},
    extraRoutes: CustomRoute[] = [],
    mcpOptions: Partial<GatewayMcpOptions> = {},
  ) {
    server = createProxyServer({
      apiKeys: ['test-key'],
      providers,
      customRoutes: [
        {
          method: 'POST',
          path: '/mcp',
          handler: createGatewayMcpHandler({ providers, ...mcpOptions }),
        },
        ...extraRoutes,
      ],
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as { port: number }).port;
  }

  async function mcp(port: number, body: unknown) {
    return fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  async function mcpRaw(port: number, body: string, contentType = 'application/json') {
    return fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': contentType,
        Accept: 'application/json',
      },
      body,
    });
  }

  async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  }

  function echoRoute(method: string, path: string, status = 200): CustomRoute {
    return {
      method,
      path,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || '/', 'http://localhost');
        const rawBody = await readRequestBody(req);
        const contentType = String(req.headers['content-type'] ?? '');
        let body: unknown = rawBody.toString('utf8');
        if (contentType.includes('application/json') && rawBody.length > 0) {
          try { body = JSON.parse(rawBody.toString('utf8')); } catch { /* keep text */ }
        } else if (rawBody.length > 0) {
          body = { base64: rawBody.toString('base64'), bytes: rawBody.length };
        } else {
          body = null;
        }
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          contentType,
          body,
        }));
      },
    };
  }

  function gatewayEnvelope(payload: unknown): {
    status: number;
    ok: boolean;
    body: { method?: string; path?: string; query?: Record<string, string>; body?: unknown; contentType?: string };
  } {
    return payload as {
      status: number;
      ok: boolean;
      body: { method?: string; path?: string; query?: Record<string, string>; body?: unknown; contentType?: string };
    };
  }

  async function callTool(port: number, name: string, args: Record<string, unknown> = {}) {
    const response = await mcp(port, {
      jsonrpc: '2.0',
      id: `${name}:test`,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    expect(response.status).toBe(200);
    return await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> }; error?: { message: string } };
  }

  async function callToolJson(port: number, name: string, args: Record<string, unknown> = {}) {
    const payload = await callTool(port, name, args);
    expect(payload.error).toBeUndefined();
    const text = payload.result?.content?.[0]?.text ?? '{}';
    return {
      result: payload.result,
      body: JSON.parse(text) as unknown,
    };
  }

  async function listToolNames(port: number): Promise<string[]> {
    const response = await mcp(port, { jsonrpc: '2.0', id: 'tools', method: 'tools/list' });
    expect(response.status).toBe(200);
    const payload = await response.json() as { result?: { tools?: Array<{ name: string }> } };
    return payload.result?.tools?.map((tool) => tool.name).sort() ?? [];
  }

  it('requires gateway bearer auth before MCP handling', async () => {
    const port = await start();
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
  });

  it('exposes gateway MCP tools over Streamable HTTP', async () => {
    const port = await start({
      chat: {
        'test-chat-model': {
          providerId: 'test',
          isConfigured: () => true,
          chat: async () => ({ content: 'ok', model: 'test-chat-model' }),
        } as any,
      },
    });

    const initialize = await mcp(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '1.0.0' },
      },
    });
    expect(initialize.status).toBe(200);

    const tools = await mcp(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(tools.status).toBe(200);
    const payload = await tools.json() as { result?: { tools?: Array<{ name: string }> } };
    expect(payload.result?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'gateway.health',
        'gateway.endpoints.list',
        'gateway.request',
        'models.list',
        'chat.complete',
        'audio.transcribe',
        'speech.translate',
        'images.generate',
        'video.generate',
        'threeD.generate',
        'gpu.status',
        'fineTunes.plan',
        'datasets.kokoro.plan',
        'bots.status',
        'dockerImages.list',
        'workloads.list',
        'config.providers.get',
        'observability.metrics',
        'diagnostics.scores',
        'gateway_health',
        'list_gateway_endpoints',
        'gateway_request',
        'list_models',
        'chat_completion',
        'finetune_plan',
        'finetune_status',
      ]),
    );
  });

  it('lists canonical endpoint categories', async () => {
    const port = await start();
    const response = await mcp(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'gateway.endpoints.list',
        arguments: { category: 'threeD' },
      },
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as { result?: { content?: Array<{ text: string }> } };
    const toolPayload = JSON.parse(payload.result?.content?.[0]?.text ?? '{}') as {
      categories: string[];
      endpoints: Array<{ path: string; category: string }>;
    };
    expect(toolPayload.categories).toEqual(expect.arrayContaining(['gateway', 'models', 'chat', 'audio', 'speech', 'images', 'video', 'threeD']));
    expect(toolPayload.endpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/v1/3d/generate', category: 'threeD' }),
    ]));
  });

  it('proxies allowlisted gateway endpoints with the caller bearer token', async () => {
    const port = await start({}, [
      {
        method: 'GET',
        path: '/v1/gpu/status',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            auth: req.headers.authorization,
          }));
        },
      },
    ]);

    const response = await mcp(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'gateway_request',
        arguments: { method: 'GET', path: '/v1/gpu/status' },
      },
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as { result?: { content?: Array<{ text: string }> } };
    const toolText = payload.result?.content?.[0]?.text ?? '';
    const toolPayload = JSON.parse(toolText) as { status: number; body: { ok: boolean; auth: string } };
    expect(toolPayload.status).toBe(200);
    expect(toolPayload.body).toEqual({ ok: true, auth: 'Bearer test-key' });
  });

  it('supports canonical tool aliases for gateway requests', async () => {
    const port = await start({}, [
      {
        method: 'GET',
        path: '/v1/gpu/status',
        handler: async (_req: IncomingMessage, res: ServerResponse) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'idle' }));
        },
      },
    ]);

    const response = await mcp(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'gpu.status',
        arguments: {},
      },
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as { result?: { content?: Array<{ text: string }> } };
    const toolPayload = JSON.parse(payload.result?.content?.[0]?.text ?? '{}') as { status: number; body: { status: string } };
    expect(toolPayload.status).toBe(200);
    expect(toolPayload.body.status).toBe('idle');
  });

  it('normalizes gpu.offers.list query.gpu to gpuTypes', async () => {
    const port = await start({}, [
      {
        method: 'GET',
        path: '/v1/gpu/offers',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url || '/', 'http://localhost');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            gpu: url.searchParams.get('gpu'),
            gpuTypes: url.searchParams.get('gpuTypes'),
          }));
        },
      },
    ]);

    const response = await mcp(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'gpu.offers.list',
        arguments: { query: { provider: 'vast', gpu: 'RTX 5090', limit: 5 } },
      },
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as { result?: { content?: Array<{ text: string }> } };
    const toolPayload = JSON.parse(payload.result?.content?.[0]?.text ?? '{}') as { status: number; body: { gpu: string; gpuTypes: string } };
    expect(toolPayload.status).toBe(200);
    expect(toolPayload.body).toEqual({ gpu: 'RTX 5090', gpuTypes: 'RTX 5090' });
  });

  it('exercises every advertised MCP tool against safe local fixtures', async () => {
    const audioBytes = Buffer.from('fake-wav');
    const providers: ProviderMapping = {
      chat: {
        'test-chat-model': {
          providerId: 'test',
          isConfigured: () => true,
          chat: async (request) => ({
            content: `echo:${String(request.messages.at(-1)?.content ?? '')}`,
            model: request.model,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          }),
        } as any,
      },
      dynamicModelCatalogs: [
        {
          providerId: 'broken-catalog',
          listModels: async () => { throw new Error('catalog unavailable'); },
        },
      ],
    };

    type ExpectedGatewayCall = {
      method: string;
      path: string;
      query?: Record<string, string>;
      body?: unknown;
      contentType?: string;
    };
    type ToolCase = {
      name: string;
      args?: Record<string, unknown>;
      local?: 'health' | 'endpoints' | 'models' | 'chat';
      expected?: ExpectedGatewayCall;
    };

    const toolCases: ToolCase[] = [
      { name: 'gateway.health', local: 'health' },
      { name: 'gateway.endpoints.list', args: { category: 'gpu' }, local: 'endpoints' },
      { name: 'gateway.request', args: { method: 'GET', path: '/v1/gpu/status' }, expected: { method: 'GET', path: '/v1/gpu/status' } },
      { name: 'models.list', local: 'models' },
      { name: 'chat.complete', args: { model: 'test-chat-model', prompt: 'olá' }, local: 'chat' },
      {
        name: 'audio.transcribe',
        args: { bodyBase64: audioBytes.toString('base64'), contentType: 'audio/wav', query: { model: 'whisper-test' } },
        expected: { method: 'POST', path: '/v1/transcribe', query: { model: 'whisper-test' }, body: { base64: audioBytes.toString('base64'), bytes: audioBytes.length }, contentType: 'audio/wav' },
      },
      { name: 'audio.synthesize', args: { body: { model: 'tts-test', input: 'oi' } }, expected: { method: 'POST', path: '/v1/audio/speech', body: { model: 'tts-test', input: 'oi' } } },
      { name: 'audio.voices.list', expected: { method: 'GET', path: '/v1/tts/voices' } },
      { name: 'speech.translate', args: { body: { text: 'bonjour', targetLanguage: 'en' } }, expected: { method: 'POST', path: '/v1/speech', body: { text: 'bonjour', targetLanguage: 'en' } } },
      { name: 'images.generate', args: { body: { prompt: 'a small test image' } }, expected: { method: 'POST', path: '/v1/images/generate', body: { prompt: 'a small test image' } } },
      { name: 'images.inpaint', args: { body: { image: 'img', mask: 'mask', prompt: 'fill' } }, expected: { method: 'POST', path: '/v1/images/inpaint', body: { image: 'img', mask: 'mask', prompt: 'fill' } } },
      { name: 'video.generate', args: { body: { prompt: 'short clip' } }, expected: { method: 'POST', path: '/v1/video/generate', body: { prompt: 'short clip' } } },
      { name: 'threeD.generate', args: { body: { image: 'base64-image' } }, expected: { method: 'POST', path: '/v1/3d/generate', body: { image: 'base64-image' } } },
      { name: 'gpu.status', expected: { method: 'GET', path: '/v1/gpu/status' } },
      { name: 'gpu.offers.list', args: { query: { provider: 'vast', gpu: 'RTX 5090', limit: 5 } }, expected: { method: 'GET', path: '/v1/gpu/offers', query: { provider: 'vast', gpu: 'RTX 5090', gpuTypes: 'RTX 5090', limit: '5' } } },
      { name: 'gpu.deploy.validate', args: { body: { gpuType: 'NVIDIA GeForce RTX 5090' } }, expected: { method: 'POST', path: '/v1/gpu/deploy/validate', body: { gpuType: 'NVIDIA GeForce RTX 5090' } } },
      { name: 'gpu.deploy.create', args: { body: { gpuType: 'NVIDIA GeForce RTX 5090', dryRun: true } }, expected: { method: 'POST', path: '/v1/gpu/deploy', body: { gpuType: 'NVIDIA GeForce RTX 5090', dryRun: true } } },
      { name: 'gpu.deploy.stop', expected: { method: 'POST', path: '/v1/gpu/stop', body: {} } },
      { name: 'gpu.deploy.resume', expected: { method: 'POST', path: '/v1/gpu/resume', body: {} } },
      { name: 'gpu.deploy.terminate', expected: { method: 'POST', path: '/v1/gpu/terminate', body: {} } },
      { name: 'fineTunes.plan', args: { body: { model: 'kokoro', dataset: 'sample' } }, expected: { method: 'POST', path: '/v1/gpu/finetune/plan', body: { model: 'kokoro', dataset: 'sample' } } },
      { name: 'fineTunes.create', args: { body: { model: 'kokoro', dataset: 'sample', dryRun: true } }, expected: { method: 'POST', path: '/v1/gpu/finetune', body: { model: 'kokoro', dataset: 'sample', dryRun: true } } },
      { name: 'fineTunes.get', args: { jobId: 'ft-1', tail: 7 }, expected: { method: 'GET', path: '/v1/gpu/finetune/status', query: { jobId: 'ft-1', tail: '7' } } },
      { name: 'fineTunes.logs', args: { jobId: 'ft-1', tail: 9 }, expected: { method: 'GET', path: '/v1/gpu/finetune/logs', query: { jobId: 'ft-1', tail: '9' } } },
      { name: 'fineTunes.cancel', args: { jobId: 'ft-1' }, expected: { method: 'POST', path: '/v1/gpu/finetune/cancel', body: { jobId: 'ft-1' } } },
      { name: 'datasets.kokoro.plan', expected: { method: 'POST', path: '/v1/gpu/finetune/kokoro-dataset/plan', body: {} } },
      { name: 'datasets.kokoro.run', expected: { method: 'POST', path: '/v1/gpu/finetune/kokoro-dataset/run', body: {} } },
      { name: 'bots.status', expected: { method: 'GET', path: '/v1/bot/status' } },
      { name: 'bots.deploy', args: { body: { meetingUrl: 'https://meet.example/test' } }, expected: { method: 'POST', path: '/v1/bot/deploy', body: { meetingUrl: 'https://meet.example/test' } } },
      { name: 'bots.join', args: { body: { meetingUrl: 'https://meet.example/test' } }, expected: { method: 'POST', path: '/v1/bot/join', body: { meetingUrl: 'https://meet.example/test' } } },
      { name: 'bots.leave', expected: { method: 'POST', path: '/v1/bot/leave', body: {} } },
      { name: 'dockerImages.list', expected: { method: 'GET', path: '/v1/docker/images' } },
      { name: 'dockerImages.builds.list', expected: { method: 'GET', path: '/v1/docker/builds' } },
      { name: 'dockerImages.build.create', args: { body: { name: 'fixture', context: 'inline' } }, expected: { method: 'POST', path: '/v1/docker/build', body: { name: 'fixture', context: 'inline' } } },
      { name: 'workloads.list', expected: { method: 'GET', path: '/v1/workloads' } },
      { name: 'workloads.create', args: { body: { type: 'gpu', name: 'fixture' } }, expected: { method: 'POST', path: '/v1/workloads', body: { type: 'gpu', name: 'fixture' } } },
      { name: 'config.providers.get', expected: { method: 'GET', path: '/v1/config/providers' } },
      { name: 'config.providers.update', args: { body: { providers: {} } }, expected: { method: 'POST', path: '/v1/config/providers', body: { providers: {} } } },
      { name: 'config.apiKeys.get', expected: { method: 'GET', path: '/v1/config/api-keys' } },
      { name: 'config.apiKeys.set', args: { body: { openai: 'sk-test' } }, expected: { method: 'POST', path: '/v1/config/api-keys', body: { openai: 'sk-test' } } },
      { name: 'observability.metrics', expected: { method: 'GET', path: '/metrics' } },
      { name: 'observability.requests', expected: { method: 'GET', path: '/v1/requests/log' } },
      { name: 'observability.serviceStats', expected: { method: 'GET', path: '/v1/service-stats' } },
      { name: 'diagnostics.scores', expected: { method: 'GET', path: '/v1/diagnostics/scores' } },
      { name: 'diagnostics.benchmark', expected: { method: 'POST', path: '/v1/diagnostics/benchmark', body: {} } },
      { name: 'gateway_health', local: 'health' },
      { name: 'list_gateway_endpoints', args: { category: 'gpu' }, local: 'endpoints' },
      { name: 'gateway_request', args: { method: 'GET', path: '/v1/gpu/status' }, expected: { method: 'GET', path: '/v1/gpu/status' } },
      { name: 'list_models', local: 'models' },
      { name: 'chat_completion', args: { model: 'test-chat-model', prompt: 'olá' }, local: 'chat' },
      { name: 'gpu_status', expected: { method: 'GET', path: '/v1/gpu/status' } },
      { name: 'gpu_offers', args: { query: { provider: 'vast', gpuName: 'RTX 5090' } }, expected: { method: 'GET', path: '/v1/gpu/offers', query: { provider: 'vast', gpuName: 'RTX 5090', gpuTypes: 'RTX 5090' } } },
      { name: 'gpu_deploy_validate', args: { body: { gpuType: 'NVIDIA GeForce RTX 5090' } }, expected: { method: 'POST', path: '/v1/gpu/deploy/validate', body: { gpuType: 'NVIDIA GeForce RTX 5090' } } },
      { name: 'finetune_plan', args: { body: { model: 'kokoro' } }, expected: { method: 'POST', path: '/v1/gpu/finetune/plan', body: { model: 'kokoro' } } },
      { name: 'finetune_start', args: { body: { model: 'kokoro', dryRun: true } }, expected: { method: 'POST', path: '/v1/gpu/finetune', body: { model: 'kokoro', dryRun: true } } },
      { name: 'finetune_status', args: { jobId: 'ft-legacy', tail: 3 }, expected: { method: 'GET', path: '/v1/gpu/finetune/status', query: { jobId: 'ft-legacy', tail: '3' } } },
      { name: 'finetune_logs', args: { jobId: 'ft-legacy', tail: 4 }, expected: { method: 'GET', path: '/v1/gpu/finetune/logs', query: { jobId: 'ft-legacy', tail: '4' } } },
      { name: 'finetune_cancel', args: { jobId: 'ft-legacy' }, expected: { method: 'POST', path: '/v1/gpu/finetune/cancel', body: { jobId: 'ft-legacy' } } },
      { name: 'kokoro_dataset_plan', expected: { method: 'POST', path: '/v1/gpu/finetune/kokoro-dataset/plan', body: {} } },
      { name: 'kokoro_dataset_run', expected: { method: 'POST', path: '/v1/gpu/finetune/kokoro-dataset/run', body: {} } },
    ];

    const routes = Array.from(new Map(
      toolCases
        .filter((toolCase) => toolCase.expected)
        .map((toolCase) => {
          const expected = toolCase.expected!;
          return [`${expected.method} ${expected.path}`, echoRoute(expected.method, expected.path)] as const;
        }),
    ).values());
    const port = await start(providers, routes);

    expect(toolCases.map((toolCase) => toolCase.name).sort()).toEqual(await listToolNames(port));

    for (const toolCase of toolCases) {
      const { result, body } = await callToolJson(port, toolCase.name, toolCase.args ?? {});
      expect(result?.isError, toolCase.name).toBeUndefined();

      if (toolCase.local === 'health') {
        expect(body).toMatchObject({ status: 'ok', service: 'ai-gateway-mcp' });
        continue;
      }
      if (toolCase.local === 'endpoints') {
        expect((body as { endpoints?: Array<{ category: string }> }).endpoints?.every((endpoint) => endpoint.category === 'gpu')).toBe(true);
        continue;
      }
      if (toolCase.local === 'models') {
        expect((body as { data?: Array<{ id: string }> }).data).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'test-chat-model' }),
        ]));
        continue;
      }
      if (toolCase.local === 'chat') {
        expect(body).toMatchObject({ model: 'test-chat-model' });
        expect(JSON.stringify(body)).toContain('echo:olá');
        continue;
      }

      const expected = toolCase.expected!;
      const envelope = gatewayEnvelope(body);
      expect(envelope.status, toolCase.name).toBe(200);
      expect(envelope.ok, toolCase.name).toBe(true);
      expect(envelope.body.method, toolCase.name).toBe(expected.method);
      expect(envelope.body.path, toolCase.name).toBe(expected.path);
      if (expected.query) {
        expect(envelope.body.query, toolCase.name).toEqual(expect.objectContaining(expected.query));
      }
      if (expected.body !== undefined) {
        expect(envelope.body.body, toolCase.name).toEqual(expected.body);
      }
      if (expected.contentType) {
        expect(envelope.body.contentType, toolCase.name).toContain(expected.contentType);
      }
    }
  });

  it('rejects arbitrary paths outside the gateway endpoint catalog', async () => {
    const port = await start();
    const response = await mcp(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'gateway_request',
        arguments: { method: 'GET', path: '/not-a-gateway-route' },
      },
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(payload.result?.isError).toBe(true);
    expect(payload.result?.content?.[0]?.text).toContain('Endpoint is not exposed through MCP');
  });

  it('marks non-2xx gateway responses as MCP tool errors while preserving payload', async () => {
    const port = await start({}, [
      {
        method: 'GET',
        path: '/v1/gpu/status',
        handler: async (_req: IncomingMessage, res: ServerResponse) => {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'provider cascade unavailable' } }));
        },
      },
    ]);

    const { result, body } = await callToolJson(port, 'gpu.status');
    expect(result?.isError).toBe(true);
    expect(body).toMatchObject({
      status: 503,
      ok: false,
      body: { error: { message: 'provider cascade unavailable' } },
    });
  });

  it('returns a structured MCP tool error when the gateway cannot be reached', async () => {
    const port = await start({}, [], {
      baseUrl: 'http://127.0.0.1:1',
      requestTimeoutMs: 25,
    });

    const { result, body } = await callToolJson(port, 'gpu.status');
    expect(result?.isError).toBe(true);
    expect(body).toMatchObject({
      status: 0,
      ok: false,
      method: 'GET',
      path: '/v1/gpu/status',
      error: { type: 'gateway_request_error' },
    });
  });

  it('rejects invalid fixed-tool base64 bodies before proxying to the gateway', async () => {
    const port = await start({}, [
      echoRoute('POST', '/v1/transcribe'),
    ]);

    const payload = await callTool(port, 'audio.transcribe', {
      bodyBase64: 'not valid base64%%',
      contentType: 'audio/wav',
    });

    expect(payload.result?.isError).toBe(true);
    expect(payload.result?.content?.[0]?.text).toContain('bodyBase64 must be valid base64');
  });

  it('rejects invalid JSON-RPC params and malformed JSON with protocol errors', async () => {
    const port = await start();

    const badParams = await mcp(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: [],
    });
    expect(badParams.status).toBe(200);
    expect(await badParams.json()).toMatchObject({
      error: { code: -32602, message: 'params must be an object' },
    });

    const badArgs = await mcp(port, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'gateway.health', arguments: [] },
    });
    expect(badArgs.status).toBe(200);
    expect(await badArgs.json()).toMatchObject({
      error: { code: -32602, message: 'params.arguments must be an object' },
    });

    const malformed = await mcpRaw(port, '{"jsonrpc":"2.0",');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { code: -32700, message: 'Parse error' },
    });
  });

  it('handles JSON-RPC batches and notifications without producing phantom responses', async () => {
    const port = await start({}, [
      echoRoute('GET', '/v1/gpu/status'),
    ]);

    const batch = await mcp(port, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gateway.health', arguments: {} } },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gpu.status', arguments: {} } },
    ]);
    expect(batch.status).toBe(200);
    const batchPayload = await batch.json() as Array<{ id: number | string | null }>;
    expect(batchPayload.map((item) => item.id)).toEqual([1, 2]);

    const notificationOnly = await mcp(port, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    expect(notificationOnly.status).toBe(204);

    const emptyBatch = await mcp(port, []);
    expect(emptyBatch.status).toBe(400);
    expect(await emptyBatch.json()).toMatchObject({
      error: { code: -32600, message: 'Invalid JSON-RPC batch' },
    });
  });
});
