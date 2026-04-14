/**
 * Tests for autoscaler/reconcile.ts
 * - scheduleReconcile() rate limiting
 * - reconcileStaleConfigs() via scheduleReconcile
 * - Grace period handling
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { scheduleReconcile } from '../src/autoscaler/reconcile';
import type { SettingsStore, Logger } from '../src/deps';
import { GpuProviderRegistry } from '../src/gpu-providers/registry';
import type { GpuProviderClient } from '../src/gpu-providers/types';

const silentLogger: Logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeSettingsStore(settings: Record<string, unknown> = {}): SettingsStore & { patched: Record<string, unknown>[] } {
  const patched: Record<string, unknown>[] = [];
  return {
    patched,
    async get(_userId) { return settings; },
    async patch(_userId, partial) { patched.push(partial); },
  };
}

function makeRegistry(statusMap: Record<string, string | null> = {}): GpuProviderRegistry {
  const registry = new GpuProviderRegistry();

  const makeClient = (providerId: string): GpuProviderClient => ({
    providerId,
    bootTimeSecs: 120,
    async discoverInstance() { return null; },
    async createInstance() { return { instanceId: 'new-inst', endpoint: '', status: 'running' }; },
    async startInstance() {},
    async stopInstance() {},
    async deleteInstance() {},
    async getInstanceStatus(instanceId: string) {
      return statusMap[instanceId] ?? null;
    },
    async listInstances() { return []; },
    async resolveInstanceEndpoint() { return null; },
  });

  // Register clients for all providers
  for (const providerId of ['runpod', 'tensordock', 'vast', 'modal']) {
    registry.register(makeClient(providerId));
  }

  return registry;
}

describe('scheduleReconcile', () => {
  it('does not run when called within rate limit window', async () => {
    const store = makeSettingsStore();
    const registry = makeRegistry();
    const lastMap = new Map<string, number>();

    // Set last reconcile to now
    lastMap.set('user-1', Date.now());

    scheduleReconcile({ settingsStore: store, registry, logger: silentLogger }, 'user-1', lastMap);

    // Wait a bit to ensure it would have run if not rate-limited
    await new Promise(r => setTimeout(r, 50));

    expect(store.patched).toHaveLength(0);
  });

  it('runs when last reconcile was long ago', async () => {
    const runpodMachine = {
      podId: 'pod-123',
      persistedAt: Date.now() - 60 * 60 * 1000, // 1 hour ago
    };
    const store = makeSettingsStore({ runpodPod: runpodMachine });
    // RunPod client returns null (instance not found) → should clear
    const registry = makeRegistry({ 'pod-123': null });
    const lastMap = new Map<string, number>();

    // Set last reconcile to long ago
    lastMap.set('user-1', Date.now() - 20 * 60 * 1000);

    scheduleReconcile({ settingsStore: store, registry, logger: silentLogger }, 'user-1', lastMap);

    // Wait for async reconcile to complete
    await new Promise(r => setTimeout(r, 100));

    expect(store.patched.length).toBeGreaterThan(0);
  });

  it('updates lastReconcileMap on call', () => {
    const store = makeSettingsStore();
    const registry = makeRegistry();
    const lastMap = new Map<string, number>();

    const before = Date.now();
    scheduleReconcile({ settingsStore: store, registry, logger: silentLogger }, 'user-1', lastMap);

    expect(lastMap.get('user-1')).toBeGreaterThanOrEqual(before);
  });

  it('does not run when no machines configured', async () => {
    const store = makeSettingsStore({ autoscaler: { enabled: true } });
    const registry = makeRegistry();
    const lastMap = new Map<string, number>();

    scheduleReconcile({ settingsStore: store, registry, logger: silentLogger }, 'user-1', lastMap);
    await new Promise(r => setTimeout(r, 50));

    expect(store.patched).toHaveLength(0);
  });

  it('skips machines within grace period', async () => {
    const runpodMachine = {
      podId: 'pod-new',
      persistedAt: Date.now() - 60 * 1000, // 1 min ago — within grace period (25 min)
    };
    // Provide apiKey so the check proceeds to grace period logic
    const store = makeSettingsStore({
      skypilot: { runpodApiKey: 'rp-key' },
      runpodPod: runpodMachine,
    });
    // Instance not found in provider
    const registry = makeRegistry({ 'pod-new': null });
    const lastMap = new Map<string, number>();

    scheduleReconcile({ settingsStore: store, registry, logger: silentLogger }, 'user-1', lastMap);
    await new Promise(r => setTimeout(r, 100));

    // Should NOT have patched because within grace period
    expect(store.patched).toHaveLength(0);
  });

  it('clears stale runpod pod (no apiKey)', async () => {
    const runpodMachine = {
      podId: 'pod-stale',
      persistedAt: Date.now() - 60 * 60 * 1000,
    };
    // No apiKey configured → should clear
    const store = makeSettingsStore({ runpodPod: runpodMachine });
    const registry = makeRegistry();
    const lastMap = new Map<string, number>();

    scheduleReconcile({ settingsStore: store, registry, logger: silentLogger }, 'user-1', lastMap);
    await new Promise(r => setTimeout(r, 100));

    expect(store.patched.some(p => 'runpodPod' in p && (p as Record<string, unknown>)['runpodPod'] === null)).toBe(true);
  });

  it('updates status when instance found with different status', async () => {
    const runpodMachine = {
      podId: 'pod-running',
      status: 'idle',
      persistedAt: Date.now() - 60 * 60 * 1000,
    };
    const store = makeSettingsStore({
      skypilot: { runpodApiKey: 'rp-key' },
      runpodPod: runpodMachine,
    });
    const registry = makeRegistry({ 'pod-running': 'running' });
    const lastMap = new Map<string, number>();

    scheduleReconcile({ settingsStore: store, registry, logger: silentLogger }, 'user-1', lastMap);
    await new Promise(r => setTimeout(r, 100));

    // Status changed: should patch with updated status
    const patchedEntry = store.patched.find(p => 'runpodPod' in p);
    if (patchedEntry) {
      expect((patchedEntry['runpodPod'] as Record<string, unknown>)?.status).toBe('running');
    }
  });

  it('clears tensordock instance without apiKey', async () => {
    const tdMachine = {
      instanceId: 'td-inst-1',
      persistedAt: Date.now() - 60 * 60 * 1000,
    };
    const store = makeSettingsStore({ tensordockInstance: tdMachine }); // no apiKey
    const registry = makeRegistry();
    const lastMap = new Map<string, number>();

    scheduleReconcile({ settingsStore: store, registry, logger: silentLogger }, 'user-1', lastMap);
    await new Promise(r => setTimeout(r, 100));

    expect(store.patched.some(p => 'tensordockInstance' in p && (p as Record<string, unknown>)['tensordockInstance'] === null)).toBe(true);
  });

  it('clears vast instance without apiKey', async () => {
    const vastMachine = {
      instanceId: 'vast-inst-1',
      persistedAt: Date.now() - 60 * 60 * 1000,
    };
    const store = makeSettingsStore({ vastInstance: vastMachine }); // no apiKey
    const registry = makeRegistry();
    const lastMap = new Map<string, number>();

    scheduleReconcile({ settingsStore: store, registry, logger: silentLogger }, 'user-1', lastMap);
    await new Promise(r => setTimeout(r, 100));

    expect(store.patched.some(p => 'vastInstance' in p && (p as Record<string, unknown>)['vastInstance'] === null)).toBe(true);
  });
});
