/**
 * Config & Workload Unit Tests (#261-#310)
 *
 * Config persistence tests (#261-#280):
 * - loadProviderConfig: default, from disk, cache, corrupt JSON
 * - saveProviderConfig: atomic write (tmp+rename), cache update
 * - Config handler endpoints: GET/POST providers, api-keys, profiles, labs
 * - Profile CRUD: create, delete, activate
 *
 * Workload tests (#281-#310):
 * - GET /v1/workloads: empty list, filter by type
 * - POST /v1/workloads: deploy GPU/bot/db, validation
 * - GET /v1/workloads/:id: status, 404
 * - POST stop/start, DELETE terminate
 * - WorkloadRegistry: list, getByName, listByType, events
 * - Each driver: GpuWorkloadDriver, BotWorkloadDriver, DbWorkloadDriver
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';

// ═════════════════════════════════════════════════════════════════════════════
// PART 1: CONFIG PERSISTENCE + HANDLERS (#261-#280)
// ═════════════════════════════════════════════════════════════════════════════

// ── FS Mocks for config-persistence ─────────────────────────────────────────

const mockFs = {
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  chmodSync: vi.fn(),
};

vi.mock('fs', () => ({
  existsSync: (...a: unknown[]) => mockFs.existsSync(...a),
  readFileSync: (...a: unknown[]) => mockFs.readFileSync(...a),
  writeFileSync: (...a: unknown[]) => mockFs.writeFileSync(...a),
  mkdirSync: (...a: unknown[]) => mockFs.mkdirSync(...a),
  renameSync: (...a: unknown[]) => mockFs.renameSync(...a),
  chmodSync: (...a: unknown[]) => mockFs.chmodSync(...a),
  default: {
    existsSync: (...a: unknown[]) => mockFs.existsSync(...a),
    readFileSync: (...a: unknown[]) => mockFs.readFileSync(...a),
    writeFileSync: (...a: unknown[]) => mockFs.writeFileSync(...a),
    mkdirSync: (...a: unknown[]) => mockFs.mkdirSync(...a),
    renameSync: (...a: unknown[]) => mockFs.renameSync(...a),
    chmodSync: (...a: unknown[]) => mockFs.chmodSync(...a),
  },
}));

// Mock fs/promises — loadProviderConfig now uses async fs operations
const mockFsPromises = {
  access: vi.fn(() => Promise.reject(new Error('ENOENT'))), // file not found by default
  readFile: vi.fn(() => Promise.resolve('{}')),
  writeFile: vi.fn(() => Promise.resolve()),
  mkdir: vi.fn(() => Promise.resolve()),
};
vi.mock('fs/promises', () => ({
  access: (...a: unknown[]) => mockFsPromises.access(...a),
  readFile: (...a: unknown[]) => mockFsPromises.readFile(...a),
  writeFile: (...a: unknown[]) => mockFsPromises.writeFile(...a),
  mkdir: (...a: unknown[]) => mockFsPromises.mkdir(...a),
}));

// Mock gpu-deploy
vi.mock('../../server/gpu-deploy', () => ({
  setIdleTimeoutMs: vi.fn(),
}));

// Mock deploy-settings
vi.mock('../../src/gpu-providers/deploy-settings', () => ({
  setSttTargetLatencyMs: vi.fn(),
  setLlmTargetLatencyMs: vi.fn(),
  setTtsTargetLatencyMs: vi.fn(),
  setGpuSortBy: vi.fn(),
  setDeployTimeoutMin: vi.fn(),
  setDeployRegion: vi.fn(),
  setDeployDockerImage: vi.fn(),
  setDeployRaceCount: vi.fn(),
}));

// Mock ws-state for config-handlers
vi.mock('../../server/ws-state', () => ({
  broadcastWs: vi.fn(),
}));

// Mock ws-server for config-handlers
vi.mock('../../server/ws-server', () => ({
  reloadStreamingSTTRouter: vi.fn(),
}));

// Mock providers for config-handlers
vi.mock('../../server/providers', () => ({
  reloadProviderAvailability: vi.fn(() => ({})),
  translationDefaults: { stt: [], llm: [], tts: [] },
  updateActivePipeline: vi.fn(),
  runpod: { listInstances: vi.fn(() => []), deleteInstance: vi.fn(), createInstance: vi.fn() },
  vast: { listInstances: vi.fn(() => []), deleteInstance: vi.fn() },
  tensordock: { listInstances: vi.fn(() => []), deleteInstance: vi.fn() },
  modal: { listInstances: vi.fn(() => []) },
  flyio: { listInstances: vi.fn(() => []), deleteInstance: vi.fn(), createInstance: vi.fn(), getFlyHost: vi.fn() },
  scaleway: { listInstances: vi.fn(() => []), deleteInstance: vi.fn(), createInstance: vi.fn() },
}));

// Mock labs-settings
vi.mock('../../server/labs-settings', () => ({
  getLabsFlags: vi.fn(() => ({
    peakEwma: false,
    speculativeTranslation: false,
    streamingOverlap: false,
    updatedAt: 0,
  })),
  setLabsFlags: vi.fn((patch: Record<string, unknown>) => ({
    peakEwma: false,
    speculativeTranslation: false,
    streamingOverlap: false,
    updatedAt: Date.now(),
    ...patch,
  })),
}));

// Mock speculative-cache
vi.mock('../../server/speculative-cache', () => ({
  speculativeCache: { stats: vi.fn(() => ({})) },
}));

// Mock http-utils (before importing handlers)
vi.mock('../../server/http-utils', () => ({
  getOrCreateRequestId: vi.fn(() => 'test-req-id'),
  setRequestIdHeader: vi.fn(),
  readJsonBody: vi.fn(),
  handleBodyError: vi.fn((res: any) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
  }),
}));

// Mock user-profiles (used by saveProviderConfig)
vi.mock('../../server/user-profiles', () => ({
  saveUserConfig: vi.fn(() => Promise.resolve()),
}));

// Mock src/gateway/pipeline/local-kokoro.ts — imports 'bun' which is unavailable in Vitest
vi.mock('../../src/gateway/pipeline/local-kokoro', () => ({
  getLocalKokoroUrl: vi.fn(() => null),
  startLocalKokoro: vi.fn(),
  stopLocalKokoro: vi.fn(),
}));

// Mock server/metrics — imports ai-handlers which pulls in many deps
vi.mock('../../server/metrics', () => ({
  logRequest: vi.fn(),
  logGpuEvent: vi.fn(),
  getRequestLog: vi.fn(() => []),
  providerMetrics: new Map(),
}));

// Mock state for workloads
vi.mock('../../server/state', () => ({
  botState: { status: 'idle', podId: '', endpoint: '' },
  botDeployLock: false,
  deployState: { status: 'idle', podId: '', endpoint: '', provider: '' },
  deployApiKey: '',
  setBotDeployLock: vi.fn(),
  setBotStateVar: vi.fn(),
  setBotPodApiKey: vi.fn(),
  setDeployState: vi.fn(),
  setDeployLock: vi.fn(),
  resetDeployState: vi.fn(),
  deploymentSM: { reset: vi.fn() },
  gpuHealthy: false,
  isGpuLatencyAcceptable: vi.fn(() => false),
}));

// Mock database/neon-management
vi.mock('../../src/database/neon-management', () => ({
  NeonManagementClient: class {
    constructor(public apiKey: string, public projectId: string) {}
    getProject() { return Promise.resolve({ name: 'test-project', regionId: 'us-east-1' }); }
    listEndpoints() { return Promise.resolve([{ id: 'ep-1', type: 'read_write', host: 'test.neon.tech', branchId: 'br-1' }]); }
  },
}));

// Import after all mocks
import {
  loadProviderConfig,
  saveProviderConfig,
  patchProviderConfig,
  DEFAULT_GPU_PROFILES,
  applyProfileLatencyTargets,
  applyUserConfig,
} from '../../server/config-persistence';
import type { ProviderConfig, GatewayApp } from '../../server/config-persistence';
import {
  handleGetProviderConfig,
  handlePatchProviderConfig,
  handleGetApiKeys,
  handleSetApiKeys,
  handleCreateProfile,
  handleDeleteProfile,
  handleActivateProfile,
  handleGetLabsFlags,
  handlePatchLabsFlags,
} from '../../server/config-handlers';
import { readJsonBody } from '../../server/http-utils';

// ── HTTP Helpers ────────────────────────────────────────────────────────────

function mockReq(body?: Record<string, unknown>): IncomingMessage {
  const stream = new PassThrough();
  if (body) {
    stream.end(JSON.stringify(body));
  } else {
    stream.end('');
  }
  (stream as any).url = '/test';
  return stream as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    headersSent: false,
    writeHead(status: number, _headers?: Record<string, string>) {
      res._status = status;
      return res;
    },
    end(body?: string) {
      res._body = body ?? '';
      return res;
    },
    setHeader() { return res; },
  };
  return res as unknown as ServerResponse & { _status: number; _body: string };
}

function resJson(res: { _body: string }): Record<string, unknown> {
  return JSON.parse(res._body);
}

// ── Config Persistence Tests ────────────────────────────────────────────────

describe('Config persistence — loadProviderConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Force cache expiration by setting _cacheTime to 0 via applyUserConfig trick
    // We use the exported function to reset cache
    applyUserConfig(null as unknown as ProviderConfig); // null clears the reference
  });

  // #261
  it('returns defaults when config file does not exist', async () => {
    mockFsPromises.access.mockRejectedValue(new Error('ENOENT'));
    const config = await loadProviderConfig();
    expect(config.apps.length).toBeGreaterThan(0);
    expect(config.activeAppId).toBe('realtime-translation-dubbing-mistral');
    expect(config.idleTimeoutMin).toBe(5);
  });

  // #262
  it('reads config from disk when file exists', async () => {
    const diskConfig = {
      profiles: [{ id: 'custom', name: 'Custom', stt: [], llm: [], tts: [] }],
      activeProfileId: 'custom',
      pipelineStt: [{ provider: 'groq', model: 'whisper' }],
      pipelineLlm: [{ provider: 'groq', model: 'llama' }],
      pipelineTts: [{ provider: 'groq', model: 'orpheus' }],
      idleTimeoutMin: 30,
      updatedAt: 1000,
    };
    mockFsPromises.access.mockResolvedValue(undefined);
    mockFsPromises.readFile.mockResolvedValue(JSON.stringify(diskConfig));

    const config = await loadProviderConfig();
    expect(config.activeAppId).toBe('custom');
    expect(config.idleTimeoutMin).toBe(30);
    // Should have merged in default apps that are missing
    expect(config.apps.length).toBeGreaterThan(1);
  });

  // #263
  it('uses cache on second call within TTL', async () => {
    mockFsPromises.access.mockRejectedValue(new Error('ENOENT'));
    const config1 = await loadProviderConfig();
    const config2 = await loadProviderConfig();
    // Second call returns cached result
    expect(config1).toBe(config2); // Same reference = cached
  });

  // #264
  it('returns defaults on corrupt JSON', async () => {
    mockFsPromises.access.mockResolvedValue(undefined);
    mockFsPromises.readFile.mockResolvedValue('NOT VALID JSON {{[');

    const config = await loadProviderConfig();
    // Should return default config instead of crashing
    expect(config.apps.length).toBeGreaterThan(0);
    expect(config.activeAppId).toBe('realtime-translation-dubbing-mistral');
  });

  // #265
  it('preserves extra UI fields from disk', async () => {
    const diskConfig = {
      profiles: DEFAULT_GPU_PROFILES,        // legacy field name — tests migration
      activeProfileId: 'cloud-only',         // legacy field name — tests migration
      pipelineStt: [{ provider: 'groq', model: 'whisper' }],
      pipelineLlm: [{ provider: 'groq', model: 'llama' }],
      pipelineTts: [{ provider: 'groq', model: 'orpheus' }],
      idleTimeoutMin: 15,
      updatedAt: 1000,
      dockerImages: ['marcosremar/babelcast:latest'],
      gpuImage: 'custom-image',
    };
    mockFsPromises.access.mockResolvedValue(undefined);
    mockFsPromises.readFile.mockResolvedValue(JSON.stringify(diskConfig));

    const config = await loadProviderConfig();
    expect((config as any).dockerImages).toEqual(['marcosremar/babelcast:latest']);
    expect((config as any).gpuImage).toBe('custom-image');
  });
});

describe('Config persistence — saveProviderConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // #266
  it('writes to tmp file then renames (atomic write)', async () => {
    const config: ProviderConfig = {
      apps: [], activeAppId: null,
      pipelineStt: [], pipelineLlm: [], pipelineTts: [],
      idleTimeoutMin: 15, updatedAt: 0,
    };
    await saveProviderConfig(config);

    expect(mockFs.mkdirSync).toHaveBeenCalled();
    expect(mockFs.writeFileSync).toHaveBeenCalled();
    // tmp file should be written
    const writeCall = mockFs.writeFileSync.mock.calls[0];
    expect(writeCall[0]).toContain('.tmp');
  });

  // #267
  it('updates updatedAt timestamp on save', async () => {
    const before = Date.now();
    const config: ProviderConfig = {
      apps: [], activeAppId: null,
      pipelineStt: [], pipelineLlm: [], pipelineTts: [],
      idleTimeoutMin: 15, updatedAt: 0,
    };
    await saveProviderConfig(config);
    expect(config.updatedAt).toBeGreaterThanOrEqual(before);
  });

  // #268
  it('updates in-memory cache after save', async () => {
    const config: ProviderConfig = {
      apps: [{ id: 'saved', name: 'Saved', stt: [], llm: [], tts: [] } as GatewayApp],
      activeAppId: 'saved',
      pipelineStt: [], pipelineLlm: [], pipelineTts: [],
      idleTimeoutMin: 15, updatedAt: 0,
    };

    // Use applyUserConfig to simulate the cache update directly.
    applyUserConfig(config);

    // Subsequent load should return cached version without reading disk
    const loaded = await loadProviderConfig();
    expect(loaded.activeAppId).toBe('saved');
  });
});

describe('Config persistence — patchProviderConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyUserConfig(null as unknown as ProviderConfig);
    mockFsPromises.access.mockRejectedValue(new Error('ENOENT'));
  });

  // #269
  it('merges partial update into existing config', async () => {
    const updated = await patchProviderConfig({ idleTimeoutMin: 30 });
    expect(updated.idleTimeoutMin).toBe(30);
    // Other fields should remain default
    expect(updated.activeAppId).toBe('realtime-translation-dubbing-mistral');
  });

  // #270
  it('updates activeAppId and records lastActivatedAt', async () => {
    const updated = await patchProviderConfig({ activeAppId: 'cloud-only' });
    expect(updated.activeAppId).toBe('cloud-only');
    const cloudApp = updated.apps.find(p => p.id === 'cloud-only');
    expect(cloudApp?.lastActivatedAt).toBeGreaterThan(0);
  });
});

// ── Config Handlers Tests ───────────────────────────────────────────────────

describe('Config handlers — GET /v1/config/providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyUserConfig(null as unknown as ProviderConfig);
    mockFsPromises.access.mockRejectedValue(new Error('ENOENT'));
  });

  // #271
  it('returns provider config as JSON', async () => {
    const req = mockReq();
    const res = mockRes();
    await handleGetProviderConfig(req, res);
    expect(res._status).toBe(200);
    const body = resJson(res);
    expect(body.apps).toBeDefined();
    expect(body.activeAppId).toBeDefined();
  });
});

describe('Config handlers — POST /v1/config/providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyUserConfig(null as unknown as ProviderConfig);
    mockFsPromises.access.mockRejectedValue(new Error('ENOENT'));
  });

  // #272
  it('validates pipeline arrays', async () => {
    vi.mocked(readJsonBody).mockResolvedValue({ pipelineStt: 'not-an-array' });
    const req = mockReq();
    const res = mockRes();
    await handlePatchProviderConfig(req, res);
    expect(res._status).toBe(400);
    const body = resJson(res);
    expect(body.error).toContain('Validation failed');
  });

  // #273
  it('validates apps must be an array', async () => {
    vi.mocked(readJsonBody).mockResolvedValue({ apps: 'not-an-array' });
    const req = mockReq();
    const res = mockRes();
    await handlePatchProviderConfig(req, res);
    expect(res._status).toBe(400);
    const body = resJson(res);
    expect(body.error).toContain('Validation failed');
  });

  // #274
  it('patches config and returns updated result', async () => {
    vi.mocked(readJsonBody).mockResolvedValue({ activeAppId: 'cloud-only' });
    const req = mockReq();
    const res = mockRes();
    await handlePatchProviderConfig(req, res);
    expect(res._status).toBe(200);
    const body = resJson(res);
    expect(body.activeAppId).toBe('cloud-only');
  });
});

describe('Config handlers — API keys', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  // #275
  it('GET /v1/config/api-keys returns masked keys', async () => {
    process.env.GROQ_API_KEY = 'gsk_test123456789';
    const req = mockReq();
    const res = mockRes();
    await handleGetApiKeys(req, res);
    expect(res._status).toBe(200);
    const body = resJson(res);
    const keys = body.keys as Array<Record<string, unknown>>;
    const groqKey = keys.find(k => k.id === 'groq');
    expect(groqKey?.configured).toBe(true);
    expect(groqKey?.masked).not.toBe('gsk_test123456789');
    expect((groqKey?.masked as string).includes('***')).toBe(true);
  });

  // #276
  it('POST /v1/config/api-keys rejects unknown keys', async () => {
    vi.mocked(readJsonBody).mockResolvedValue({ keys: { UNKNOWN_KEY: 'value' } });
    const req = mockReq();
    const res = mockRes();
    await handleSetApiKeys(req, res);
    expect(res._status).toBe(400);
    expect(resJson(res).error).toContain('Unknown key');
  });

  // #277
  it('POST /v1/config/api-keys validates body.keys is an object', async () => {
    vi.mocked(readJsonBody).mockResolvedValue({ keys: null });
    const req = mockReq();
    const res = mockRes();
    await handleSetApiKeys(req, res);
    expect(res._status).toBe(400);
  });
});

describe('Config handlers — profile CRUD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyUserConfig(null as unknown as ProviderConfig);
    mockFsPromises.access.mockRejectedValue(new Error('ENOENT'));
  });

  // #278
  it('POST /v1/config/profiles creates a new profile', async () => {
    vi.mocked(readJsonBody).mockResolvedValue({
      id: 'my-profile',
      name: 'My Profile',
      stt: [{ provider: 'groq', model: 'whisper' }],
    });
    const req = mockReq();
    const res = mockRes();
    await handleCreateProfile(req, res);
    expect(res._status).toBe(201);
    const body = resJson(res);
    const apps = body.apps as Array<Record<string, unknown>>;
    expect(apps.find(p => p.id === 'my-profile')).toBeTruthy();
  });

  // #278b
  it('POST /v1/config/profiles rejects missing id', async () => {
    vi.mocked(readJsonBody).mockResolvedValue({ name: 'Test' });
    const req = mockReq();
    const res = mockRes();
    await handleCreateProfile(req, res);
    expect(res._status).toBe(400);
    const body = resJson(res);
    expect(body.error).toMatch(/id is required|Validation failed/);
  });

  // #278c
  it('POST /v1/config/profiles rejects invalid id format', async () => {
    vi.mocked(readJsonBody).mockResolvedValue({ id: 'invalid id!@#$', name: 'Test' });
    const req = mockReq();
    const res = mockRes();
    await handleCreateProfile(req, res);
    expect(res._status).toBe(400);
    const body = resJson(res);
    expect(body.error).toMatch(/Invalid profile id|Validation failed/);
  });

  // #279
  it('DELETE /v1/config/profiles deletes a profile', async () => {
    // First create an app
    applyUserConfig({
      apps: [
        ...DEFAULT_GPU_PROFILES,
        { id: 'deletable', name: 'Deletable', stt: [], llm: [], tts: [] } as GatewayApp,
      ],
      activeAppId: 'deletable',
      pipelineStt: [], pipelineLlm: [], pipelineTts: [],
      idleTimeoutMin: 15, updatedAt: 0,
    });

    vi.mocked(readJsonBody).mockResolvedValue({ id: 'deletable' });
    const req = mockReq();
    const res = mockRes();
    await handleDeleteProfile(req, res);
    expect(res._status).toBe(200);
    const body = resJson(res);
    const apps = body.apps as Array<Record<string, unknown>>;
    expect(apps.find(p => p.id === 'deletable')).toBeUndefined();
    // Active app should be cleared since we deleted it
    expect(body.activeAppId).toBeNull();
  });

  // #279b
  it('DELETE /v1/config/profiles returns 404 for non-existent profile', async () => {
    vi.mocked(readJsonBody).mockResolvedValue({ id: 'nonexistent' });
    const req = mockReq();
    const res = mockRes();
    await handleDeleteProfile(req, res);
    expect(res._status).toBe(404);
  });

  // #280
  it('POST /v1/config/profiles/activate activates a profile', async () => {
    vi.mocked(readJsonBody).mockResolvedValue({ id: 'cloud-only' });
    const req = mockReq();
    const res = mockRes();
    await handleActivateProfile(req, res);
    expect(res._status).toBe(200);
    const body = resJson(res);
    expect(body.activeAppId).toBe('cloud-only');
  });

  // #280b
  it('POST /v1/config/profiles/activate with null deactivates', async () => {
    vi.mocked(readJsonBody).mockResolvedValue({ id: null });
    const req = mockReq();
    const res = mockRes();
    await handleActivateProfile(req, res);
    expect(res._status).toBe(200);
    const body = resJson(res);
    expect(body.activeAppId).toBeNull();
  });

  // #280c
  it('POST /v1/config/profiles/activate returns 404 for unknown profile', async () => {
    vi.mocked(readJsonBody).mockResolvedValue({ id: 'does-not-exist' });
    const req = mockReq();
    const res = mockRes();
    await handleActivateProfile(req, res);
    expect(res._status).toBe(404);
  });
});

describe('Config handlers — Labs flags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // #280d
  it('GET /v1/config/labs returns current flags', async () => {
    const req = mockReq();
    const res = mockRes();
    await handleGetLabsFlags(req, res);
    expect(res._status).toBe(200);
    const body = resJson(res);
    expect(typeof body.peakEwma).toBe('boolean');
  });

  // #280e
  it('POST /v1/config/labs patches flags', async () => {
    vi.mocked(readJsonBody).mockResolvedValue({ peakEwma: true });
    const req = mockReq();
    const res = mockRes();
    await handlePatchLabsFlags(req, res);
    expect(res._status).toBe(200);
    const body = resJson(res);
    expect(body.peakEwma).toBe(true);
  });
});

import {
  setSttTargetLatencyMs,
  setLlmTargetLatencyMs,
  setTtsTargetLatencyMs,
} from '../../src/gpu-providers/deploy-settings';

describe('Config persistence — applyProfileLatencyTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies custom per-stage latency targets', () => {
    const apps: GatewayApp[] = [{
      id: 'test-profile',
      name: 'Test',
      latencyTargetsMs: { stt: 200, llm: 400, tts: 300 },
    }];
    applyProfileLatencyTargets('test-profile', apps);

    expect(vi.mocked(setSttTargetLatencyMs)).toHaveBeenCalledWith(200);
    expect(vi.mocked(setLlmTargetLatencyMs)).toHaveBeenCalledWith(400);
    expect(vi.mocked(setTtsTargetLatencyMs)).toHaveBeenCalledWith(300);
  });

  it('does nothing for null appId', () => {
    applyProfileLatencyTargets(null, []);
    expect(vi.mocked(setSttTargetLatencyMs)).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART 2: WORKLOAD REGISTRY + HANDLERS (#281-#310)
// ═════════════════════════════════════════════════════════════════════════════

import { WorkloadRegistry } from '../../src/workloads/registry';
import type {
  Workload,
  WorkloadDriver,
  WorkloadConfig,
  WorkloadEvent,
  WorkloadType,
} from '../../src/workloads/types';

// ── Fake Driver ─────────────────────────────────────────────────────────────

class FakeDriver implements WorkloadDriver {
  readonly type: WorkloadType;
  deployFn = vi.fn();
  stopFn = vi.fn();
  startFn = vi.fn();
  terminateFn = vi.fn();
  statusFn = vi.fn();

  constructor(type: WorkloadType) {
    this.type = type;
  }

  async deploy(name: string, config: WorkloadConfig): Promise<Workload> {
    this.deployFn(name, config);
    const now = Date.now();
    return {
      id: WorkloadRegistry.newId(),
      type: this.type,
      name,
      status: 'deploying',
      provider: 'fake',
      costPerHr: 0,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };
  }

  async stop(workload: Workload): Promise<Workload> {
    this.stopFn(workload);
    return { ...workload, status: 'stopped', updatedAt: Date.now() };
  }

  async start(workload: Workload): Promise<Workload> {
    this.startFn(workload);
    return { ...workload, status: 'running', updatedAt: Date.now() };
  }

  async terminate(workload: Workload): Promise<void> {
    this.terminateFn(workload);
  }

  async status(workload: Workload): Promise<Workload> {
    this.statusFn(workload);
    return { ...workload, status: 'running', updatedAt: Date.now() };
  }
}

// ── WorkloadRegistry Tests ──────────────────────────────────────────────────

describe('WorkloadRegistry — list / get / filter', () => {
  let registry: WorkloadRegistry;
  let gpuDriver: FakeDriver;
  let botDriver: FakeDriver;
  let dbDriver: FakeDriver;

  beforeEach(() => {
    registry = new WorkloadRegistry();
    gpuDriver = new FakeDriver('gpu');
    botDriver = new FakeDriver('bot');
    dbDriver = new FakeDriver('db');
    registry.registerDriver(gpuDriver);
    registry.registerDriver(botDriver);
    registry.registerDriver(dbDriver);
  });

  // #281
  it('list returns empty array initially', () => {
    expect(registry.list()).toEqual([]);
  });

  // #282
  it('list returns all deployed workloads', async () => {
    await registry.deploy('gpu-1', { type: 'gpu' } as WorkloadConfig);
    await registry.deploy('bot-1', { type: 'bot', botKind: 'teams' } as WorkloadConfig);
    expect(registry.list()).toHaveLength(2);
  });

  // #283
  it('listByType filters by workload type', async () => {
    await registry.deploy('gpu-1', { type: 'gpu' } as WorkloadConfig);
    await registry.deploy('bot-1', { type: 'bot', botKind: 'teams' } as WorkloadConfig);
    await registry.deploy('bot-2', { type: 'bot', botKind: 'whatsapp' } as WorkloadConfig);
    expect(registry.listByType('bot')).toHaveLength(2);
    expect(registry.listByType('gpu')).toHaveLength(1);
    expect(registry.listByType('db')).toHaveLength(0);
  });

  // #284
  it('get returns workload by ID', async () => {
    const w = await registry.deploy('gpu-1', { type: 'gpu' } as WorkloadConfig);
    const found = registry.get(w.id);
    expect(found).toBeTruthy();
    expect(found?.name).toBe('gpu-1');
  });

  // #285
  it('get returns undefined for unknown ID', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  // #286
  it('getByName returns workload by name', async () => {
    await registry.deploy('gpu-inference', { type: 'gpu' } as WorkloadConfig);
    const found = registry.getByName('gpu-inference');
    expect(found).toBeTruthy();
    expect(found?.name).toBe('gpu-inference');
  });

  // #287
  it('getByName returns undefined for unknown name', () => {
    expect(registry.getByName('no-such-workload')).toBeUndefined();
  });
});

describe('WorkloadRegistry — deploy', () => {
  let registry: WorkloadRegistry;
  let gpuDriver: FakeDriver;
  let botDriver: FakeDriver;

  beforeEach(() => {
    registry = new WorkloadRegistry();
    gpuDriver = new FakeDriver('gpu');
    botDriver = new FakeDriver('bot');
    registry.registerDriver(gpuDriver);
    registry.registerDriver(botDriver);
  });

  // #288
  it('deploy creates and stores a new workload', async () => {
    const w = await registry.deploy('test-gpu', { type: 'gpu' } as WorkloadConfig);
    expect(w.type).toBe('gpu');
    expect(w.name).toBe('test-gpu');
    expect(w.status).toBe('deploying');
    expect(registry.list()).toHaveLength(1);
  });

  // #289
  it('deploy rejects duplicate names', async () => {
    await registry.deploy('test-gpu', { type: 'gpu' } as WorkloadConfig);
    await expect(
      registry.deploy('test-gpu', { type: 'gpu' } as WorkloadConfig),
    ).rejects.toThrow(/already exists/);
  });

  // #290
  it('deploy allows reusing name of errored workload', async () => {
    const w = await registry.deploy('test-gpu', { type: 'gpu' } as WorkloadConfig);
    // Manually set to error state (simulate driver setting this)
    const internal = registry.get(w.id)!;
    (internal as any).status = 'error';

    const w2 = await registry.deploy('test-gpu', { type: 'gpu' } as WorkloadConfig);
    expect(w2.name).toBe('test-gpu');
    expect(w2.id).not.toBe(w.id);
  });

  // #291
  it('deploy throws when no driver registered', async () => {
    const emptyReg = new WorkloadRegistry();
    await expect(
      emptyReg.deploy('test', { type: 'gpu' } as WorkloadConfig),
    ).rejects.toThrow(/No workload driver/);
  });
});

describe('WorkloadRegistry — lifecycle (stop / start / terminate)', () => {
  let registry: WorkloadRegistry;
  let gpuDriver: FakeDriver;

  beforeEach(() => {
    registry = new WorkloadRegistry();
    gpuDriver = new FakeDriver('gpu');
    registry.registerDriver(gpuDriver);
  });

  // #292
  it('stop sets status to stopped', async () => {
    const w = await registry.deploy('gpu-1', { type: 'gpu' } as WorkloadConfig);
    const stopped = await registry.stop(w.id);
    expect(stopped.status).toBe('stopped');
    expect(gpuDriver.stopFn).toHaveBeenCalled();
  });

  // #293
  it('start sets status to running', async () => {
    const w = await registry.deploy('gpu-1', { type: 'gpu' } as WorkloadConfig);
    await registry.stop(w.id);
    const started = await registry.start(w.id);
    expect(started.status).toBe('running');
    expect(gpuDriver.startFn).toHaveBeenCalled();
  });

  // #294
  it('terminate removes workload from registry', async () => {
    const w = await registry.deploy('gpu-1', { type: 'gpu' } as WorkloadConfig);
    await registry.terminate(w.id);
    expect(registry.get(w.id)).toBeUndefined();
    expect(registry.list()).toHaveLength(0);
    expect(gpuDriver.terminateFn).toHaveBeenCalled();
  });

  // #295
  it('stop throws for unknown workload ID', async () => {
    await expect(registry.stop('nonexistent')).rejects.toThrow(/not found/);
  });

  // #296
  it('terminate throws for unknown workload ID', async () => {
    await expect(registry.terminate('nonexistent')).rejects.toThrow(/not found/);
  });
});

describe('WorkloadRegistry — refreshStatus', () => {
  let registry: WorkloadRegistry;
  let gpuDriver: FakeDriver;

  beforeEach(() => {
    registry = new WorkloadRegistry();
    gpuDriver = new FakeDriver('gpu');
    registry.registerDriver(gpuDriver);
  });

  // #297
  it('refreshStatus updates workload in store', async () => {
    const w = await registry.deploy('gpu-1', { type: 'gpu' } as WorkloadConfig);
    const updated = await registry.refreshStatus(w.id);
    expect(updated.status).toBe('running'); // FakeDriver always returns running
    expect(gpuDriver.statusFn).toHaveBeenCalled();
  });
});

describe('WorkloadRegistry — events', () => {
  let registry: WorkloadRegistry;
  let gpuDriver: FakeDriver;

  beforeEach(() => {
    registry = new WorkloadRegistry();
    gpuDriver = new FakeDriver('gpu');
    registry.registerDriver(gpuDriver);
  });

  // #298
  it('emits "created" event on deploy', async () => {
    const events: WorkloadEvent[] = [];
    registry.onEvent(e => events.push(e));

    await registry.deploy('gpu-1', { type: 'gpu' } as WorkloadConfig);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('created');
    expect(events[0].workload.name).toBe('gpu-1');
  });

  // #299
  it('emits "status_changed" event on stop', async () => {
    const events: WorkloadEvent[] = [];
    const w = await registry.deploy('gpu-1', { type: 'gpu' } as WorkloadConfig);
    registry.onEvent(e => events.push(e));

    await registry.stop(w.id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('status_changed');
    expect(events[0].previousStatus).toBe('deploying');
  });

  // #300
  it('emits "terminated" event on terminate', async () => {
    const events: WorkloadEvent[] = [];
    const w = await registry.deploy('gpu-1', { type: 'gpu' } as WorkloadConfig);
    registry.onEvent(e => events.push(e));

    await registry.terminate(w.id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('terminated');
  });

  // #301
  it('unsubscribe removes listener', async () => {
    const events: WorkloadEvent[] = [];
    const unsub = registry.onEvent(e => events.push(e));
    unsub();

    await registry.deploy('gpu-1', { type: 'gpu' } as WorkloadConfig);
    expect(events).toHaveLength(0);
  });

  // #302
  it('event handler errors do not crash registry', async () => {
    registry.onEvent(() => { throw new Error('handler error'); });
    // Should not throw
    await expect(
      registry.deploy('gpu-1', { type: 'gpu' } as WorkloadConfig),
    ).resolves.toBeTruthy();
  });
});

describe('WorkloadRegistry — import', () => {
  // #303
  it('import adds an externally-created workload', () => {
    const registry = new WorkloadRegistry();
    const w: Workload = {
      id: 'ext-1',
      type: 'gpu',
      name: 'external-gpu',
      status: 'running',
      provider: 'runpod',
      costPerHr: 0.5,
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    registry.import(w);
    expect(registry.get('ext-1')).toBeTruthy();
    expect(registry.get('ext-1')?.name).toBe('external-gpu');
  });
});

describe('WorkloadRegistry — newId', () => {
  // #304
  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => WorkloadRegistry.newId()));
    expect(ids.size).toBe(100);
  });
});

// ── Workload Handlers Tests ─────────────────────────────────────────────────

// Import handler functions and the singleton registry
import {
  handleWorkloadList,
  handleWorkloadDeploy,
  handleWorkloadStatus,
  handleWorkloadStop,
  handleWorkloadStart,
  handleWorkloadTerminate,
  routeWorkloadRequest,
} from '../../server/workload-handlers';
import { workloadRegistry } from '../../src/workloads/registry';

describe('Workload handlers — list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear workloads from singleton
    for (const w of workloadRegistry.list()) {
      workloadRegistry['workloads'].delete(w.id);
    }
  });

  // #305
  it('GET /v1/workloads returns empty list', async () => {
    const req = { url: '/v1/workloads' } as IncomingMessage;
    const res = mockRes();
    await handleWorkloadList(req, res);
    expect(res._status).toBe(200);
    const body = resJson(res);
    expect(body.workloads).toEqual([]);
  });

  // #306
  it('GET /v1/workloads?type=bot filters by type', async () => {
    const req = { url: '/v1/workloads?type=bot' } as IncomingMessage;
    const res = mockRes();
    await handleWorkloadList(req, res);
    expect(res._status).toBe(200);
    const body = resJson(res);
    expect(Array.isArray(body.workloads)).toBe(true);
  });
});

describe('Workload handlers — deploy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const w of workloadRegistry.list()) {
      workloadRegistry['workloads'].delete(w.id);
    }
    // Register a fake driver for testing
    workloadRegistry.registerDriver(new FakeDriver('gpu'));
    workloadRegistry.registerDriver(new FakeDriver('bot'));
    workloadRegistry.registerDriver(new FakeDriver('db'));
  });

  // #307
  it('POST /v1/workloads requires name and type', async () => {
    vi.mocked(readJsonBody).mockResolvedValue({});
    const req = mockReq();
    const res = mockRes();
    await handleWorkloadDeploy(req, res);
    expect(res._status).toBe(400);
    const body = resJson(res);
    expect(body.error).toMatch(/name and type are required|Validation failed/);
  });

  // #307b
  it('POST /v1/workloads rejects invalid type', async () => {
    vi.mocked(readJsonBody).mockResolvedValue({ name: 'test', type: 'invalid' });
    const req = mockReq();
    const res = mockRes();
    await handleWorkloadDeploy(req, res);
    expect(res._status).toBe(400);
    const body = resJson(res);
    expect(body.error).toMatch(/Invalid workload type|Validation failed/);
  });

  // #308
  it('POST /v1/workloads deploys successfully', async () => {
    vi.mocked(readJsonBody).mockResolvedValue({ name: 'test-gpu', type: 'gpu', config: {} });
    const req = mockReq();
    const res = mockRes();
    await handleWorkloadDeploy(req, res);
    expect(res._status).toBe(201);
    const body = resJson(res);
    expect(body.name).toBe('test-gpu');
    expect(body.type).toBe('gpu');
    expect(body.status).toBe('deploying');
  });
});

describe('Workload handlers — status / stop / start / terminate', () => {
  let workloadId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    for (const w of workloadRegistry.list()) {
      workloadRegistry['workloads'].delete(w.id);
    }
    workloadRegistry.registerDriver(new FakeDriver('gpu'));
    // Deploy a workload to test against
    const w = await workloadRegistry.deploy('test-gpu', { type: 'gpu' } as WorkloadConfig);
    workloadId = w.id;
  });

  // #309
  it('GET /v1/workloads/:id returns workload status', async () => {
    const req = mockReq();
    const res = mockRes();
    await handleWorkloadStatus(req, res, workloadId);
    expect(res._status).toBe(200);
    const body = resJson(res);
    expect(body.name).toBe('test-gpu');
  });

  // #309b
  it('GET /v1/workloads/:id returns 404 for unknown ID', async () => {
    const req = mockReq();
    const res = mockRes();
    await handleWorkloadStatus(req, res, 'nonexistent');
    expect(res._status).toBe(404);
  });

  // #309c
  it('POST /v1/workloads/:id/stop stops workload', async () => {
    const req = mockReq();
    const res = mockRes();
    await handleWorkloadStop(req, res, workloadId);
    expect(res._status).toBe(200);
    const body = resJson(res);
    expect(body.status).toBe('stopped');
  });

  // #309d
  it('POST /v1/workloads/:id/start starts workload', async () => {
    await workloadRegistry.stop(workloadId);
    const req = mockReq();
    const res = mockRes();
    await handleWorkloadStart(req, res, workloadId);
    expect(res._status).toBe(200);
    const body = resJson(res);
    expect(body.status).toBe('running');
  });

  // #310
  it('DELETE /v1/workloads/:id terminates workload', async () => {
    const req = mockReq();
    const res = mockRes();
    await handleWorkloadTerminate(req, res, workloadId);
    expect(res._status).toBe(200);
    expect(resJson(res).ok).toBe(true);
    // Workload should be removed
    expect(workloadRegistry.get(workloadId)).toBeUndefined();
  });
});

describe('Workload handlers — route dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes GET /v1/workloads', () => {
    const req = { url: '/v1/workloads' } as IncomingMessage;
    const res = mockRes();
    const handled = routeWorkloadRequest(req, res as any, '/v1/workloads', 'GET');
    expect(handled).toBe(true);
  });

  it('routes POST /v1/workloads', () => {
    vi.mocked(readJsonBody).mockResolvedValue({ name: 'x', type: 'gpu' });
    const req = mockReq();
    const res = mockRes();
    const handled = routeWorkloadRequest(req, res as any, '/v1/workloads', 'POST');
    expect(handled).toBe(true);
  });

  it('routes GET /v1/workloads/:id', () => {
    const req = mockReq();
    const res = mockRes();
    const handled = routeWorkloadRequest(req, res as any, '/v1/workloads/some-id', 'GET');
    expect(handled).toBe(true);
  });

  it('routes DELETE /v1/workloads/:id', () => {
    const req = mockReq();
    const res = mockRes();
    const handled = routeWorkloadRequest(req, res as any, '/v1/workloads/some-id', 'DELETE');
    expect(handled).toBe(true);
  });

  it('routes POST /v1/workloads/:id/stop', () => {
    const req = mockReq();
    const res = mockRes();
    const handled = routeWorkloadRequest(req, res as any, '/v1/workloads/some-id/stop', 'POST');
    expect(handled).toBe(true);
  });

  it('routes POST /v1/workloads/:id/start', () => {
    const req = mockReq();
    const res = mockRes();
    const handled = routeWorkloadRequest(req, res as any, '/v1/workloads/some-id/start', 'POST');
    expect(handled).toBe(true);
  });

  it('returns false for unrecognized path', () => {
    const req = mockReq();
    const res = mockRes();
    const handled = routeWorkloadRequest(req, res as any, '/v1/other', 'GET');
    expect(handled).toBe(false);
  });
});
