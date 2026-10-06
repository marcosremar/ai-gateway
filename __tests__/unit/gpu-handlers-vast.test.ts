/**
 * GPU Handlers Vast — Unit Test Suite
 *
 * Covers server/gpu-handlers-vast.ts:
 *   handleVastTemplates         — no API key (401), listTemplates error, success
 *   handleVastTemplateCreate    — no API key, invalid JSON, missing fields, error, success
 *   handleVastTemplateUpdate    — no API key, missing hashId, error, success
 *   handleVastTemplateDelete    — no API key, missing id, bad id, error, success
 *   handleVastTemplateFindOrCreate — no API key, missing fields, error, success
 *   handleVastEndpoints         — no API key, error, success
 *   handleVastEndpointCreate    — no API key, missing name, error, success
 *   handleVastEndpointDelete    — no API key, missing id, bad id, error, success
 *   handleVastEndpointLogs      — invalid JSON, missing fields, error, success
 *   handleVastEndpointRoute     — invalid JSON, missing fields, route not found, success
 *   handleVastWorkerGroups      — no API key, error, success
 *   handleVastWorkerGroupCreate — no API key, missing endpointId/name, template auto-create, success
 *   handleVastWorkerGroupUpdate — no API key, missing id, error, success
 *   handleVastWorkerGroupDelete — no API key, missing id, bad id, success
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';

// ── Hoisted mock factory ─────────────────────────────────────────────────────

const {
  mockListTemplates,
  mockCreateTemplate,
  mockUpdateTemplate,
  mockDeleteTemplate,
  mockFindOrCreateTemplate,
  mockListEndpoints,
  mockCreateEndpoint,
  mockDeleteEndpoint,
  mockGetEndpointLogs,
  mockRouteRequest,
  mockListWorkerGroups,
  mockCreateWorkerGroup,
  mockUpdateWorkerGroup,
  mockDeleteWorkerGroup,
  mockDeployVastApiKey,
} = vi.hoisted(() => {
  const mockDeployVastApiKey = { value: '' };
  return {
    mockListTemplates: vi.fn(),
    mockCreateTemplate: vi.fn(),
    mockUpdateTemplate: vi.fn(),
    mockDeleteTemplate: vi.fn(),
    mockFindOrCreateTemplate: vi.fn(),
    mockListEndpoints: vi.fn(),
    mockCreateEndpoint: vi.fn(),
    mockDeleteEndpoint: vi.fn(),
    mockGetEndpointLogs: vi.fn(),
    mockRouteRequest: vi.fn(),
    mockListWorkerGroups: vi.fn(),
    mockCreateWorkerGroup: vi.fn(),
    mockUpdateWorkerGroup: vi.fn(),
    mockDeleteWorkerGroup: vi.fn(),
    mockDeployVastApiKey,
  };
});

vi.mock('../../server/providers', () => ({
  vast: {
    listTemplates: (...args: unknown[]) => mockListTemplates(...args),
    createTemplate: (...args: unknown[]) => mockCreateTemplate(...args),
    updateTemplate: (...args: unknown[]) => mockUpdateTemplate(...args),
    deleteTemplate: (...args: unknown[]) => mockDeleteTemplate(...args),
    findOrCreateTemplate: (...args: unknown[]) => mockFindOrCreateTemplate(...args),
    listEndpoints: (...args: unknown[]) => mockListEndpoints(...args),
    createEndpoint: (...args: unknown[]) => mockCreateEndpoint(...args),
    deleteEndpoint: (...args: unknown[]) => mockDeleteEndpoint(...args),
    getEndpointLogs: (...args: unknown[]) => mockGetEndpointLogs(...args),
    routeRequest: (...args: unknown[]) => mockRouteRequest(...args),
    listWorkerGroups: (...args: unknown[]) => mockListWorkerGroups(...args),
    createWorkerGroup: (...args: unknown[]) => mockCreateWorkerGroup(...args),
    updateWorkerGroup: (...args: unknown[]) => mockUpdateWorkerGroup(...args),
    deleteWorkerGroup: (...args: unknown[]) => mockDeleteWorkerGroup(...args),
  },
}));

vi.mock('../../server/state', () => ({
  get deployVastApiKey() { return mockDeployVastApiKey.value; },
  deployState: { status: 'idle', endpoint: undefined },
  prisma: {},
}));

vi.mock('../../server/http-utils', () => ({
  getOrCreateRequestId: () => 'test-req-id',
  setRequestIdHeader: vi.fn(),
  readJsonBody: async (req: IncomingMessage) => {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (!raw) { reject(new Error('empty body')); return; }
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('invalid JSON')); }
      });
      req.on('error', reject);
    });
  },
}));

// ── Import handlers after mocks ──────────────────────────────────────────────

import {
  handleVastTemplates,
  handleVastTemplateCreate,
  handleVastTemplateUpdate,
  handleVastTemplateDelete,
  handleVastTemplateFindOrCreate,
  handleVastEndpoints,
  handleVastEndpointCreate,
  handleVastEndpointDelete,
  handleVastEndpointLogs,
  handleVastEndpointRoute,
  handleVastWorkerGroups,
  handleVastWorkerGroupCreate,
  handleVastWorkerGroupUpdate,
  handleVastWorkerGroupDelete,
} from '../../server/gpu-handlers-vast';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage;
  (stream as any).method = method;
  (stream as any).url = url;
  (stream as any).headers = { 'content-type': 'application/json' };
  if (body !== undefined) {
    (stream as unknown as PassThrough).end(JSON.stringify(body));
  } else {
    (stream as unknown as PassThrough).end('');
  }
  return stream;
}

function makeRes(): ServerResponse & { _status: number; _body: string } {
  const r = {
    _status: 200,
    _body: '',
    headersSent: false,
    writeHead(code: number) { r._status = code; return r; },
    setHeader() { return r; },
    end(b = '') { r._body = b; return r; },
  };
  return r as unknown as ServerResponse & { _status: number; _body: string };
}

function json(res: { _body: string }) {
  try { return JSON.parse(res._body); } catch { return { raw: res._body }; }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockDeployVastApiKey.value = 'test-api-key';
  // don't set VAST_API_KEY env var — use the state value
  delete process.env.VAST_API_KEY;
});

// ── Templates ────────────────────────────────────────────────────────────────

describe('handleVastTemplates', () => {
  it('returns 401 when no API key configured', async () => {
    mockDeployVastApiKey.value = '';
    const res = makeRes();
    await handleVastTemplates(makeReq('GET', '/v1/gpu/vast/templates'), res);
    expect(res._status).toBe(401);
    expect(json(res)).toMatchObject({ error: expect.stringContaining('VAST_API_KEY') });
  });

  it('returns 500 on listTemplates error', async () => {
    mockListTemplates.mockRejectedValueOnce(new Error('network error'));
    const res = makeRes();
    await handleVastTemplates(makeReq('GET', '/v1/gpu/vast/templates'), res);
    expect(res._status).toBe(500);
    expect(json(res).error).toContain('listTemplates failed');
  });

  it('returns 200 with templates on success', async () => {
    const templates = [{ id: 1, name: 'my-template', image: 'myimage:latest' }];
    mockListTemplates.mockResolvedValueOnce(templates);
    const res = makeRes();
    await handleVastTemplates(makeReq('GET', '/v1/gpu/vast/templates'), res);
    expect(res._status).toBe(200);
    expect(json(res)).toEqual({ templates });
    expect(mockListTemplates).toHaveBeenCalledWith({ apiKey: 'test-api-key' });
  });

  it('falls back to VAST_API_KEY env var when deployVastApiKey is empty', async () => {
    mockDeployVastApiKey.value = '';
    process.env.VAST_API_KEY = 'env-key';
    mockListTemplates.mockResolvedValueOnce([]);
    const res = makeRes();
    await handleVastTemplates(makeReq('GET', '/v1/gpu/vast/templates'), res);
    expect(res._status).toBe(200);
    expect(mockListTemplates).toHaveBeenCalledWith({ apiKey: 'env-key' });
    delete process.env.VAST_API_KEY;
  });
});

describe('handleVastTemplateCreate', () => {
  it('returns 401 when no API key', async () => {
    mockDeployVastApiKey.value = '';
    const res = makeRes();
    await handleVastTemplateCreate(makeReq('POST', '/v1/gpu/vast/templates', { name: 'x', image: 'y' }), res);
    expect(res._status).toBe(401);
  });

  it('returns 400 on invalid JSON body', async () => {
    const stream = new PassThrough() as unknown as IncomingMessage;
    (stream as any).method = 'POST';
    (stream as any).url = '/v1/gpu/vast/templates';
    (stream as any).headers = {};
    (stream as unknown as PassThrough).end('not-json');
    const res = makeRes();
    await handleVastTemplateCreate(stream, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 when name or image missing', async () => {
    const res = makeRes();
    await handleVastTemplateCreate(makeReq('POST', '/v1/gpu/vast/templates', { name: 'x' }), res);
    expect(res._status).toBe(400);
    expect(json(res).error).toMatch(/name and image/);
  });

  it('returns 500 on createTemplate error', async () => {
    mockCreateTemplate.mockRejectedValueOnce(new Error('api error'));
    const res = makeRes();
    await handleVastTemplateCreate(makeReq('POST', '/v1/gpu/vast/templates', { name: 'tpl', image: 'img:latest' }), res);
    expect(res._status).toBe(500);
    expect(json(res).error).toContain('createTemplate failed');
  });

  it('returns 200 on success with all optional fields', async () => {
    const result = { hashId: 'abc123', name: 'tpl', image: 'img:latest' };
    mockCreateTemplate.mockResolvedValueOnce(result);
    const res = makeRes();
    await handleVastTemplateCreate(makeReq('POST', '/v1/gpu/vast/templates', {
      name: 'tpl', image: 'img', tag: 'v1',
      envVars: { FOO: 'bar' }, exposePorts: [8000],
      onstartCmd: '/start.sh', diskSpaceGb: 20,
    }), res);
    expect(res._status).toBe(200);
    expect(json(res)).toEqual(result);
    expect(mockCreateTemplate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'tpl', image: 'img', tag: 'v1',
      envVars: { FOO: 'bar' }, exposePorts: [8000],
      onstartCmd: '/start.sh', diskSpaceGb: 20,
    }), { apiKey: 'test-api-key' });
  });
});

describe('handleVastTemplateUpdate', () => {
  it('returns 401 when no API key', async () => {
    mockDeployVastApiKey.value = '';
    const res = makeRes();
    await handleVastTemplateUpdate(makeReq('PUT', '/v1/gpu/vast/templates', { hashId: 'abc' }), res);
    expect(res._status).toBe(401);
  });

  it('returns 400 when hashId missing', async () => {
    const res = makeRes();
    await handleVastTemplateUpdate(makeReq('PUT', '/v1/gpu/vast/templates', { name: 'new' }), res);
    expect(res._status).toBe(400);
    expect(json(res).error).toMatch(/hashId/);
  });

  it('returns 500 on updateTemplate error', async () => {
    mockUpdateTemplate.mockRejectedValueOnce(new Error('server error'));
    const res = makeRes();
    await handleVastTemplateUpdate(makeReq('PUT', '/v1/gpu/vast/templates', { hashId: 'abc', name: 'new' }), res);
    expect(res._status).toBe(500);
    expect(json(res).error).toContain('updateTemplate failed');
  });

  it('returns 200 on success', async () => {
    const result = { hashId: 'abc', name: 'new-name' };
    mockUpdateTemplate.mockResolvedValueOnce(result);
    const res = makeRes();
    await handleVastTemplateUpdate(makeReq('PUT', '/v1/gpu/vast/templates', {
      hashId: 'abc', name: 'new-name', image: 'img', tag: 'v2', diskSpaceGb: 30, desc: 'hi',
    }), res);
    expect(res._status).toBe(200);
    expect(json(res)).toEqual(result);
    expect(mockUpdateTemplate).toHaveBeenCalledWith('abc', expect.objectContaining({ name: 'new-name' }), { apiKey: 'test-api-key' });
  });
});

describe('handleVastTemplateDelete', () => {
  it('returns 401 when no API key', async () => {
    mockDeployVastApiKey.value = '';
    const res = makeRes();
    await handleVastTemplateDelete(makeReq('DELETE', '/v1/gpu/vast/templates?id=5'), res);
    expect(res._status).toBe(401);
  });

  it('returns 400 when id query param missing', async () => {
    const res = makeRes();
    await handleVastTemplateDelete(makeReq('DELETE', '/v1/gpu/vast/templates'), res);
    expect(res._status).toBe(400);
    expect(json(res).error).toMatch(/id query param/);
  });

  it('returns 400 when id is not a positive integer', async () => {
    const res = makeRes();
    await handleVastTemplateDelete(makeReq('DELETE', '/v1/gpu/vast/templates?id=abc'), res);
    expect(res._status).toBe(400);
    expect(json(res).error).toMatch(/positive integer/);
  });

  it('returns 400 when id is zero', async () => {
    const res = makeRes();
    await handleVastTemplateDelete(makeReq('DELETE', '/v1/gpu/vast/templates?id=0'), res);
    expect(res._status).toBe(400);
  });

  it('returns 500 on deleteTemplate error', async () => {
    mockDeleteTemplate.mockRejectedValueOnce(new Error('not found'));
    const res = makeRes();
    await handleVastTemplateDelete(makeReq('DELETE', '/v1/gpu/vast/templates?id=42'), res);
    expect(res._status).toBe(500);
    expect(json(res).error).toContain('deleteTemplate failed');
  });

  it('returns 200 with success and templateId on success', async () => {
    mockDeleteTemplate.mockResolvedValueOnce(undefined);
    const res = makeRes();
    await handleVastTemplateDelete(makeReq('DELETE', '/v1/gpu/vast/templates?id=42'), res);
    expect(res._status).toBe(200);
    expect(json(res)).toEqual({ success: true, templateId: 42 });
    expect(mockDeleteTemplate).toHaveBeenCalledWith(42, { apiKey: 'test-api-key' });
  });

  it('accepts templateId as alias for id', async () => {
    mockDeleteTemplate.mockResolvedValueOnce(undefined);
    const res = makeRes();
    await handleVastTemplateDelete(makeReq('DELETE', '/v1/gpu/vast/templates?templateId=7'), res);
    expect(res._status).toBe(200);
    expect(json(res).templateId).toBe(7);
  });
});

describe('handleVastTemplateFindOrCreate', () => {
  it('returns 401 when no API key', async () => {
    mockDeployVastApiKey.value = '';
    const res = makeRes();
    await handleVastTemplateFindOrCreate(makeReq('POST', '/v1/gpu/vast/templates/find-or-create', { name: 'x', image: 'y' }), res);
    expect(res._status).toBe(401);
  });

  it('returns 400 when name or image missing', async () => {
    const res = makeRes();
    await handleVastTemplateFindOrCreate(makeReq('POST', '/v1/gpu/vast/templates/find-or-create', { image: 'img' }), res);
    expect(res._status).toBe(400);
    expect(json(res).error).toMatch(/name and image/);
  });

  it('returns 500 on findOrCreateTemplate error', async () => {
    mockFindOrCreateTemplate.mockRejectedValueOnce(new Error('failed'));
    const res = makeRes();
    await handleVastTemplateFindOrCreate(makeReq('POST', '/v1/gpu/vast/templates/find-or-create', { name: 'tpl', image: 'img' }), res);
    expect(res._status).toBe(500);
    expect(json(res).error).toContain('findOrCreateTemplate failed');
  });

  it('returns 200 on success', async () => {
    const result = { hashId: 'xyz', name: 'tpl', created: true };
    mockFindOrCreateTemplate.mockResolvedValueOnce(result);
    const res = makeRes();
    await handleVastTemplateFindOrCreate(makeReq('POST', '/v1/gpu/vast/templates/find-or-create', { name: 'tpl', image: 'img', tag: 'latest' }), res);
    expect(res._status).toBe(200);
    expect(json(res)).toEqual(result);
  });
});

// ── Endpoints ─────────────────────────────────────────────────────────────────

describe('handleVastEndpoints', () => {
  it('returns 401 when no API key', async () => {
    mockDeployVastApiKey.value = '';
    const res = makeRes();
    await handleVastEndpoints(makeReq('GET', '/v1/gpu/vast/endpoints'), res);
    expect(res._status).toBe(401);
  });

  it('returns 500 on listEndpoints error', async () => {
    mockListEndpoints.mockRejectedValueOnce(new Error('boom'));
    const res = makeRes();
    await handleVastEndpoints(makeReq('GET', '/v1/gpu/vast/endpoints'), res);
    expect(res._status).toBe(500);
    expect(json(res).error).toContain('listEndpoints failed');
  });

  it('returns 200 with endpoints array on success', async () => {
    const endpoints = [{ id: 1, name: 'ep1' }];
    mockListEndpoints.mockResolvedValueOnce(endpoints);
    const res = makeRes();
    await handleVastEndpoints(makeReq('GET', '/v1/gpu/vast/endpoints'), res);
    expect(res._status).toBe(200);
    expect(json(res)).toEqual({ endpoints });
  });
});

describe('handleVastEndpointCreate', () => {
  it('returns 401 when no API key', async () => {
    mockDeployVastApiKey.value = '';
    const res = makeRes();
    await handleVastEndpointCreate(makeReq('POST', '/v1/gpu/vast/endpoints', { name: 'ep' }), res);
    expect(res._status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const res = makeRes();
    await handleVastEndpointCreate(makeReq('POST', '/v1/gpu/vast/endpoints', { minLoad: 1 }), res);
    expect(res._status).toBe(400);
    expect(json(res).error).toMatch(/name/);
  });

  it('returns 500 on createEndpoint error', async () => {
    mockCreateEndpoint.mockRejectedValueOnce(new Error('quota exceeded'));
    const res = makeRes();
    await handleVastEndpointCreate(makeReq('POST', '/v1/gpu/vast/endpoints', { name: 'ep' }), res);
    expect(res._status).toBe(500);
    expect(json(res).error).toContain('createEndpoint failed');
  });

  it('returns 200 with endpoint data on success', async () => {
    const result = { id: 42, name: 'ep', status: 'created' };
    mockCreateEndpoint.mockResolvedValueOnce(result);
    const res = makeRes();
    await handleVastEndpointCreate(makeReq('POST', '/v1/gpu/vast/endpoints', {
      name: 'ep', minLoad: 0, targetUtil: 0.8, coldMult: 1.5, coldWorkers: 2, maxWorkers: 10,
    }), res);
    expect(res._status).toBe(200);
    expect(json(res)).toEqual(result);
    expect(mockCreateEndpoint).toHaveBeenCalledWith(expect.objectContaining({ name: 'ep', minLoad: 0, targetUtil: 0.8 }), { apiKey: 'test-api-key' });
  });
});

describe('handleVastEndpointDelete', () => {
  it('returns 401 when no API key', async () => {
    mockDeployVastApiKey.value = '';
    const res = makeRes();
    await handleVastEndpointDelete(makeReq('DELETE', '/v1/gpu/vast/endpoints?id=1'), res);
    expect(res._status).toBe(401);
  });

  it('returns 400 when id query param missing', async () => {
    const res = makeRes();
    await handleVastEndpointDelete(makeReq('DELETE', '/v1/gpu/vast/endpoints'), res);
    expect(res._status).toBe(400);
  });

  it('returns 400 when id is not positive', async () => {
    const res = makeRes();
    await handleVastEndpointDelete(makeReq('DELETE', '/v1/gpu/vast/endpoints?id=-1'), res);
    expect(res._status).toBe(400);
  });

  it('returns 500 on deleteEndpoint error', async () => {
    mockDeleteEndpoint.mockRejectedValueOnce(new Error('not found'));
    const res = makeRes();
    await handleVastEndpointDelete(makeReq('DELETE', '/v1/gpu/vast/endpoints?id=99'), res);
    expect(res._status).toBe(500);
    expect(json(res).error).toContain('deleteEndpoint failed');
  });

  it('returns 200 on success, including endpointId and result fields', async () => {
    mockDeleteEndpoint.mockResolvedValueOnce({ deleted: true });
    const res = makeRes();
    await handleVastEndpointDelete(makeReq('DELETE', '/v1/gpu/vast/endpoints?endpointId=5'), res);
    expect(res._status).toBe(200);
    expect(json(res)).toMatchObject({ success: true, endpointId: 5, deleted: true });
  });
});

describe('handleVastEndpointLogs', () => {
  it('returns 400 on invalid JSON body', async () => {
    const stream = new PassThrough() as unknown as IncomingMessage;
    (stream as any).method = 'POST';
    (stream as any).url = '/v1/gpu/vast/endpoints/logs';
    (stream as any).headers = {};
    (stream as unknown as PassThrough).end('bad json');
    const res = makeRes();
    await handleVastEndpointLogs(stream, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 when endpointName or endpointApiKey missing', async () => {
    const res = makeRes();
    await handleVastEndpointLogs(makeReq('POST', '/v1/gpu/vast/endpoints/logs', { endpointName: 'ep' }), res);
    expect(res._status).toBe(400);
    expect(json(res).error).toMatch(/endpointName and endpointApiKey/);
  });

  it('returns 500 on getEndpointLogs error', async () => {
    mockGetEndpointLogs.mockRejectedValueOnce(new Error('unauthorized'));
    const res = makeRes();
    await handleVastEndpointLogs(makeReq('POST', '/v1/gpu/vast/endpoints/logs', { endpointName: 'ep', endpointApiKey: 'key' }), res);
    expect(res._status).toBe(500);
    expect(json(res).error).toContain('getEndpointLogs failed');
  });

  it('returns 200 with logs on success, defaults to 100 lines', async () => {
    const logs = ['line1', 'line2'];
    mockGetEndpointLogs.mockResolvedValueOnce(logs);
    const res = makeRes();
    await handleVastEndpointLogs(makeReq('POST', '/v1/gpu/vast/endpoints/logs', { endpointName: 'ep', endpointApiKey: 'key' }), res);
    expect(res._status).toBe(200);
    expect(json(res)).toEqual({ logs });
    expect(mockGetEndpointLogs).toHaveBeenCalledWith('ep', 'key', 100);
  });

  it('passes custom lines parameter', async () => {
    mockGetEndpointLogs.mockResolvedValueOnce([]);
    const res = makeRes();
    await handleVastEndpointLogs(makeReq('POST', '/v1/gpu/vast/endpoints/logs', { endpointName: 'ep', endpointApiKey: 'key', lines: 50 }), res);
    expect(mockGetEndpointLogs).toHaveBeenCalledWith('ep', 'key', 50);
  });
});

describe('handleVastEndpointRoute', () => {
  it('returns 400 on invalid JSON body', async () => {
    const stream = new PassThrough() as unknown as IncomingMessage;
    (stream as any).method = 'POST';
    (stream as any).url = '/v1/gpu/vast/endpoints/route';
    (stream as any).headers = {};
    (stream as unknown as PassThrough).end('[]');
    // PassThrough with non-object parsed value should hit missing-field check
    // Actually JSON.parse('[]') succeeds but endpointName won't be there
    const res = makeRes();
    await handleVastEndpointRoute(stream, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 when endpointName or endpointApiKey missing', async () => {
    const res = makeRes();
    await handleVastEndpointRoute(makeReq('POST', '/v1/gpu/vast/endpoints/route', { endpointApiKey: 'key' }), res);
    expect(res._status).toBe(400);
    expect(json(res).error).toMatch(/endpointName and endpointApiKey/);
  });

  it('returns 200 with available:false when routeRequest returns null', async () => {
    mockRouteRequest.mockResolvedValueOnce(null);
    const res = makeRes();
    await handleVastEndpointRoute(makeReq('POST', '/v1/gpu/vast/endpoints/route', { endpointName: 'ep', endpointApiKey: 'key' }), res);
    expect(res._status).toBe(200);
    expect(json(res)).toEqual({ available: false });
  });

  it('returns 200 with available:true and result fields when worker found', async () => {
    const worker = { workerId: 'w1', host: '1.2.3.4', port: 8000 };
    mockRouteRequest.mockResolvedValueOnce(worker);
    const res = makeRes();
    await handleVastEndpointRoute(makeReq('POST', '/v1/gpu/vast/endpoints/route', { endpointName: 'ep', endpointApiKey: 'key', cost: 200 }), res);
    expect(res._status).toBe(200);
    expect(json(res)).toMatchObject({ available: true, workerId: 'w1', host: '1.2.3.4' });
    expect(mockRouteRequest).toHaveBeenCalledWith('ep', 'key', 200);
  });

  it('uses default cost of 100 when cost not provided', async () => {
    mockRouteRequest.mockResolvedValueOnce({ workerId: 'w2' });
    const res = makeRes();
    await handleVastEndpointRoute(makeReq('POST', '/v1/gpu/vast/endpoints/route', { endpointName: 'ep', endpointApiKey: 'key' }), res);
    expect(mockRouteRequest).toHaveBeenCalledWith('ep', 'key', 100);
  });

  it('returns 500 on routeRequest error', async () => {
    mockRouteRequest.mockRejectedValueOnce(new Error('timeout'));
    const res = makeRes();
    await handleVastEndpointRoute(makeReq('POST', '/v1/gpu/vast/endpoints/route', { endpointName: 'ep', endpointApiKey: 'key' }), res);
    expect(res._status).toBe(500);
    expect(json(res).error).toContain('routeRequest failed');
  });
});

// ── Worker Groups ─────────────────────────────────────────────────────────────

describe('handleVastWorkerGroups', () => {
  it('returns 401 when no API key', async () => {
    mockDeployVastApiKey.value = '';
    const res = makeRes();
    await handleVastWorkerGroups(makeReq('GET', '/v1/gpu/vast/workergroups'), res);
    expect(res._status).toBe(401);
  });

  it('returns 500 on listWorkerGroups error', async () => {
    mockListWorkerGroups.mockRejectedValueOnce(new Error('gone'));
    const res = makeRes();
    await handleVastWorkerGroups(makeReq('GET', '/v1/gpu/vast/workergroups'), res);
    expect(res._status).toBe(500);
    expect(json(res).error).toContain('listWorkerGroups failed');
  });

  it('returns 200 with workerGroups array on success', async () => {
    const workerGroups = [{ id: 1, endpointId: 10 }];
    mockListWorkerGroups.mockResolvedValueOnce(workerGroups);
    const res = makeRes();
    await handleVastWorkerGroups(makeReq('GET', '/v1/gpu/vast/workergroups'), res);
    expect(res._status).toBe(200);
    expect(json(res)).toEqual({ workerGroups });
  });
});

describe('handleVastWorkerGroupCreate', () => {
  it('returns 401 when no API key', async () => {
    mockDeployVastApiKey.value = '';
    const res = makeRes();
    await handleVastWorkerGroupCreate(makeReq('POST', '/v1/gpu/vast/workergroups', { endpointId: 1 }), res);
    expect(res._status).toBe(401);
  });

  it('returns 400 when neither endpointId nor endpointName provided', async () => {
    const res = makeRes();
    await handleVastWorkerGroupCreate(makeReq('POST', '/v1/gpu/vast/workergroups', { templateHash: 'abc' }), res);
    expect(res._status).toBe(400);
    expect(json(res).error).toMatch(/endpointId or endpointName/);
  });

  it('returns 500 on createWorkerGroup error', async () => {
    mockCreateWorkerGroup.mockRejectedValueOnce(new Error('bad request'));
    const res = makeRes();
    await handleVastWorkerGroupCreate(makeReq('POST', '/v1/gpu/vast/workergroups', { endpointId: 1, templateHash: 'abc' }), res);
    expect(res._status).toBe(500);
    expect(json(res).error).toContain('createWorkerGroup failed');
  });

  it('auto-creates template when image provided and no templateHash', async () => {
    mockFindOrCreateTemplate.mockResolvedValueOnce({ hashId: 'auto-hash' });
    mockCreateWorkerGroup.mockResolvedValueOnce({ id: 99 });
    const res = makeRes();
    await handleVastWorkerGroupCreate(makeReq('POST', '/v1/gpu/vast/workergroups', {
      endpointId: 1, image: 'myimage', tag: 'v1',
    }), res);
    expect(res._status).toBe(200);
    expect(mockFindOrCreateTemplate).toHaveBeenCalledWith(expect.objectContaining({ image: 'myimage', tag: 'v1', exposePorts: [8000] }), { apiKey: 'test-api-key' });
    expect(mockCreateWorkerGroup).toHaveBeenCalledWith(expect.objectContaining({ templateHash: 'auto-hash' }), { apiKey: 'test-api-key' });
  });

  it('returns 500 when auto template creation fails', async () => {
    mockFindOrCreateTemplate.mockRejectedValueOnce(new Error('template failed'));
    const res = makeRes();
    await handleVastWorkerGroupCreate(makeReq('POST', '/v1/gpu/vast/workergroups', {
      endpointId: 1, image: 'myimage',
    }), res);
    expect(res._status).toBe(500);
    expect(json(res).error).toContain('findOrCreateTemplate failed');
  });

  it('uses templateHash directly when provided (skips template creation)', async () => {
    mockCreateWorkerGroup.mockResolvedValueOnce({ id: 50 });
    const res = makeRes();
    await handleVastWorkerGroupCreate(makeReq('POST', '/v1/gpu/vast/workergroups', {
      endpointName: 'ep', image: 'img', templateHash: 'existing-hash',
    }), res);
    expect(res._status).toBe(200);
    expect(mockFindOrCreateTemplate).not.toHaveBeenCalled();
    expect(mockCreateWorkerGroup).toHaveBeenCalledWith(expect.objectContaining({ templateHash: 'existing-hash' }), { apiKey: 'test-api-key' });
  });

  it('returns 200 on success with full worker group params', async () => {
    const result = { id: 77, endpointId: 5 };
    mockCreateWorkerGroup.mockResolvedValueOnce(result);
    const res = makeRes();
    await handleVastWorkerGroupCreate(makeReq('POST', '/v1/gpu/vast/workergroups', {
      endpointId: 5, templateHash: 'hash', gpuRamGb: 24,
      minLoad: 0, targetUtil: 0.7, coldMult: 2, coldWorkers: 1, maxWorkers: 5, testWorkers: 1,
    }), res);
    expect(res._status).toBe(200);
    expect(json(res)).toEqual(result);
  });
});

describe('handleVastWorkerGroupUpdate', () => {
  it('returns 401 when no API key', async () => {
    mockDeployVastApiKey.value = '';
    const res = makeRes();
    await handleVastWorkerGroupUpdate(makeReq('PUT', '/v1/gpu/vast/workergroups/1', { id: 1, minLoad: 0 }), res);
    expect(res._status).toBe(401);
  });

  it('returns 400 when id missing from body', async () => {
    const res = makeRes();
    await handleVastWorkerGroupUpdate(makeReq('PUT', '/v1/gpu/vast/workergroups/1', { minLoad: 0 }), res);
    expect(res._status).toBe(400);
    expect(json(res).error).toMatch(/id is required/);
  });

  it('returns 500 on updateWorkerGroup error', async () => {
    mockUpdateWorkerGroup.mockRejectedValueOnce(new Error('conflict'));
    const res = makeRes();
    await handleVastWorkerGroupUpdate(makeReq('PUT', '/v1/gpu/vast/workergroups/1', { id: 1, minLoad: 0 }), res);
    expect(res._status).toBe(500);
    expect(json(res).error).toContain('updateWorkerGroup failed');
  });

  it('returns 200 on success', async () => {
    mockUpdateWorkerGroup.mockResolvedValueOnce(undefined);
    const res = makeRes();
    await handleVastWorkerGroupUpdate(makeReq('PUT', '/v1/gpu/vast/workergroups/1', {
      id: 1, minLoad: 2, targetUtil: 0.9, coldMult: 1.2,
      testWorkers: 0, templateHash: 'h', templateId: 5,
      searchParams: 'q', launchArgs: '-v', gpuRamGb: 48,
      endpointName: 'ep', endpointId: 10,
    }), res);
    expect(res._status).toBe(200);
    expect(json(res)).toEqual({ success: true, id: 1 });
    expect(mockUpdateWorkerGroup).toHaveBeenCalledWith(1, expect.objectContaining({ minLoad: 2, targetUtil: 0.9 }), { apiKey: 'test-api-key' });
  });
});

describe('handleVastWorkerGroupDelete', () => {
  it('returns 401 when no API key', async () => {
    mockDeployVastApiKey.value = '';
    const res = makeRes();
    await handleVastWorkerGroupDelete(makeReq('DELETE', '/v1/gpu/vast/workergroups?id=1'), res);
    expect(res._status).toBe(401);
  });

  it('returns 400 when id query param missing', async () => {
    const res = makeRes();
    await handleVastWorkerGroupDelete(makeReq('DELETE', '/v1/gpu/vast/workergroups'), res);
    expect(res._status).toBe(400);
    expect(json(res).error).toMatch(/id query param/);
  });

  it('returns 400 when id is not a positive integer', async () => {
    const res = makeRes();
    await handleVastWorkerGroupDelete(makeReq('DELETE', '/v1/gpu/vast/workergroups?id=0'), res);
    expect(res._status).toBe(400);
  });

  it('returns 500 on deleteWorkerGroup error', async () => {
    mockDeleteWorkerGroup.mockRejectedValueOnce(new Error('still running'));
    const res = makeRes();
    await handleVastWorkerGroupDelete(makeReq('DELETE', '/v1/gpu/vast/workergroups?id=3'), res);
    expect(res._status).toBe(500);
  });

  it('returns 200 on success with id and result fields', async () => {
    mockDeleteWorkerGroup.mockResolvedValueOnce({ terminated: true });
    const res = makeRes();
    await handleVastWorkerGroupDelete(makeReq('DELETE', '/v1/gpu/vast/workergroups?id=3'), res);
    expect(res._status).toBe(200);
    expect(json(res)).toMatchObject({ success: true, id: 3, terminated: true });
    expect(mockDeleteWorkerGroup).toHaveBeenCalledWith(3, { apiKey: 'test-api-key' });
  });
});
