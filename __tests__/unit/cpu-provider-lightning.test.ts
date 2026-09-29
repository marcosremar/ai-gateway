/**
 * Unit tests for src/cpu-providers/lightning-client.ts
 *
 * Covers: loadLightningConfig, LightningAIClient.getStatus, start, stop,
 * waitForRunning, and getSSHCredentials — all without real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LightningAIClient,
  loadLightningConfig,
} from '../../src/cpu-providers/lightning-client';
import type { LightningConfig, StudioStatus } from '../../src/cpu-providers/lightning-client';

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_CFG: LightningConfig = {
  apiKey: 'test-key',
  projectId: 'proj-abc',
  cloudspaceId: 'cs-xyz',
  sshUser: 's_cs-xyz',
  sshHost: 'ssh.lightning.ai',
  sshKeyPath: '/home/user/.ssh/id_ed25519',
};

function makeClient(cfg = BASE_CFG): LightningAIClient {
  return new LightningAIClient(cfg);
}

/** Build a mock fetch response */
function makeResponse(
  ok: boolean,
  body: unknown,
  status = ok ? 200 : 400,
): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Lightning API shape for a running studio */
function runningPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    codeStatus: {
      inUse: {
        phase: 'CLOUD_SPACE_INSTANCE_STATE_RUNNING',
        sshUsername: 's_cs-xyz',
        sshHost: 'ssh.lightning.ai',
        cloudSpaceInstanceId: 'inst-001',
        startTimestamp: '2026-01-01T00:00:00Z',
        ...overrides,
      },
    },
  };
}

/** Lightning API shape for a stopped/no-instance studio */
function stoppedPayload(): Record<string, unknown> {
  return { codeStatus: { inUse: null } };
}

/** Lightning API shape for a pending studio */
function pendingPayload(): Record<string, unknown> {
  return {
    codeStatus: {
      inUse: {
        phase: 'CLOUD_SPACE_INSTANCE_STATE_PENDING',
        cloudSpaceInstanceId: 'inst-002',
      },
    },
  };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.clearAllTimers();
});

// ── loadLightningConfig ───────────────────────────────────────────────────────

describe('loadLightningConfig', () => {
  const REQUIRED = {
    LIGHTNING_API_KEY: 'key1',
    LIGHTNING_PROJECT_ID: 'proj1',
    LIGHTNING_CLOUDSPACE_ID: 'cs1',
    LIGHTNING_SSH_USER: 's_cs1',
  };

  function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  }

  it('returns null when LIGHTNING_API_KEY is missing', () => {
    withEnv({ ...REQUIRED, LIGHTNING_API_KEY: undefined }, () => {
      expect(loadLightningConfig()).toBeNull();
    });
  });

  it('returns null when LIGHTNING_PROJECT_ID is missing', () => {
    withEnv({ ...REQUIRED, LIGHTNING_PROJECT_ID: undefined }, () => {
      expect(loadLightningConfig()).toBeNull();
    });
  });

  it('returns null when LIGHTNING_CLOUDSPACE_ID is missing', () => {
    withEnv({ ...REQUIRED, LIGHTNING_CLOUDSPACE_ID: undefined }, () => {
      expect(loadLightningConfig()).toBeNull();
    });
  });

  it('returns null when LIGHTNING_SSH_USER is missing', () => {
    withEnv({ ...REQUIRED, LIGHTNING_SSH_USER: undefined }, () => {
      expect(loadLightningConfig()).toBeNull();
    });
  });

  it('returns config with all required env vars', () => {
    withEnv(
      {
        ...REQUIRED,
        LIGHTNING_SSH_HOST: undefined,
        LIGHTNING_SSH_KEY: undefined,
        HOME: '/root',
      },
      () => {
        const cfg = loadLightningConfig();
        expect(cfg).not.toBeNull();
        expect(cfg!.apiKey).toBe('key1');
        expect(cfg!.projectId).toBe('proj1');
        expect(cfg!.cloudspaceId).toBe('cs1');
        expect(cfg!.sshUser).toBe('s_cs1');
        expect(cfg!.sshHost).toBe('ssh.lightning.ai');
        expect(cfg!.sshKeyPath).toBe('/root/.ssh/id_ed25519');
      },
    );
  });

  it('uses LIGHTNING_SSH_HOST override when set', () => {
    withEnv({ ...REQUIRED, LIGHTNING_SSH_HOST: 'custom.ssh.host' }, () => {
      const cfg = loadLightningConfig();
      expect(cfg!.sshHost).toBe('custom.ssh.host');
    });
  });

  it('uses LIGHTNING_SSH_KEY override when set', () => {
    withEnv({ ...REQUIRED, LIGHTNING_SSH_KEY: '/custom/id_rsa' }, () => {
      const cfg = loadLightningConfig();
      expect(cfg!.sshKeyPath).toBe('/custom/id_rsa');
    });
  });
});

// ── getStatus ─────────────────────────────────────────────────────────────────

describe('LightningAIClient.getStatus()', () => {
  it('returns RUNNING status from running payload', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(true, runningPayload()));
    const status = await makeClient().getStatus();
    expect(status.phase).toBe('CLOUD_SPACE_INSTANCE_STATE_RUNNING');
    expect(status.sshUser).toBe('s_cs-xyz');
    expect(status.sshHost).toBe('ssh.lightning.ai');
    expect(status.instanceId).toBe('inst-001');
    expect(status.startedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('returns STOPPED when inUse is null', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(true, stoppedPayload()));
    const status = await makeClient().getStatus();
    expect(status.phase).toBe('STOPPED');
  });

  it('returns STOPPED when codeStatus.inUse is undefined', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(true, { codeStatus: {} }));
    const status = await makeClient().getStatus();
    expect(status.phase).toBe('STOPPED');
  });

  it('returns STOPPED when codeStatus itself is missing', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(true, {}));
    const status = await makeClient().getStatus();
    expect(status.phase).toBe('STOPPED');
  });

  it('returns PENDING status from pending payload', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(true, pendingPayload()));
    const status = await makeClient().getStatus();
    expect(status.phase).toBe('CLOUD_SPACE_INSTANCE_STATE_PENDING');
    expect(status.instanceId).toBe('inst-002');
  });

  it('defaults missing phase to STOPPED', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(true, { codeStatus: { inUse: { cloudSpaceInstanceId: 'x' } } }),
    );
    const status = await makeClient().getStatus();
    expect(status.phase).toBe('STOPPED');
  });

  it('throws on non-ok response', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(false, {}, 503));
    await expect(makeClient().getStatus()).rejects.toThrow('Lightning AI API 503');
  });

  it('sends Authorization header with Bearer token', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(true, runningPayload()));
    await makeClient().getStatus();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-key');
  });

  it('calls the correct URL for the cloudspace', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(true, stoppedPayload()));
    await makeClient().getStatus();
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toContain('/projects/proj-abc/cloudspaces/cs-xyz');
  });
});

// ── start ─────────────────────────────────────────────────────────────────────

describe('LightningAIClient.start()', () => {
  it('resolves on 200 OK', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(true, {}));
    await expect(makeClient().start()).resolves.toBeUndefined();
  });

  it('resolves when code=2 (already running)', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(false, { code: 2, message: 'already running' }, 400));
    await expect(makeClient().start()).resolves.toBeUndefined();
  });

  it('throws when non-ok and code != 2', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(false, { code: 5, message: 'quota exceeded' }, 402),
    );
    await expect(makeClient().start()).rejects.toThrow('Failed to start studio: quota exceeded');
  });

  it('throws with status code when message is missing', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(false, { code: 3 }, 500));
    await expect(makeClient().start()).rejects.toThrow('Failed to start studio: 500');
  });

  it('POSTs to the /start endpoint', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(true, {}));
    await makeClient().start();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/start');
    expect(init?.method).toBe('POST');
  });
});

// ── stop ─────────────────────────────────────────────────────────────────────

describe('LightningAIClient.stop()', () => {
  it('resolves immediately when already STOPPED', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(true, stoppedPayload()));
    await expect(makeClient().stop()).resolves.toBeUndefined();
    // Only one fetch call (getStatus), no stop POST
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('POSTs stop when studio is RUNNING', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeResponse(true, runningPayload()))
      .mockResolvedValueOnce(makeResponse(true, {}));
    await expect(makeClient().stop()).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('/stop');
    expect(init?.method).toBe('POST');
  });

  it('POSTs stop when studio is PENDING', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeResponse(true, pendingPayload()))
      .mockResolvedValueOnce(makeResponse(true, {}));
    await expect(makeClient().stop()).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws on stop API error', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeResponse(true, runningPayload()))
      .mockResolvedValueOnce(makeResponse(false, { message: 'internal error' }, 500));
    await expect(makeClient().stop()).rejects.toThrow('Failed to stop studio: internal error');
  });

  it('throws with status when message is missing', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeResponse(true, runningPayload()))
      .mockResolvedValueOnce(makeResponse(false, {}, 503));
    await expect(makeClient().stop()).rejects.toThrow('Failed to stop studio: 503');
  });

  it('throws when getStatus fails', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(false, {}, 401));
    await expect(makeClient().stop()).rejects.toThrow('Lightning AI API 401');
  });
});

// ── waitForRunning ────────────────────────────────────────────────────────────

describe('LightningAIClient.waitForRunning()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when already RUNNING', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(true, runningPayload()));
    const promise = makeClient().waitForRunning();
    await vi.runAllTimersAsync();
    const status = await promise;
    expect(status.phase).toBe('CLOUD_SPACE_INSTANCE_STATE_RUNNING');
  });

  it('polls until RUNNING and resolves', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeResponse(true, pendingPayload()))
      .mockResolvedValueOnce(makeResponse(true, pendingPayload()))
      .mockResolvedValueOnce(makeResponse(true, runningPayload()));

    // Advance timers and await concurrently so the promise settles inside the test
    const [status] = await Promise.all([
      makeClient().waitForRunning(60_000),
      vi.runAllTimersAsync(),
    ]);
    expect((status as StudioStatus).phase).toBe('CLOUD_SPACE_INSTANCE_STATE_RUNNING');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('throws immediately when STOPPED unexpectedly', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeResponse(true, pendingPayload()))
      .mockResolvedValueOnce(makeResponse(true, stoppedPayload()));

    // Drive timers and catch the rejection together
    await expect(
      Promise.all([makeClient().waitForRunning(60_000), vi.runAllTimersAsync()]),
    ).rejects.toThrow('Studio stopped unexpectedly during boot');
  });

  it('throws on timeout', async () => {
    // Always return PENDING so it never reaches RUNNING
    fetchSpy.mockResolvedValue(makeResponse(true, pendingPayload()));

    // Drive timers and catch the rejection together
    await expect(
      Promise.all([makeClient().waitForRunning(5000), vi.advanceTimersByTimeAsync(6000)]),
    ).rejects.toThrow('Studio did not reach RUNNING within 5s');
  });

  it('returns SSH fields from the RUNNING payload', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(
        true,
        runningPayload({ sshUsername: 's_custom', sshHost: 'custom.ssh.ai' }),
      ),
    );
    const [status] = await Promise.all([
      makeClient().waitForRunning(),
      vi.runAllTimersAsync(),
    ]);
    expect((status as StudioStatus).sshUser).toBe('s_custom');
    expect((status as StudioStatus).sshHost).toBe('custom.ssh.ai');
  });
});

// ── getSSHCredentials ─────────────────────────────────────────────────────────

describe('LightningAIClient.getSSHCredentials()', () => {
  it('returns host, user, keyPath from config', () => {
    const creds = makeClient().getSSHCredentials();
    expect(creds).toEqual({
      host: 'ssh.lightning.ai',
      user: 's_cs-xyz',
      keyPath: '/home/user/.ssh/id_ed25519',
    });
  });

  it('reflects a custom key path', () => {
    const client = makeClient({
      ...BASE_CFG,
      sshKeyPath: '/custom/path/key',
      sshHost: 'custom.host',
      sshUser: 's_custom',
    });
    const creds = client.getSSHCredentials();
    expect(creds.keyPath).toBe('/custom/path/key');
    expect(creds.host).toBe('custom.host');
    expect(creds.user).toBe('s_custom');
  });
});
