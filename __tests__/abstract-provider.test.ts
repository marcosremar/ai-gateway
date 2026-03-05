import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AbstractGpuProvider, TIMEOUTS, FetchError } from '@ai-gateway/gpu-providers/abstract-provider';
import type { AbstractGpuProviderOptions } from '@ai-gateway/gpu-providers/abstract-provider';
import type { GpuInstance, InstanceSpec, ProviderCredentials } from '@ai-gateway/gpu-providers/types';

// ── Minimal concrete test provider ──────────────────────────────────────────

class TestProvider extends AbstractGpuProvider {
  readonly providerId = 'test';
  readonly bootTimeSecs = 60;

  constructor(opts?: AbstractGpuProviderOptions) {
    super(opts);
  }

  // Expose protected methods for testing
  public testErrMsg(err: unknown) { return this.errMsg(err); }
  public testJsonHeaders(apiKey: string) { return this.jsonHeaders(apiKey); }
  public testFetchJson<T>(url: string, init?: RequestInit, timeout?: number, label?: string) {
    return this.fetchJson<T>(url, init, timeout, label);
  }
  public testFetchRaw(url: string, init?: RequestInit, timeout?: number) {
    return this.fetchRaw(url, init, timeout);
  }
  public testPersistInstance(userId: string | undefined, machineKey: string, data: Record<string, unknown>) {
    return this.persistInstance(userId, machineKey, data);
  }
  public getLog() { return this.log; }

  // Stub abstract methods
  async discoverInstance(): Promise<GpuInstance | null> { return null; }
  async createInstance(): Promise<GpuInstance> { return { instanceId: 'test-1', endpoint: 'http://test', status: 'running' }; }
  async startInstance(): Promise<void> {}
  async stopInstance(): Promise<void> {}
  async deleteInstance(): Promise<void> {}
  async getInstanceStatus(): Promise<string | null> { return 'running'; }
  async listInstances(): Promise<GpuInstance[]> { return []; }
  async resolveInstanceEndpoint(): Promise<string | null> { return null; }
}

describe('AbstractGpuProvider', () => {
  describe('TIMEOUTS', () => {
    it('has expected default values', () => {
      expect(TIMEOUTS.read).toBe(10_000);
      expect(TIMEOUTS.write).toBe(15_000);
      expect(TIMEOUTS.create).toBe(30_000);
      expect(TIMEOUTS.deploy).toBe(180_000);
    });
  });

  describe('errMsg', () => {
    it('extracts message from Error', () => {
      const provider = new TestProvider();
      expect(provider.testErrMsg(new Error('boom'))).toBe('boom');
    });

    it('converts non-Error to string', () => {
      const provider = new TestProvider();
      expect(provider.testErrMsg(42)).toBe('42');
      expect(provider.testErrMsg(null)).toBe('null');
      expect(provider.testErrMsg('str')).toBe('str');
    });
  });

  describe('jsonHeaders', () => {
    it('builds standard headers with Bearer auth', () => {
      const provider = new TestProvider();
      const headers = provider.testJsonHeaders('my-key-123');
      expect(headers).toEqual({
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': 'Bearer my-key-123',
      });
    });
  });

  describe('logger', () => {
    it('defaults to defaultLogger', () => {
      const provider = new TestProvider();
      const log = provider.getLog();
      expect(log.log).toBeDefined();
      expect(log.warn).toBeDefined();
      expect(log.error).toBeDefined();
    });

    it('uses custom logger from options', () => {
      const custom = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const provider = new TestProvider({ logger: custom });
      expect(provider.getLog()).toBe(custom);
    });
  });

  describe('persistInstance', () => {
    it('calls onInstancePersist when userId and callback are provided', async () => {
      const persist = vi.fn().mockResolvedValue(undefined);
      const provider = new TestProvider({ onInstancePersist: persist });

      await provider.testPersistInstance('user-1', 'runpodPod', { podId: 'x' });

      expect(persist).toHaveBeenCalledWith('user-1', 'runpodPod', { podId: 'x' });
    });

    it('does nothing when userId is undefined', async () => {
      const persist = vi.fn().mockResolvedValue(undefined);
      const provider = new TestProvider({ onInstancePersist: persist });

      await provider.testPersistInstance(undefined, 'runpodPod', { podId: 'x' });

      expect(persist).not.toHaveBeenCalled();
    });

    it('does nothing when no callback is provided', async () => {
      const provider = new TestProvider();
      // Should not throw
      await provider.testPersistInstance('user-1', 'runpodPod', { podId: 'x' });
    });

    it('logs error when callback fails', async () => {
      const logError = vi.fn();
      const persist = vi.fn().mockRejectedValue(new Error('db down'));
      const provider = new TestProvider({
        onInstancePersist: persist,
        logger: { log: vi.fn(), warn: vi.fn(), error: logError },
      });

      await provider.testPersistInstance('user-1', 'runpodPod', { podId: 'x' });

      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to persist instance for user user-1'),
      );
    });
  });

  describe('FetchError', () => {
    it('carries status and body', () => {
      const err = new FetchError('Not found', 404, '{"error":"not found"}');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('FetchError');
      expect(err.message).toBe('Not found');
      expect(err.status).toBe(404);
      expect(err.body).toBe('{"error":"not found"}');
    });
  });

  describe('fetchRaw', () => {
    it('passes through fetch calls', async () => {
      const provider = new TestProvider();
      const mockResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

      const res = await provider.testFetchRaw('https://example.com/api', {
        method: 'GET',
        headers: { Authorization: 'Bearer key' },
      });

      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledWith('https://example.com/api', expect.objectContaining({
        method: 'GET',
      }));

      fetchSpy.mockRestore();
    });
  });

  describe('fetchJson', () => {
    it('parses JSON on success', async () => {
      const provider = new TestProvider();
      const mockResponse = new Response(JSON.stringify({ data: 'hello' }), { status: 200 });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

      const result = await provider.testFetchJson<{ data: string }>('https://example.com/api');
      expect(result.data).toBe('hello');

      fetchSpy.mockRestore();
    });

    it('throws FetchError on non-ok response', async () => {
      const provider = new TestProvider();
      const mockResponse = new Response('bad request', { status: 400 });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

      await expect(provider.testFetchJson('https://example.com/api', undefined, undefined, 'test-label'))
        .rejects.toThrow(FetchError);

      try {
        await provider.testFetchJson('https://example.com/api', undefined, undefined, 'test-label');
      } catch (err) {
        expect(err).toBeInstanceOf(FetchError);
        expect((err as FetchError).status).toBe(400);
      }

      fetchSpy.mockRestore();
    });
  });
});
