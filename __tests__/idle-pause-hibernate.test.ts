/**
 * Idle pause — provider-aware dispatch between stop and hibernate.
 *
 * Verifies:
 *   - Hyperstack + allowHibernate=true → client.hibernate() called.
 *   - Hyperstack + allowHibernate=false → client.stopInstance() called.
 *   - Non-hyperstack provider with allowHibernate=true → falls back to
 *     stopInstance (safety: hibernate is hyperstack-only today).
 *   - Client without `hibernate` method → falls back to stopInstance.
 *   - Resume: pausedMode='hibernate' + hyperstack → hibernateRestore().
 *   - Resume: pausedMode='stop' → startInstance().
 *   - Resume: pausedMode='hibernate' on non-hyperstack → startInstance().
 *   - standby-pool-adapter poolTerminate with hibernateOnIdle=true on
 *     hyperstack tier → hibernate() instead of deleteInstance().
 *   - poolTerminate with hibernateOnIdle=false or vast-vm tier →
 *     deleteInstance() (existing destructive behaviour preserved).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GpuProviderClient, ProviderCredentials } from '../src/gpu-providers/types';
import {
  pauseInstanceForIdle,
  resumeInstanceFromIdle,
} from '../src/gateway/providers/gpu/idle-pause';

function makeStubClient(providerId: string, opts: { withHibernate: boolean }) {
  const calls: string[] = [];
  const client: Partial<GpuProviderClient> & {
    hibernate?: (id: string, creds: ProviderCredentials) => Promise<void>;
    hibernateRestore?: (id: string, creds: ProviderCredentials) => Promise<void>;
  } = {
    providerId,
    bootTimeSecs: 60,
    async stopInstance(_id: string, _creds: ProviderCredentials) {
      calls.push('stopInstance');
    },
    async startInstance(_id: string, _creds: ProviderCredentials) {
      calls.push('startInstance');
    },
    async deleteInstance(_id: string, _creds: ProviderCredentials) {
      calls.push('deleteInstance');
    },
    // Other GpuProviderClient methods are irrelevant to this test — we
    // cast through `unknown` when passing to helper functions.
  };
  if (opts.withHibernate) {
    client.hibernate = async () => {
      calls.push('hibernate');
    };
    client.hibernateRestore = async () => {
      calls.push('hibernateRestore');
    };
  }
  return { client: client as unknown as GpuProviderClient, calls };
}

const CREDS: ProviderCredentials = { apiKey: 'k' };

describe('pauseInstanceForIdle', () => {
  it('hyperstack + allowHibernate=true calls hibernate() and returns "hibernate"', async () => {
    const { client, calls } = makeStubClient('hyperstack', { withHibernate: true });
    const mode = await pauseInstanceForIdle('hyperstack', 'vm-1', CREDS, client, {
      allowHibernate: true,
    });
    expect(mode).toBe('hibernate');
    expect(calls).toEqual(['hibernate']);
  });

  it('hyperstack + allowHibernate=false falls back to stopInstance', async () => {
    const { client, calls } = makeStubClient('hyperstack', { withHibernate: true });
    const mode = await pauseInstanceForIdle('hyperstack', 'vm-1', CREDS, client, {
      allowHibernate: false,
    });
    expect(mode).toBe('stop');
    expect(calls).toEqual(['stopInstance']);
  });

  it('non-hyperstack provider + allowHibernate=true still calls stopInstance (safety)', async () => {
    const { client, calls } = makeStubClient('vast', { withHibernate: true });
    const mode = await pauseInstanceForIdle('vast', 'vm-1', CREDS, client, {
      allowHibernate: true,
    });
    expect(mode).toBe('stop');
    expect(calls).toEqual(['stopInstance']);
  });

  it('client missing hibernate method → stopInstance', async () => {
    const { client, calls } = makeStubClient('hyperstack', { withHibernate: false });
    const mode = await pauseInstanceForIdle('hyperstack', 'vm-1', CREDS, client, {
      allowHibernate: true,
    });
    expect(mode).toBe('stop');
    expect(calls).toEqual(['stopInstance']);
  });

  it('default opts (no allowHibernate) preserves legacy stop behaviour', async () => {
    const { client, calls } = makeStubClient('hyperstack', { withHibernate: true });
    const mode = await pauseInstanceForIdle('hyperstack', 'vm-1', CREDS, client);
    expect(mode).toBe('stop');
    expect(calls).toEqual(['stopInstance']);
  });
});

describe('resumeInstanceFromIdle', () => {
  it('pausedMode=hibernate on hyperstack → hibernateRestore()', async () => {
    const { client, calls } = makeStubClient('hyperstack', { withHibernate: true });
    await resumeInstanceFromIdle('hyperstack', 'vm-1', CREDS, client, 'hibernate');
    expect(calls).toEqual(['hibernateRestore']);
  });

  it('pausedMode=stop → startInstance()', async () => {
    const { client, calls } = makeStubClient('hyperstack', { withHibernate: true });
    await resumeInstanceFromIdle('hyperstack', 'vm-1', CREDS, client, 'stop');
    expect(calls).toEqual(['startInstance']);
  });

  it('pausedMode=hibernate on non-hyperstack provider → startInstance() (safety)', async () => {
    const { client, calls } = makeStubClient('vast', { withHibernate: true });
    await resumeInstanceFromIdle('vast', 'vm-1', CREDS, client, 'hibernate');
    expect(calls).toEqual(['startInstance']);
  });

  it('undefined pausedMode → startInstance() (legacy default)', async () => {
    const { client, calls } = makeStubClient('hyperstack', { withHibernate: true });
    await resumeInstanceFromIdle('hyperstack', 'vm-1', CREDS, client, undefined);
    expect(calls).toEqual(['startInstance']);
  });
});

// ── standby-pool-adapter integration ─────────────────────────────────────
// Reuses the same mocking pattern as standby-pool-adapter.test.ts — stub
// both vast-vm and hyperstack clients behind `server/providers`.

const calls: string[] = [];

vi.mock('../src/logger', () => ({
  createLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
}));

const emitted: Array<{ event: string; data: any }> = [];
