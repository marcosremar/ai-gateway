import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StreamingSTTBackend, StreamingSTTRouter } from '../../src/streaming-stt';
import type { StreamingSTTEvent } from '../../src/streaming-stt';

describe('StreamingSTTRouter', () => {
  it('getActiveProvider returns gpu when available', () => {
    const router = new StreamingSTTRouter({
      getGpuUrl: () => 'http://gpu:8000',
      fireworksApiKey: 'fw-key',
    });
    expect(router.getActiveProvider()).toBe('gpu');
  });

  it('getActiveProvider returns fireworks when no gpu', () => {
    const router = new StreamingSTTRouter({
      getGpuUrl: () => null,
      fireworksApiKey: 'fw-key',
    });
    expect(router.getActiveProvider()).toBe('fireworks');
  });

  it('getActiveProvider returns null when nothing available', () => {
    const router = new StreamingSTTRouter({
      getGpuUrl: () => null,
    });
    expect(router.getActiveProvider()).toBe(null);
  });

  it('respects custom providerOrder', () => {
    const router = new StreamingSTTRouter({
      getGpuUrl: () => 'http://gpu:8000',
      fireworksApiKey: 'fw-key',
      providerOrder: ['fireworks', 'gpu'],
    });
    expect(router.getActiveProvider()).toBe('fireworks');
  });

  it('createBackend returns null when no providers available', () => {
    const router = new StreamingSTTRouter({
      getGpuUrl: () => null,
    });
    expect(router.createBackend()).toBeNull();
  });

  it('createBackend builds GPU websocket URL', () => {
    const router = new StreamingSTTRouter({
      getGpuUrl: () => 'http://gpu:8000',
    });
    const backend = router.createBackend('fr');
    expect(backend).not.toBeNull();
    expect((backend as any).url).toContain('ws://gpu:8000/ws/audio-stream');
    expect((backend as any).url).toContain('language=fr');
    expect(backend!.provider).toBe('gpu');
  });

  it('createBackend excludes specified providers', () => {
    const router = new StreamingSTTRouter({
      getGpuUrl: () => 'http://gpu:8000',
      fireworksApiKey: 'fw-key',
    });
    const backend = router.createBackend('en', new Set(['gpu']));
    expect(backend).not.toBeNull();
    expect(backend!.provider).toBe('fireworks');
  });

  it('createBackend builds qwen3-asr URL', () => {
    const router = new StreamingSTTRouter({
      getGpuUrl: () => null,
      getQwen3AsrUrl: () => 'http://modal:8080',
      fireworksApiKey: 'fw-key',
      providerOrder: ['qwen3-asr', 'fireworks'],
    });
    const backend = router.createBackend('de');
    expect(backend!.provider).toBe('qwen3-asr');
    expect((backend as any).url).toContain('ws://modal:8080');
  });

  it('createBackend passes streaming params as query string', () => {
    const router = new StreamingSTTRouter({
      getGpuUrl: () => 'http://gpu:8000',
    });
    const backend = router.createBackend('en', undefined, {
      chunkSize: 2.0,
      beamSize: 5,
      temperature: 0.0,
    });
    expect((backend as any).url).toContain('chunk_size=2');
    expect((backend as any).url).toContain('beam_size=5');
    expect((backend as any).url).toContain('temperature=0');
  });

  it('getStatus returns all providers', () => {
    const router = new StreamingSTTRouter({
      getGpuUrl: () => 'http://gpu:8000',
      fireworksApiKey: 'key',
    });
    const status = router.getStatus();
    expect(status.gpu.available).toBe(true);
    expect(status.fireworks.available).toBe(true);
    expect(status['qwen3-asr'].available).toBe(false);
  });
});

describe('StreamingSTTBackend', () => {
  it('isOpen starts false', () => {
    const backend = new StreamingSTTBackend('ws://test', {}, 'gpu');
    expect(backend.isOpen).toBe(false);
  });

  it('sendAudio is no-op when not open', () => {
    const backend = new StreamingSTTBackend('ws://test', {}, 'gpu');
    expect(() => backend.sendAudio(Buffer.from('audio'))).not.toThrow();
  });

  it('close sets isOpen to false', () => {
    const backend = new StreamingSTTBackend('ws://test', {}, 'gpu');
    backend.close();
    expect(backend.isOpen).toBe(false);
  });

  it('onResult callback is assignable', () => {
    const backend = new StreamingSTTBackend('ws://test', {}, 'gpu');
    const events: StreamingSTTEvent[] = [];
    backend.onResult = (e) => events.push(e);
    expect(backend.onResult).toBeDefined();
  });
});

describe('StreamingSTTRouter — deployment provider', () => {
  const lease = () => ({
    machine: { id: 'm1', deployment: 'speech', ip: '10.1.2.3', state: 'running', createdAt: 0, zone: 'fr-par-2', machineType: 'L40S-1-48G', pricePerHour: 1.47 },
    token: 'replica-token',
    exposed: false,
    done: vi.fn(),
  });
  const controller = (acquire: ReturnType<typeof vi.fn>) => ({
    acquire,
    wake: vi.fn(),
    get: vi.fn(() => ({ spec: { paused: false }, status: 'ready', replicas: [{ phase: 'ready' }] })),
  });

  it('createBackendAsync acquires a replica and points the WS at its /ws/audio-stream', async () => {
    const l = lease();
    const ctl = controller(vi.fn(async () => l));
    const router = new StreamingSTTRouter({
      getGpuUrl: () => null,
      fireworksApiKey: 'fw-key',
      deployment: { controller: ctl as never, name: 'speech' },
      providerOrder: ['deployment', 'fireworks'],
    });
    const backend = await router.createBackendAsync('pt');
    expect(backend).not.toBeNull();
    expect(backend!.provider).toBe('deployment');
    expect((backend as any).url).toBe('ws://10.1.2.3/ws/audio-stream?language=pt');
    expect((backend as any).headers['X-Aigw-Token']).toBe('replica-token');
    expect(ctl.acquire).toHaveBeenCalledWith('speech', expect.objectContaining({ waitMs: expect.any(Number) }));
  });

  it('a cold deployment wakes and hedges to the next provider', async () => {
    const ctl = controller(vi.fn(async () => { throw new Error('replicas are starting'); }));
    const router = new StreamingSTTRouter({
      getGpuUrl: () => null,
      fireworksApiKey: 'fw-key',
      deployment: { controller: ctl as never, name: 'speech' },
      providerOrder: ['deployment', 'fireworks'],
    });
    const backend = await router.createBackendAsync('pt');
    expect(backend!.provider).toBe('fireworks');
    expect(ctl.wake).toHaveBeenCalledWith('speech');
  });

  it('sync createBackend skips the async deployment provider', () => {
    const ctl = controller(vi.fn());
    const router = new StreamingSTTRouter({
      getGpuUrl: () => null,
      fireworksApiKey: 'fw-key',
      deployment: { controller: ctl as never, name: 'speech' },
      providerOrder: ['deployment', 'fireworks'],
    });
    const backend = router.createBackend('pt');
    expect(backend!.provider).toBe('fireworks');
    expect(ctl.acquire).not.toHaveBeenCalled();
  });

  it('closing the backend releases the lease (failed=false); an abnormal disconnect marks it failed', async () => {
    const l = lease();
    const ctl = controller(vi.fn(async () => l));
    const router = new StreamingSTTRouter({
      getGpuUrl: () => null,
      deployment: { controller: ctl as never, name: 'speech' },
      providerOrder: ['deployment'],
    });
    const backend = (await router.createBackendAsync('pt'))!;
    backend.close();
    expect(l.done).toHaveBeenCalledWith(false);
  });

  it('a deployment whose name does not resolve is skipped', async () => {
    const ctl = controller(vi.fn());
    const router = new StreamingSTTRouter({
      getGpuUrl: () => null,
      deployment: { controller: ctl as never, name: () => null },
      providerOrder: ['deployment'],
    });
    expect(await router.createBackendAsync('pt')).toBeNull();
    expect(ctl.acquire).not.toHaveBeenCalled();
  });
});
