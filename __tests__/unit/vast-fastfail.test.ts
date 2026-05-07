/**
 * Unit tests for the Vast fast-fail probes added in fc-vast-fastfail.
 *
 * Two new helpers live on `VastClient`:
 *
 *   - `_probeTcp(host, port, timeoutMs)`        — TCP-only SSH probe.
 *   - `_probeContainerLogs(host, port, opts)`   — SSH-tail of /tmp/container.log
 *                                                 grepped for known error
 *                                                 patterns (Traceback,
 *                                                 OCI/CDI, CUDA, OOM, etc.).
 *
 * The probes are private. Tests reach in via `(client as any)._probe…` to
 * avoid widening the public API surface but keep the contract under
 * regression coverage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, Server } from 'net';

// vi.mock must run before the SUT imports child_process. The factory
// creates a stateful spawn implementation that test cases reconfigure.
let _spawnFactory: (...args: any[]) => any = () => {
  throw new Error('spawn factory not configured');
};

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (...args: any[]) => _spawnFactory(...args),
  };
});

vi.mock('../../src/logger', () => {
  const noop = () => ({ debug: vi.fn(), log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  return {
    createLogger: noop,
    defaultLogger: noop(),
  };
});

function makeFakeProc(stdoutChunks: string[], exitCode = 0) {
  const handlers: Record<string, Array<(...a: any[]) => void>> = {};
  const proc: any = {
    stdout: {
      on: (event: string, fn: (...a: any[]) => void) => {
        (handlers[event] ||= []).push(fn);
      },
    },
    on: (event: string, fn: (...a: any[]) => void) => {
      (handlers[event] ||= []).push(fn);
    },
    kill: vi.fn(),
  };
  setImmediate(() => {
    for (const c of stdoutChunks) handlers.data?.forEach((h) => h(Buffer.from(c)));
    handlers.close?.forEach((h) => h(exitCode));
  });
  return proc;
}

import { VastClient } from '../../src/gateway/providers/gpu/vast-client';

// ── Tiny TCP listener so the probe can hit a real socket ──────────────────
function startListener(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((sock) => sock.destroy());
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

describe('VastClient._probeTcp (unit)', () => {
  let client: VastClient;
  beforeEach(() => { client = new VastClient(); });

  it('returns true when something accepts the SYN', async () => {
    const { server, port } = await startListener();
    try {
      const ok = await (client as any)._probeTcp('127.0.0.1', port, 1_000);
      expect(ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it('returns false when nothing is listening (connection refused)', async () => {
    // Pick a port that's almost certainly unused; the probe should not
    // throw, just resolve false within the timeout.
    const ok = await (client as any)._probeTcp('127.0.0.1', 1, 1_000);
    expect(ok).toBe(false);
  });

  it('returns false when the dial blackholes (timeout)', async () => {
    // 198.51.100.0/24 is RFC 5737 TEST-NET-2 — packets disappear.
    const t0 = Date.now();
    const ok = await (client as any)._probeTcp('198.51.100.1', 22, 600);
    const elapsed = Date.now() - t0;
    expect(ok).toBe(false);
    // Resolves close to the timeout — a hard cap on how slow the probe is.
    expect(elapsed).toBeLessThan(2_500);
  });
});

describe('VastClient._probeContainerLogs (unit)', () => {
  let client: VastClient;

  beforeEach(() => {
    client = new VastClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the matched line when SSH stdout shows a known error pattern', async () => {
    const fakeStdout = 'boot ok\nTraceback (most recent call last)\n  File "x", line 1\n';

    // Stub child_process.spawn so the probe doesn't actually shell out.
    _spawnFactory = () => makeFakeProc([fakeStdout]);

    const result = await (client as any)._probeContainerLogs('host.example', 22, { timeoutMs: 1_000 });
    expect(result).toMatch(/Traceback/);
  });

  it('returns null when the log is clean', async () => {
    const fakeStdout = 'boot ok\nServer started on 0.0.0.0:8000\n';
    const cp = await import('child_process');
    vi.spyOn(cp, 'spawn').mockImplementation(((..._args: any[]) => {
      const handlers: Record<string, Array<(...a: any[]) => void>> = {};
      const proc: any = {
        stdout: {
          on: (event: string, fn: (...a: any[]) => void) => {
            (handlers[event] ||= []).push(fn);
          },
        },
        on: (event: string, fn: (...a: any[]) => void) => {
          (handlers[event] ||= []).push(fn);
        },
        kill: vi.fn(),
      };
      setImmediate(() => {
        handlers.data?.forEach((h) => h(Buffer.from(fakeStdout)));
        handlers.close?.forEach((h) => h(0));
      });
      return proc;
    }) as any);

    const result = await (client as any)._probeContainerLogs('host.example', 22, { timeoutMs: 1_000 });
    expect(result).toBeNull();
  });

  it('returns null when SSH stdout is empty', async () => {
    _spawnFactory = () => makeFakeProc([], 1);
    const result = await (client as any)._probeContainerLogs('host.example', 22, { timeoutMs: 1_000 });
    expect(result).toBeNull();
  });

  it('detects CDI device injection failure (Vast residential pattern)', async () => {
    const fakeStdout =
      'Error response from daemon: failed to create task for container: ' +
      'failed to create shim task: OCI runtime create failed: could not apply ' +
      'required modification to OCI specification: error modifying OCI spec: ' +
      'failed to inject CDI devices: unresolvable CDI devices D.aaa\n';
    const cp = await import('child_process');
    vi.spyOn(cp, 'spawn').mockImplementation(((..._args: any[]) => {
      const handlers: Record<string, Array<(...a: any[]) => void>> = {};
      const proc: any = {
        stdout: {
          on: (event: string, fn: (...a: any[]) => void) => {
            (handlers[event] ||= []).push(fn);
          },
        },
        on: (event: string, fn: (...a: any[]) => void) => {
          (handlers[event] ||= []).push(fn);
        },
        kill: vi.fn(),
      };
      setImmediate(() => {
        handlers.data?.forEach((h) => h(Buffer.from(fakeStdout)));
        handlers.close?.forEach((h) => h(0));
      });
      return proc;
    }) as any);

    const result = await (client as any)._probeContainerLogs('host.example', 22, { timeoutMs: 1_000 });
    expect(result).toMatch(/CDI devices|Error response from daemon/);
  });
});
