import { describe, expect, it } from 'bun:test';
import { WarmPool, pickNextWorker, markInterruptedWorkersLost, DEFAULT_CONFIG, type Transport, type WarmWorker, type WarmPoolState } from './gpu-warmpool';

function worker(over: Partial<WarmWorker>): WarmWorker {
  return { slot: over.slot || 'warmpool-x', state: 'stopped', model: 'qwen2.5:7b', createdAt: 1000, ...over };
}

function poolState(workers: WarmWorker[]): WarmPoolState {
  return { config: DEFAULT_CONFIG, workers, provisioning: false, updatedAt: 0 };
}

describe('pickNextWorker', () => {
  it('prefers the worker with the fastest known acquire', () => {
    const w = [
      worker({ slot: 'a', lastAcquireMs: 30_000 }),
      worker({ slot: 'b', lastAcquireMs: 11_000 }),
      worker({ slot: 'c' }),
    ];
    expect(pickNextWorker(w)?.slot).toBe('b');
  });

  it('falls back to oldest when no acquire history', () => {
    const w = [worker({ slot: 'a', createdAt: 2000 }), worker({ slot: 'b', createdAt: 1000 })];
    expect(pickNextWorker(w)?.slot).toBe('b');
  });

  it('ignores non-stopped workers', () => {
    const w = [
      worker({ slot: 'a', state: 'lost' }),
      worker({ slot: 'b', state: 'active' }),
      worker({ slot: 'c', state: 'terminated' }),
    ];
    expect(pickNextWorker(w)).toBeUndefined();
  });
});

describe('WarmPool.acquire failover', () => {
  it('fails over to the next worker when resume hangs, marking the first lost', async () => {
    const calls: string[] = [];
    const transport: Transport = async (method, path, body, opts) => {
      const slot = (body as Record<string, unknown> | undefined)?.parallelSlot as string | undefined;
      calls.push(`${method} ${path}${slot ? ` ${slot}` : ''}${opts?.base ? ' [instance]' : ''}`);
      if (path === '/v1/gpu/resume' && slot === 'w1') return { status: 502, json: { error: 'Resume failed: stuck in scheduling' } };
      if (path === '/v1/gpu/resume' && slot === 'w2') return { status: 200, json: { ok: true, durationMs: 7000 } };
      if (path === '/api/generate') return { status: 200, json: { response: 'ok' } };
      return { status: 200, json: {} };
    };
    const state = poolState([
      worker({ slot: 'w1', lastAcquireMs: 10_000, endpoint: 'http://h1:8000' }),
      worker({ slot: 'w2', lastAcquireMs: 20_000, endpoint: 'http://h2:8000' }),
    ]);
    const pool = new WarmPool(transport, state);
    const r = await pool.acquire();
    expect(r.worker.slot).toBe('w2');
    expect(state.workers.find((w) => w.slot === 'w1')?.state).toBe('lost');
    expect(state.workers.find((w) => w.slot === 'w2')?.state).toBe('active');
    expect(calls).toContain('POST /v1/gpu/resume w1');
    expect(calls).toContain('POST /v1/gpu/resume w2');
  });

  it('throws when every worker fails, listing what it tried', async () => {
    const transport: Transport = async (_m, path) => {
      if (path === '/v1/gpu/resume') return { status: 502, json: { error: 'gone' } };
      return { status: 200, json: {} };
    };
    const pool = new WarmPool(transport, poolState([
      worker({ slot: 'w1', endpoint: 'http://h1:8000' }),
      worker({ slot: 'w2', endpoint: 'http://h2:8000' }),
    ]));
    await expect(pool.acquire()).rejects.toThrow(/w1, w2/);
  });

  it('returns the already-active worker without resuming anything', async () => {
    const calls: string[] = [];
    const transport: Transport = async (method, path) => {
      calls.push(`${method} ${path}`);
      return { status: 200, json: {} };
    };
    const pool = new WarmPool(transport, poolState([worker({ slot: 'w1', state: 'active', endpoint: 'http://h1:8000' })]));
    const r = await pool.acquire();
    expect(r.worker.slot).toBe('w1');
    expect(r.acquireMs).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('verifies with a real inference, not just resume 200 (ollama#15016)', async () => {
    let generates = 0;
    const transport: Transport = async (_m, path) => {
      if (path === '/v1/gpu/resume') return { status: 200, json: { ok: true } };
      if (path === '/api/generate') {
        generates++;
        return generates < 2 ? { status: 503, json: {} } : { status: 200, json: { response: 'ok' } };
      }
      return { status: 200, json: {} };
    };
    const pool = new WarmPool(transport, poolState([worker({ slot: 'w1', endpoint: 'http://h1:8000' })]));
    const r = await pool.acquire();
    expect(r.worker.state).toBe('active');
    expect(generates).toBe(2);
  });
});

describe('WarmPool.release / teardown', () => {
  it('release stops the active worker back into the pool', async () => {
    const transport: Transport = async () => ({ status: 200, json: { ok: true } });
    const state = poolState([worker({ slot: 'w1', state: 'active' })]);
    const pool = new WarmPool(transport, state);
    const w = await pool.release();
    expect(w.state).toBe('stopped');
  });

  it('teardown terminates all non-terminated workers', async () => {
    const terminated: string[] = [];
    const transport: Transport = async (_m, path, body) => {
      if (path === '/v1/gpu/terminate') terminated.push((body as Record<string, unknown>).parallelSlot as string);
      return { status: 200, json: { ok: true } };
    };
    const state = poolState([
      worker({ slot: 'w1', state: 'stopped' }),
      worker({ slot: 'w2', state: 'lost' }),
      worker({ slot: 'w3', state: 'terminated' }),
    ]);
    const pool = new WarmPool(transport, state);
    const r = await pool.teardown();
    expect(terminated.sort()).toEqual(['w1', 'w2']);
    expect(r.terminated.sort()).toEqual(['w1', 'w2']);
    expect(state.workers.every((w) => w.state === 'terminated')).toBe(true);
  });
});

describe('WarmPool.acquire concurrency', () => {
  it('serializes concurrent acquires into one active worker (second returns it)', async () => {
    let resumeCalls = 0;
    let openGate: () => void = () => {};
    const gate = new Promise<void>((r) => { openGate = r; });
    const transport: Transport = async (_m, path) => {
      if (path === '/v1/gpu/resume') { resumeCalls++; await gate; return { status: 200, json: { ok: true } }; }
      if (path === '/api/generate') return { status: 200, json: { response: 'ok' } };
      return { status: 200, json: {} };
    };
    const state = poolState([
      worker({ slot: 'w1', lastAcquireMs: 10_000, endpoint: 'http://h1:8000' }),
      worker({ slot: 'w2', lastAcquireMs: 20_000, endpoint: 'http://h2:8000' }),
    ]);
    const pool = new WarmPool(transport, state);
    const p1 = pool.acquire();
    const p2 = pool.acquire();
    openGate();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.worker.slot).toBe(r2.worker.slot);
    expect(resumeCalls).toBe(1);
    expect(state.workers.filter((w) => w.state === 'active')).toHaveLength(1);
  });
});

describe('markInterruptedWorkersLost', () => {
  it('demotes interrupted transient workers to lost, leaves stable states', () => {
    const workers = [
      worker({ slot: 'a', state: 'provisioning' }),
      worker({ slot: 'b', state: 'resuming' }),
      worker({ slot: 'c', state: 'stopped' }),
      worker({ slot: 'd', state: 'active' }),
      worker({ slot: 'e', state: 'terminated' }),
    ];
    markInterruptedWorkersLost(workers);
    const byState = Object.fromEntries(workers.map((w) => [w.slot, w.state]));
    expect(byState).toEqual({ a: 'lost', b: 'lost', c: 'stopped', d: 'active', e: 'terminated' });
  });

  it('frees the alive-count so a stranded provisioning worker no longer blocks refill', () => {
    const workers = [worker({ slot: 'a', state: 'provisioning' })];
    markInterruptedWorkersLost(workers);
    expect(workers.filter((w) => w.state !== 'terminated' && w.state !== 'lost')).toHaveLength(0);
  });
});

describe('WarmPool teardown vs in-flight provision', () => {
  it('aborts provision when teardown bumps the generation (no resurrected workers)', async () => {
    let deploys = 0;
    let tornDown = false;
    let pool: WarmPool;
    const transport: Transport = async (_m, path) => {
      if (path === '/v1/gpu/deploy') {
        deploys++;
        if (!tornDown) { tornDown = true; await pool.teardown(); }
        return { status: 202, json: { deployId: `d${deploys}` } };
      }
      if (path.startsWith('/v1/gpu/status')) return { status: 200, json: { status: 'ready', podId: 'p', endpoint: 'http://h:8000', costPerHr: 0.1 } };
      if (path === '/api/tags') return { status: 200, json: { models: [{ name: 'qwen2.5:7b' }] } };
      if (path === '/api/generate') return { status: 200, json: { response: 'ok' } };
      return { status: 200, json: {} };
    };
    const state = poolState([]);
    pool = new WarmPool(transport, state);
    await pool.provision({ ...DEFAULT_CONFIG, size: 2 });
    expect(deploys).toBe(1);
    expect(state.workers).toHaveLength(1);
    expect(state.workers[0].state).toBe('terminated');
  });
});
